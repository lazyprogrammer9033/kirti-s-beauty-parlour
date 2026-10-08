'use strict';

const { requirePerm, HttpError, intParam, str } = require('../lib/http');
const { audit } = require('../lib/audit');
const { nowIso, zonedToUtc, addDays, isValidYmd, isValidHm } = require('../lib/time');
const { redirectUri } = require('./drive');
const { getAppointment, listAppointments, emailCustomer, appointmentEmail, localParts } = require('../lib/appointments');
const { blocksBetween } = require('../lib/customer-links');

const STATUSES = ['booked', 'confirmed', 'completed', 'cancelled', 'no_show'];
const OPEN = ['booked', 'confirmed'];

module.exports = function appointmentRoutes(api, ctx) {
  const view = requirePerm('appointments.view');
  const manage = requirePerm('appointments.manage');

  const withLocal = (a) => (a ? { ...a, ...localParts(a.startAt, ctx.settings.timezone()) } : a);

  // Reads date/time/services from the form and works out start and end.
  function readBooking(db, body, before) {
    const customerId = before ? before.customer_id : intParam(body.customerId, 'customer');
    const customer = db.prepare('SELECT id, status FROM customers WHERE id = ?').get(customerId);
    if (!customer) throw new HttpError(404, 'Customer not found');
    if (!isValidYmd(body.date)) throw new HttpError(400, 'Please choose a date');
    if (!isValidHm(body.time)) throw new HttpError(400, 'Please choose a time');
    const ids = Array.isArray(body.serviceIds) ? [...new Set(body.serviceIds.map((x) => intParam(x, 'service')))] : [];
    if (ids.length > 20) throw new HttpError(400, 'Too many services');
    const services = ids.map((id) => {
      const s = db.prepare('SELECT id, name, duration_minutes FROM services WHERE id = ?').get(id);
      if (!s) throw new HttpError(400, 'Service not found');
      return s;
    });
    let duration = body.durationMinutes == null || body.durationMinutes === '' ? null : Number(body.durationMinutes);
    if (duration == null) duration = services.reduce((sum, s) => sum + (s.duration_minutes || 0), 0) || Number(ctx.settings.get('appt_default_minutes') || 30);
    if (!Number.isInteger(duration) || duration < 5 || duration > 720) throw new HttpError(400, 'Length must be between 5 minutes and 12 hours');
    const start = zonedToUtc(body.date, body.time, ctx.settings.timezone());
    const end = new Date(start.getTime() + duration * 60000);
    const staffUserId = body.staffUserId ? intParam(body.staffUserId, 'staff') : before ? before.staff_user_id : null;
    if (staffUserId && !db.prepare('SELECT 1 FROM users WHERE id = ?').get(staffUserId)) throw new HttpError(400, 'Staff member not found');
    return { customerId, serviceIds: ids, duration, startAt: start.toISOString(), endAt: end.toISOString(), staffUserId, notes: str(body.notes, { max: 1000 }) };
  }

  // Other bookings and blocked times in the way; staff can still book over them.
  function clashes(db, b, ignoreId) {
    return listAppointments(db, `a.status IN ('booked','confirmed') AND a.start_at < ? AND a.end_at > ? AND a.id != ?`, [b.endAt, b.startAt, ignoreId || 0])
      .map((a) => ({ id: a.id, customerName: a.customerName, startAt: a.startAt, endAt: a.endAt }))
      .concat(blocksBetween(db, b.startAt, b.endAt).map((x) => ({ blockId: x.id, customerName: x.reason ? `Blocked (${x.reason})` : 'Blocked time', startAt: x.startAt, endAt: x.endAt })));
  }

  function saveServices(db, id, serviceIds, now) {
    db.prepare('DELETE FROM appointment_services WHERE appointment_id = ?').run(id);
    const ins = db.prepare('INSERT INTO appointment_services (appointment_id, service_id, created_at, updated_at) VALUES (?, ?, ?, ?)');
    for (const sid of serviceIds) ins.run(id, sid, now, now);
  }

  // Copies the change to Google Calendar and emails the customer if asked.
  async function afterChange(id, emailKind) {
    await ctx.calendar.syncAppointment(id);
    const a = getAppointment(ctx.db(), id);
    let emailed = false;
    let emailError = null;
    if (emailKind) {
      try {
        emailed = await emailCustomer(ctx, a, emailKind);
        if (emailed && emailKind === 'confirmation') ctx.db().prepare('UPDATE appointments SET confirmation_sent_at = ? WHERE id = ?').run(nowIso(), id);
      } catch (e) {
        emailError = 'The email could not be sent: ' + e.message;
      }
    }
    return { ...withLocal(getAppointment(ctx.db(), id)), emailed, emailError };
  }

  // ?from=YYYY-MM-DD&to=YYYY-MM-DD (salon days, inclusive) or ?customerId=N
  api.get('/appointments', view, (req, res) => {
    const db = ctx.db();
    const tz = ctx.settings.timezone();
    if (req.query.customerId) {
      return res.json(listAppointments(db, 'a.customer_id = ?', [intParam(req.query.customerId, 'customer')]).map(withLocal).reverse());
    }
    const from = isValidYmd(req.query.from) ? req.query.from : null;
    const to = isValidYmd(req.query.to) ? req.query.to : from;
    if (!from) throw new HttpError(400, 'Please choose a date');
    if (to < from || to > addDays(from, 62)) throw new HttpError(400, 'Please choose up to two months at a time');
    const start = zonedToUtc(from, '00:00', tz).toISOString();
    const end = zonedToUtc(addDays(to, 1), '00:00', tz).toISOString();
    res.json(listAppointments(db, 'a.start_at >= ? AND a.start_at < ?', [start, end]).map(withLocal));
  });

  api.get('/appointments/:id', view, (req, res) => {
    const a = getAppointment(ctx.db(), intParam(req.params.id));
    if (!a) throw new HttpError(404, 'Appointment not found');
    res.json(withLocal(a));
  });

  api.post('/appointments', manage, async (req, res) => {
    const db = ctx.db();
    const b = readBooking(db, req.body);
    const overlap = clashes(db, b);
    if (overlap.length && !req.body.confirmOverlap) {
      throw new HttpError(409, 'Another appointment is booked at this time.', { overlaps: overlap });
    }
    const now = nowIso();
    const id = db.transaction(() => {
      const newId = db.prepare(`INSERT INTO appointments (customer_id, staff_user_id, start_at, end_at, duration_minutes, status, notes, created_by, created_at, updated_at, scheduled_at, sync_status)
        VALUES (?, ?, ?, ?, ?, 'booked', ?, ?, ?, ?, ?, ?)`).run(b.customerId, b.staffUserId, b.startAt, b.endAt, b.duration, b.notes, req.user.id, now, now, now, ctx.calendar.isConnected() ? 'pending' : null).lastInsertRowid;
      saveServices(db, newId, b.serviceIds, now);
      audit(db, req, 'appointment.booked', 'appointment', newId, { startAt: b.startAt });
      return newId;
    })();
    res.status(201).json(await afterChange(id, req.body.notify ? 'confirmation' : null));
  });

  // Reschedule or change services/notes.
  api.put('/appointments/:id', manage, async (req, res) => {
    const db = ctx.db();
    const id = intParam(req.params.id);
    const before = db.prepare('SELECT * FROM appointments WHERE id = ?').get(id);
    if (!before) throw new HttpError(404, 'Appointment not found');
    if (!OPEN.includes(before.status)) throw new HttpError(400, 'Only upcoming appointments can be changed');
    const b = readBooking(db, req.body, before);
    const overlap = clashes(db, b, id);
    if (overlap.length && !req.body.confirmOverlap) throw new HttpError(409, 'Another appointment is booked at this time.', { overlaps: overlap });
    const moved = before.start_at !== b.startAt;
    const now = nowIso();
    db.transaction(() => {
      db.prepare(`UPDATE appointments SET start_at = ?, end_at = ?, duration_minutes = ?, staff_user_id = ?, notes = ?, updated_at = ?,
          reminder_sent_at = CASE WHEN ? THEN NULL ELSE reminder_sent_at END, reminders_sent = CASE WHEN ? THEN NULL ELSE reminders_sent END,
          scheduled_at = CASE WHEN ? THEN ? ELSE scheduled_at END WHERE id = ?`)
        .run(b.startAt, b.endAt, b.duration, b.staffUserId, b.notes, now, moved ? 1 : 0, moved ? 1 : 0, moved ? 1 : 0, now, id);
      saveServices(db, id, b.serviceIds, now);
      audit(db, req, moved ? 'appointment.rescheduled' : 'appointment.updated', 'appointment', id, moved ? { from: before.start_at, to: b.startAt } : {});
    })();
    res.json(await afterChange(id, req.body.notify && moved ? 'updated' : null));
  });

  api.post('/appointments/:id/status', manage, async (req, res) => {
    const db = ctx.db();
    const id = intParam(req.params.id);
    const before = db.prepare('SELECT * FROM appointments WHERE id = ?').get(id);
    if (!before) throw new HttpError(404, 'Appointment not found');
    const status = String(req.body.status || '');
    if (!STATUSES.includes(status)) throw new HttpError(400, 'Invalid status');
    db.prepare('UPDATE appointments SET status = ?, updated_at = ? WHERE id = ?').run(status, nowIso(), id);
    audit(db, req, 'appointment.' + status, 'appointment', id, { from: before.status });
    res.json(await afterChange(id, status === 'cancelled' && req.body.notify && OPEN.includes(before.status) ? 'cancelled' : null));
  });

  api.post('/appointments/:id/email', manage, async (req, res) => {
    const a = getAppointment(ctx.db(), intParam(req.params.id));
    if (!a) throw new HttpError(404, 'Appointment not found');
    if (!a.customerEmail) throw new HttpError(400, 'This customer has no email address');
    if (!ctx.mailer.configured()) throw new HttpError(400, 'Email is not set up yet. The owner can set it up in Settings › Email.');
    try {
      await emailCustomer(ctx, a, a.status === 'cancelled' ? 'cancelled' : 'confirmation');
    } catch (e) {
      if (e.expose) throw e;
      throw new HttpError(502, 'Could not send: ' + e.message);
    }
    res.json({ ok: true });
  });

  // ---------- Blocked times (closed for online booking) ----------
  // ?from=YYYY-MM-DD&to=YYYY-MM-DD, salon days inclusive.
  api.get('/appointment-blocks', view, (req, res) => {
    const tz = ctx.settings.timezone();
    const from = isValidYmd(req.query.from) ? req.query.from : null;
    const to = isValidYmd(req.query.to) ? req.query.to : from;
    if (!from || to < from || to > addDays(from, 400)) throw new HttpError(400, 'Please choose a date range');
    const rows = blocksBetween(ctx.db(), zonedToUtc(from, '00:00', tz).toISOString(), zonedToUtc(addDays(to, 1), '00:00', tz).toISOString());
    res.json(rows.map((x) => ({ ...x, ...blockLocal(x, tz) })));
  });

  // The block's first and last salon day and times, for showing it.
  function blockLocal(x, tz) {
    const s = localParts(x.startAt, tz);
    const e = localParts(x.endAt, tz);
    const allDay = s.time === '00:00' && e.time === '00:00';
    return { fromDate: s.date, fromTime: s.time, toDate: allDay ? addDays(e.date, -1) : e.date, toTime: e.time, allDay };
  }

  // { fromDate, toDate?, allDay } or { fromDate, fromTime, toTime } (one day).
  api.post('/appointment-blocks', manage, (req, res) => {
    const b = req.body || {};
    const tz = ctx.settings.timezone();
    if (!isValidYmd(b.fromDate)) throw new HttpError(400, 'Please choose a date');
    const toDate = b.toDate ? b.toDate : b.fromDate;
    if (!isValidYmd(toDate) || toDate < b.fromDate) throw new HttpError(400, 'The end date must be on or after the start date');
    if (toDate > addDays(b.fromDate, 366)) throw new HttpError(400, 'Please block up to a year at a time');
    let start;
    let end;
    if (b.allDay) {
      start = zonedToUtc(b.fromDate, '00:00', tz);
      end = zonedToUtc(addDays(toDate, 1), '00:00', tz);
    } else {
      if (!isValidHm(b.fromTime) || !isValidHm(b.toTime)) throw new HttpError(400, 'Please choose the times');
      start = zonedToUtc(b.fromDate, b.fromTime, tz);
      end = zonedToUtc(toDate, b.toTime, tz);
      if (end <= start) throw new HttpError(400, 'The end time must be after the start time');
    }
    const reason = str(b.reason, { max: 120 }) || null;
    const db = ctx.db();
    const id = db.prepare('INSERT INTO appointment_blocks (start_at, end_at, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(start.toISOString(), end.toISOString(), reason, req.user.id, nowIso()).lastInsertRowid;
    audit(db, req, 'appointment_block.created', 'appointment_block', id, { startAt: start.toISOString(), endAt: end.toISOString(), reason });
    const row = db.prepare('SELECT id, start_at AS startAt, end_at AS endAt, reason FROM appointment_blocks WHERE id = ?').get(id);
    res.status(201).json({ ...row, ...blockLocal(row, tz) });
  });

  api.delete('/appointment-blocks/:id', manage, (req, res) => {
    const db = ctx.db();
    const id = intParam(req.params.id);
    const row = db.prepare('SELECT * FROM appointment_blocks WHERE id = ?').get(id);
    if (!row) throw new HttpError(404, 'Blocked time not found');
    db.prepare('DELETE FROM appointment_blocks WHERE id = ?').run(id);
    audit(db, req, 'appointment_block.removed', 'appointment_block', id, { startAt: row.start_at, endAt: row.end_at, reason: row.reason });
    res.json({ ok: true });
  });

  // ---------- Google Calendar settings (owner) ----------
  const owner = requirePerm('settings.manage');

  // Sends the owner an example confirmation so she can see what customers get.
  api.post('/appointments/sample-email', owner, async (req, res) => {
    const to = str(req.body.to, { required: true, max: 160, label: 'Email' });
    if (!ctx.mailer.configured()) throw new HttpError(400, 'Email is not set up yet. Set it up in Settings › Email first.');
    const start = new Date(Date.now() + 2 * 86400000);
    start.setUTCMinutes(0, 0, 0);
    const services = ctx.db().prepare('SELECT id, name FROM services WHERE active = 1 ORDER BY sort_order, id LIMIT 2').all();
    const sample = { id: 0, customerName: 'Sample Customer', customerEmail: to, startAt: start.toISOString(), endAt: new Date(start.getTime() + 30 * 60000).toISOString(),
      services: services.length ? services : [{ id: 0, name: 'Eyebrow threading' }], createdAt: nowIso(), updatedAt: nowIso() };
    try {
      await ctx.mailer.send(appointmentEmail(ctx, sample, 'confirmation'));
    } catch (e) {
      throw new HttpError(502, 'Could not send: ' + e.message);
    }
    res.json({ ok: true });
  });

  api.get('/calendar/status', owner, (req, res) => res.json(ctx.calendar.status()));

  api.post('/calendar/connect', owner, (req, res) => {
    const hint = str(req.body.email, { max: 160 }) || ctx.settings.get('calendar_account_email') || ctx.settings.get('business_email') || null;
    res.json({ url: ctx.calendar.beginAuth(req.user.id, redirectUri(ctx, req), hint) });
  });

  api.post('/calendar/disconnect', owner, async (req, res) => {
    await ctx.calendar.disconnect(req.user.id);
    audit(ctx.db(), req, 'calendar.disconnected', 'settings', 'calendar');
    res.json({ ok: true });
  });

  api.get('/calendar/calendars', owner, async (req, res) => {
    res.json(await ctx.calendar.listCalendars());
  });

  api.put('/calendar/calendar', owner, async (req, res) => {
    const id = str(req.body.id, { required: true, max: 300, label: 'Calendar' });
    const out = await ctx.calendar.setCalendar(id, req.user.id);
    audit(ctx.db(), req, 'calendar.changed', 'settings', 'calendar', { calendar: out.name });
    res.json(out);
  });

  api.post('/calendar/sync', owner, async (req, res) => {
    ctx.calendar.markUpcomingPending();
    res.json(await ctx.calendar.syncPending());
  });
};

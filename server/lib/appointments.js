'use strict';

const { nowIso, businessDate, localTime } = require('./time');
const { buildAppointmentEmail } = require('./appointment-email');
const { customerLink } = require('./customer-links');
const { defaultLogo } = require('./brand');

const SELECT = `SELECT a.id, a.customer_id AS customerId, c.full_name AS customerName, c.phone AS customerPhone, c.email AS customerEmail,
    c.customer_code AS customerCode, a.staff_user_id AS staffUserId, u.display_name AS staffName, a.start_at AS startAt, a.end_at AS endAt,
    a.duration_minutes AS durationMinutes, a.status, a.notes, a.reminder_sent_at AS reminderSentAt, a.confirmation_sent_at AS confirmationSentAt,
    a.sync_status AS syncStatus, a.sync_error AS syncError, a.google_event_id IS NOT NULL AS inCalendar, a.created_at AS createdAt, a.updated_at AS updatedAt,
    (SELECT v.id FROM visits v WHERE v.appointment_id = a.id AND v.status = 'completed' ORDER BY v.id DESC LIMIT 1) AS visitId
  FROM appointments a JOIN customers c ON c.id = a.customer_id LEFT JOIN users u ON u.id = a.staff_user_id`;

function attachServices(db, rows) {
  if (!rows.length) return rows;
  const ids = rows.map((r) => r.id);
  const services = db.prepare(`SELECT x.appointment_id AS appointmentId, s.id, s.name, s.price_cents AS priceCents, s.duration_minutes AS durationMinutes
    FROM appointment_services x JOIN services s ON s.id = x.service_id WHERE x.appointment_id IN (${ids.map(() => '?').join(',')}) ORDER BY x.id`).all(...ids);
  for (const r of rows) {
    r.services = services.filter((s) => s.appointmentId === r.id).map(({ appointmentId, ...s }) => s); // eslint-disable-line no-unused-vars
    r.inCalendar = !!r.inCalendar;
  }
  return rows;
}

function getAppointment(db, id) {
  const row = db.prepare(`${SELECT} WHERE a.id = ?`).get(id);
  return row ? attachServices(db, [row])[0] : null;
}

function listAppointments(db, where, args) {
  return attachServices(db, db.prepare(`${SELECT} WHERE ${where} ORDER BY a.start_at, a.id`).all(...args));
}

// The salon's details as shown in customer emails.
function salonInfo(ctx) {
  const s = ctx.settings;
  return {
    name: s.get('business_name') || 'Beauty Parlour',
    email: s.get('business_email') || s.get('smtp_from') || s.get('smtp_user') || '',
    phone: s.get('business_phone') || '',
    address: s.get('business_address') || '',
    logo: s.get('business_logo') || defaultLogo(),
    timezone: s.timezone(),
  };
}

function appointmentEmail(ctx, a, kind) {
  const view = customerLink(ctx, a);
  const links = view ? { view, confirm: customerLink(ctx, a, 'confirm'), change: customerLink(ctx, a, 'change'), cancel: customerLink(ctx, a, 'cancel') } : null;
  return buildAppointmentEmail(a, kind, { ...salonInfo(ctx), links });
}

// Tells the salon when a customer confirms, cancels or moves a booking online.
async function notifySalon(ctx, a, action, extra = {}) {
  const to = ctx.settings.get('business_email');
  if (!to || !ctx.mailer.configured()) return false;
  const tz = ctx.settings.timezone();
  const fmt = (iso) => new Date(iso).toLocaleString('en-CA', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const verbs = { confirmed: 'Confirmed by customer', cancelled: 'Cancelled by customer', rescheduled: 'Moved by customer', booked: 'New online booking' };
  const lines = [
    action === 'booked' ? `${a.customerName} (${a.customerPhone}) booked online.${a.notes ? ' Note: ' + a.notes : ''}` : `${a.customerName} (${a.customerPhone}) ${action} their appointment online.`,
    '',
    action === 'rescheduled' ? `Was: ${fmt(extra.from)}\nNow: ${fmt(a.startAt)}` : `When: ${fmt(a.startAt)}`,
    a.services.length ? `Services: ${a.services.map((x) => x.name).join(', ')}` : null,
    '',
    'The salon app and Google Calendar are already updated.',
  ].filter((l) => l !== null);
  await ctx.mailer.send({ to, subject: `${verbs[action]}: ${a.customerName}, ${fmt(a.startAt)}`, text: lines.join('\n') });
  return true;
}

async function emailCustomer(ctx, a, kind) {
  if (!a.customerEmail || !ctx.mailer.configured()) return false;
  await ctx.mailer.send(appointmentEmail(ctx, a, kind));
  return true;
}

// How long before the appointment each reminder goes out.
const REMINDER_STAGES = { '1w': 7 * 86400000, '1d': 86400000, '2h': 2 * 3600000 };

// Sends reminder emails and retries calendar copies that failed. Runs on a timer.
class AppointmentScheduler {
  constructor(ctx) {
    this.ctx = ctx;
  }

  // Reminder emails go out a week, a day and two hours before (whichever the
  // owner has switched on). A reminder whose window had already started when
  // the booking was made or moved is skipped: the confirmation covered it.
  // If several are due at once (the computer was off), only the latest goes.
  async sendReminders(now = new Date()) {
    const s = this.ctx.settings;
    if (s.get('appt_reminder_email') !== '1' || !this.ctx.mailer.configured()) return 0;
    const on = String(s.get('appt_reminder_stages') ?? '1w,1d,2h').split(',').filter((k) => REMINDER_STAGES[k]);
    if (!on.length) return 0;
    const db = this.ctx.db();
    const widest = Math.max(...on.map((k) => REMINDER_STAGES[k]));
    const due = listAppointments(db, `a.status IN ('booked','confirmed') AND c.email IS NOT NULL AND c.email != ''
      AND a.start_at > ? AND a.start_at <= ?`, [now.toISOString(), new Date(now.getTime() + widest).toISOString()]);
    const t = now.getTime();
    let sent = 0;
    for (const a of due) {
      const row = db.prepare('SELECT reminders_sent, COALESCE(scheduled_at, created_at) AS scheduledAt FROM appointments WHERE id = ?').get(a.id);
      const done = new Set(String(row.reminders_sent || '').split(',').filter(Boolean));
      const start = Date.parse(a.startAt);
      const open = on.filter((k) => !done.has(k) && start - REMINDER_STAGES[k] <= t);
      if (!open.length) continue;
      // The closest one to the appointment is the one worth sending.
      const stage = open.reduce((x, y) => (REMINDER_STAGES[x] < REMINDER_STAGES[y] ? x : y));
      const coveredByBooking = Date.parse(row.scheduledAt) > start - REMINDER_STAGES[stage];
      try {
        if (!coveredByBooking) {
          await emailCustomer(this.ctx, { ...a, sendingAt: now }, 'reminder');
          sent++;
        }
        for (const k of open) done.add(k);
        db.prepare('UPDATE appointments SET reminders_sent = ?, reminder_sent_at = ? WHERE id = ?')
          .run(Object.keys(REMINDER_STAGES).filter((k) => done.has(k)).join(','), coveredByBooking ? a.reminderSentAt || 'skipped' : now.toISOString(), a.id);
      } catch (e) {
        console.error('Appointment reminder failed:', e.message);
      }
    }
    return sent;
  }

  async tick() {
    await this.sendReminders().catch((e) => console.error('Reminders failed:', e.message));
    await this.ctx.calendar.syncPending().catch((e) => console.error('Calendar sync failed:', e.message));
  }

  start() {
    this.timer = setInterval(() => this.tick(), 5 * 60 * 1000);
    this.timer.unref();
    setTimeout(() => this.tick(), 45 * 1000).unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }
}

// The day and time a booking shows on in the salon's time zone.
function localParts(iso, tz) {
  const d = new Date(iso);
  return { date: businessDate(d, tz), time: localTime(d, tz) };
}

module.exports = { REMINDER_STAGES, getAppointment, listAppointments, emailCustomer, appointmentEmail, notifySalon, AppointmentScheduler, localParts };

'use strict';

const { nowIso, businessDate, localTime } = require('./time');

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

function whenText(iso, tz) {
  const d = new Date(iso);
  const date = d.toLocaleDateString('en-CA', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric' });
  const time = d.toLocaleTimeString('en-CA', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
  return `${date} at ${time}`;
}

// Plain-text emails to the customer, sent from the salon's own mailbox.
function appointmentEmail(ctx, a, kind) {
  const s = ctx.settings;
  const name = s.get('business_name') || 'Beauty Parlour';
  const when = whenText(a.startAt, s.timezone());
  const services = a.services.map((x) => x.name).join(', ');
  const contact = [s.get('business_address'), s.get('business_phone')].filter(Boolean).join('\n');
  const first = a.customerName.split(/\s+/)[0];
  const subjects = {
    confirmation: `Your appointment at ${name}: ${when}`,
    updated: `Your appointment at ${name} has changed: ${when}`,
    reminder: `Reminder: your appointment at ${name}, ${when}`,
    cancelled: `Your appointment at ${name} is cancelled`,
  };
  const openers = {
    confirmation: `Your appointment is booked for ${when}.`,
    updated: `Your appointment has been moved to ${when}.`,
    reminder: `This is a friendly reminder of your appointment on ${when}.`,
    cancelled: `Your appointment on ${when} has been cancelled. Please get in touch if you would like to book another time.`,
  };
  const body = [
    `Hi ${first},`,
    '',
    openers[kind],
    kind !== 'cancelled' && services ? `Services: ${services}` : null,
    kind !== 'cancelled' ? '\nIf you need to change or cancel, please let us know.' : null,
    '',
    name,
    contact || null,
  ].filter((l) => l !== null);
  return { to: a.customerEmail, subject: subjects[kind], text: body.join('\n') };
}

async function emailCustomer(ctx, a, kind) {
  if (!a.customerEmail || !ctx.mailer.configured()) return false;
  await ctx.mailer.send(appointmentEmail(ctx, a, kind));
  return true;
}

// Sends reminder emails and retries calendar copies that failed. Runs on a timer.
class AppointmentScheduler {
  constructor(ctx) {
    this.ctx = ctx;
  }

  async sendReminders(now = new Date()) {
    const s = this.ctx.settings;
    if (s.get('appt_reminder_email') !== '1' || !this.ctx.mailer.configured()) return 0;
    const hours = Number(s.get('appt_reminder_hours') || 24);
    const db = this.ctx.db();
    const windowEnd = new Date(now.getTime() + hours * 3600000).toISOString();
    const due = listAppointments(db, `a.status IN ('booked','confirmed') AND a.reminder_sent_at IS NULL AND c.email IS NOT NULL AND c.email != ''
      AND a.start_at > ? AND a.start_at <= ?`, [now.toISOString(), windowEnd]);
    let sent = 0;
    for (const a of due) {
      // Booked inside the reminder window: the confirmation email is reminder enough.
      const bookedLate = new Date(a.createdAt).getTime() > new Date(a.startAt).getTime() - hours * 3600000;
      try {
        if (!bookedLate) {
          await emailCustomer(this.ctx, a, 'reminder');
          sent++;
        }
        db.prepare('UPDATE appointments SET reminder_sent_at = ? WHERE id = ?').run(bookedLate ? 'skipped' : nowIso(), a.id);
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

module.exports = { getAppointment, listAppointments, emailCustomer, appointmentEmail, AppointmentScheduler, localParts };

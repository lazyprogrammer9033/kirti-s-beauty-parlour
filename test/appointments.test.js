'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, setupOwner } = require('./helpers');
const { addDays, businessDate } = require('../server/lib/time');
const { fakeCalendar } = require('./fake-calendar');

let t;
after(() => t && t.close());

const tomorrow = () => addDays(businessDate(new Date(), 'America/Toronto'), 1);

async function connectCalendar(owner, g) {
  const r = await owner.post('/api/calendar/connect', { email: 'sharma.kirti56@gmail.com' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const url = new URL(r.data.url);
  assert.match(url.searchParams.get('scope'), /calendar\.events/);
  assert.equal(url.searchParams.get('login_hint'), 'sharma.kirti56@gmail.com');
  const cb = await owner.get(`/api/drive/callback?state=${url.searchParams.get('state')}&code=abc`);
  assert.match(cb.headers.get('location'), /settings\/appointments\?calendar=connected/);
  await t.ctx.calendar.syncPending();
}

test('book, list, reschedule and cancel appointments, copied to the chosen Google Calendar', async () => {
  const g = fakeCalendar();
  t = await startApp({ google: g.options });
  const owner = await setupOwner(t);
  await owner.put('/api/settings', { business_email: 'sharma.kirti56@gmail.com', business_phone: '416-555-0100', business_address: '12 Rose St, Toronto' });
  const sent = [];
  t.ctx.mailer.transportOverride = { sendMail: async (m) => sent.push(m) };

  const cust = (await owner.post('/api/customers', { fullName: 'Priya Shah', phone: '4165550101', email: 'priya@example.com' })).data;
  const cat = (await owner.get('/api/services')).data;
  const eyebrows = cat.flatMap((c) => c.services).find((s) => s.name === 'Eyebrows');
  const lip = cat.flatMap((c) => c.services).find((s) => s.name === 'Upper Lip');
  const day = tomorrow();

  // Booked before any calendar is connected: kept in the app only.
  const first = await owner.post('/api/appointments', { customerId: cust.id, date: day, time: '10:00', serviceIds: [eyebrows.id, lip.id], notify: true });
  assert.equal(first.status, 201, JSON.stringify(first.data));
  assert.equal(first.data.durationMinutes, 20);
  assert.equal(first.data.time, '10:00');
  assert.equal(first.data.date, day);
  assert.equal(first.data.syncStatus, null);
  assert.equal(first.data.emailed, true);
  assert.match(sent[0].subject, /Your appointment at Kirti's Beauty Parlour/);
  assert.match(sent[0].text, /Eyebrows, Upper Lip/);
  // Branded HTML with reply-based Confirm / Change / Cancel and a calendar file.
  assert.match(sent[0].html, /You’re booked in/);
  assert.match(sent[0].html, /mailto:[^"]*subject=Confirm%20appointment%20%23/);
  assert.match(sent[0].html, /subject=Change%20appointment/);
  assert.match(sent[0].html, /subject=Cancel%20appointment/);
  assert.match(sent[0].html, /calendar\.google\.com\/calendar\/render/);
  assert.equal(sent[0].replyTo, 'sharma.kirti56@gmail.com');
  assert.match(sent[0].html, /href="tel:4165550100"/);
  assert.equal(sent[0].attachments[0].filename, 'appointment.ics');
  assert.match(sent[0].attachments[0].content, /BEGIN:VEVENT[\s\S]*DTSTART:\d{8}T\d{6}Z/);

  // A clash needs confirming.
  const clash = await owner.post('/api/appointments', { customerId: cust.id, date: day, time: '10:10', serviceIds: [eyebrows.id] });
  assert.equal(clash.status, 409);
  assert.equal(clash.data.overlaps.length, 1);

  // Connecting the calendar copies upcoming bookings into it.
  assert.equal((await owner.post('/api/drive/credentials', { clientId: '123-abc.apps.googleusercontent.com', clientSecret: 's3cret' })).status, 200);
  await connectCalendar(owner, g);
  const status = (await owner.get('/api/calendar/status')).data;
  assert.equal(status.connected, true);
  assert.equal(status.account, 'sharma.kirti56@gmail.com');
  assert.equal(status.calendarId, 'primary');
  assert.equal(g.inCalendar('primary').length, 1);
  assert.match(g.inCalendar('primary')[0].summary, /Priya Shah · Eyebrows, Upper Lip/);
  const raw = t.ctx.db().prepare("SELECT value FROM business_settings WHERE key = 'calendar_refresh_token'").get().value;
  assert.match(raw, /^enc:v1:/);

  const second = (await owner.post('/api/appointments', { customerId: cust.id, date: day, time: '15:30', serviceIds: [eyebrows.id], notes: 'Sensitive skin' })).data;
  assert.equal(second.syncStatus, 'synced');
  assert.equal(second.inCalendar, true);
  assert.equal(g.inCalendar('primary').length, 2);

  const list = (await owner.get(`/api/appointments?from=${day}&to=${day}`)).data;
  assert.deepEqual(list.map((a) => a.time), ['10:00', '15:30']);

  // Reschedule moves the event.
  const moved = await owner.put(`/api/appointments/${second.id}`, { date: day, time: '16:00', serviceIds: [eyebrows.id], notify: true });
  assert.equal(moved.status, 200, JSON.stringify(moved.data));
  assert.equal(moved.data.time, '16:00');
  const ev = g.inCalendar('primary').find((e) => e.extendedProperties.private.salonAppointmentId === String(second.id));
  assert.equal(new Date(ev.start.dateTime).toISOString(), moved.data.startAt);
  assert.match(sent.at(-1).subject, /has moved/);

  // Switching to another calendar moves upcoming events across.
  const cals = (await owner.get('/api/calendar/calendars')).data;
  assert.equal(cals.length, 2);
  assert.equal((await owner.put('/api/calendar/calendar', { id: 'salon@group.calendar.google.com' })).status, 200);
  assert.equal(g.inCalendar('primary').length, 0);
  assert.equal(g.inCalendar('salon@group.calendar.google.com').length, 2);

  // Cancel removes it from the calendar and tells the customer.
  const cancelled = await owner.post(`/api/appointments/${second.id}/status`, { status: 'cancelled', notify: true });
  assert.equal(cancelled.data.status, 'cancelled');
  assert.equal(g.inCalendar('salon@group.calendar.google.com').length, 1);
  assert.match(sent.at(-1).subject, /cancelled/);

  // No internet: saved in the app, retried later.
  g.setDown(true);
  const third = (await owner.post('/api/appointments', { customerId: cust.id, date: day, time: '18:00', durationMinutes: 45 })).data;
  assert.equal(third.syncStatus, 'failed');
  assert.equal(third.durationMinutes, 45);
  g.setDown(false);
  await t.ctx.calendar.syncPending();
  assert.equal((await owner.get(`/api/appointments/${third.id}`)).data.syncStatus, 'synced');

  // Starting the visit from the booking marks it completed.
  const visit = await owner.post('/api/visits', { customerId: cust.id, appointmentId: first.data.id, items: [{ serviceId: eyebrows.id }], payments: [{ method: 'cash', amountCents: 1130 }] });
  assert.equal(visit.status, 201, JSON.stringify(visit.data));
  const done = (await owner.get(`/api/appointments/${first.data.id}`)).data;
  assert.equal(done.status, 'completed');
  assert.equal(done.visitId, visit.data.visitId);

  const history = (await owner.get(`/api/appointments?customerId=${cust.id}`)).data;
  assert.equal(history.length, 3);

  // Changing to a different Google account takes bookings out of the old one.
  g.setAccount('other@gmail.com');
  await connectCalendar(owner, g);
  assert.equal((await owner.get('/api/calendar/status')).data.account, 'other@gmail.com');
  assert.equal(g.inCalendar('salon@group.calendar.google.com').length, 0);
  assert.equal(g.inCalendar('primary').length, 2);

  assert.equal((await owner.post('/api/calendar/disconnect')).status, 200);
  assert.equal(g.inCalendar('primary').length, 0);
  assert.equal((await owner.get('/api/calendar/status')).data.connected, false);
});

test('reminder emails go out once, inside the reminder window', async () => {
  const sent = [];
  t.ctx.mailer.transportOverride = { sendMail: async (m) => sent.push(m) };
  const owner = t.client();
  await owner.post('/api/auth/login', { username: 'kirti', password: 'Secret-pass-1' });
  const cust = (await owner.post('/api/customers', { fullName: 'Meera Rao', phone: '4165550202', email: 'meera@example.com' })).data;
  const a = (await owner.post('/api/appointments', { customerId: cust.id, date: tomorrow(), time: '11:00', durationMinutes: 30 })).data;
  // Pretend it was booked a week ago, so a reminder is due.
  t.ctx.db().prepare('UPDATE appointments SET created_at = ?, scheduled_at = ? WHERE id = ?').run(new Date(Date.now() - 7 * 86400000).toISOString(), new Date(Date.now() - 7 * 86400000).toISOString(), a.id);
  const now = new Date(new Date(a.startAt).getTime() - 20 * 3600000);
  assert.equal(await t.ctx.appointments.sendReminders(now), 1);
  assert.equal(await t.ctx.appointments.sendReminders(now), 0);
  assert.match(sent.at(-1).subject, /^Reminder/);
  assert.equal(sent.at(-1).to, 'meera@example.com');
});

test('reminders go out a week, a day and two hours before, skipping any the booking already covered', async () => {
  const sent = [];
  t.ctx.mailer.transportOverride = { sendMail: async (m) => sent.push(m) };
  const owner = t.client();
  await owner.post('/api/auth/login', { username: 'kirti', password: 'Secret-pass-1' });
  const db = t.ctx.db();
  const cust = (await owner.post('/api/customers', { fullName: 'Lata Iyer', phone: '4165550909', email: 'lata@example.com' })).data;
  const book = async (n) => (await owner.post('/api/appointments', { customerId: cust.id, date: addDays(tomorrow(), n), time: '15:00', durationMinutes: 30, confirmOverlap: true })).data;
  const at = (a, ms) => new Date(Date.parse(a.startAt) - ms);
  const H = 3600000;
  const D = 24 * H;
  const run = async (now) => {
    const before = sent.length;
    await t.ctx.appointments.sendReminders(now);
    return sent.slice(before).filter((m) => m.to === 'lata@example.com');
  };

  // Booked a month ahead: all three go out, once each.
  const a = await book(30);
  db.prepare('UPDATE appointments SET scheduled_at = ? WHERE id = ?').run(new Date(Date.parse(a.startAt) - 30 * D).toISOString(), a.id);
  assert.equal((await run(at(a, 8 * D))).length, 0);
  let out = await run(at(a, 7 * D - 60000));
  assert.equal(out.length, 1);
  assert.match(out[0].html, /See you on/);
  assert.equal((await run(at(a, 6 * D))).length, 0);
  out = await run(at(a, 23 * H));
  assert.equal(out.length, 1);
  assert.match(out[0].subject, /^Reminder/);
  out = await run(at(a, 90 * 60000));
  assert.equal(out.length, 1);
  assert.match(out[0].html, /See you today/);
  assert.equal((await run(at(a, 30 * 60000))).length, 0);
  assert.equal(db.prepare('SELECT reminders_sent FROM appointments WHERE id = ?').get(a.id).reminders_sent, '1w,1d,2h');

  // Booked three days ahead: the week reminder is skipped, the others go out.
  const b = await book(31);
  db.prepare('UPDATE appointments SET scheduled_at = ? WHERE id = ?').run(new Date(Date.parse(b.startAt) - 3 * D).toISOString(), b.id);
  assert.equal((await run(at(b, 2 * D))).length, 0);
  assert.equal((await run(at(b, 20 * H))).length, 1);
  assert.equal((await run(at(b, H))).length, 1);

  // The computer was off: only the closest reminder is sent, not all of them.
  const c = await book(32);
  db.prepare('UPDATE appointments SET scheduled_at = ? WHERE id = ?').run(new Date(Date.parse(c.startAt) - 30 * D).toISOString(), c.id);
  assert.equal((await run(at(c, H))).length, 1);
  assert.equal((await run(at(c, 30 * 60000))).length, 0);

  // Moving a booking starts its reminders again.
  await owner.put(`/api/appointments/${a.id}`, { date: addDays(tomorrow(), 40), time: '15:00', durationMinutes: 30, confirmOverlap: true });
  assert.equal(db.prepare('SELECT reminders_sent FROM appointments WHERE id = ?').get(a.id).reminders_sent, null);

  // The owner can turn single reminders off.
  await owner.put('/api/settings', { appt_reminder_stages: '1d' });
  const d = await book(33);
  db.prepare('UPDATE appointments SET scheduled_at = ? WHERE id = ?').run(new Date(Date.parse(d.startAt) - 30 * D).toISOString(), d.id);
  assert.equal((await run(at(d, 7 * D - 60000))).length, 0);
  assert.equal((await run(at(d, 20 * H))).length, 1);
  assert.equal((await run(at(d, H))).length, 0);
  assert.equal((await owner.put('/api/settings', { appt_reminder_stages: '3h' })).status, 400);
  await owner.put('/api/settings', { appt_reminder_stages: '1w,1d,2h' });
});

test('staff can book; only the owner manages the calendar link', async () => {
  const owner = t.client();
  await owner.post('/api/auth/login', { username: 'kirti', password: 'Secret-pass-1' });
  await owner.post('/api/users', { displayName: 'Asha', username: 'asha', password: 'Staff-pass-1', role: 'staff' });
  const staff = t.client();
  assert.equal((await staff.post('/api/auth/login', { username: 'asha', password: 'Staff-pass-1' })).status, 200);
  const cust = (await staff.post('/api/customers', { fullName: 'Sana Ali', phone: '4165550303' })).data;
  assert.equal((await staff.post('/api/appointments', { customerId: cust.id, date: tomorrow(), time: '13:00' })).status, 201);
  assert.equal((await staff.get('/api/calendar/status')).status, 403);
  assert.equal((await staff.post('/api/calendar/connect')).status, 403);
  assert.equal((await staff.get(`/api/appointments?from=${tomorrow()}`)).status, 200);
});

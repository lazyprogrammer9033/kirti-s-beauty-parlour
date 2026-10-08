'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, setupOwner } = require('./helpers');
const { createPublicApp } = require('../server/public-app');
const { makeToken } = require('../server/lib/customer-links');
const { addDays, businessDate } = require('../server/lib/time');

let t;
let pub;
let pubBase;
after(async () => {
  if (pub) await new Promise((r) => pub.close(r));
  if (t) await t.close();
});

const get = (path) => fetch(pubBase + path, { redirect: 'manual' });
const post = (path, form = {}) => fetch(pubBase + path, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) });
const day = (n) => addDays(businessDate(new Date(), 'America/Toronto'), n);

test('customers confirm, move and cancel from the link in their email; nothing else is public', async () => {
  t = await startApp();
  pub = await new Promise((resolve) => {
    const s = createPublicApp(t.ctx).listen(0, '127.0.0.1', () => resolve(s));
  });
  pubBase = `http://127.0.0.1:${pub.address().port}`;
  const owner = await setupOwner(t);
  const sent = [];
  t.ctx.mailer.transportOverride = { sendMail: async (m) => sent.push(m) };
  await owner.put('/api/settings', { business_email: 'salon@example.com', business_phone: '416-555-0100', public_base_url: 'https://book.example.com', appt_customer_links: true });

  const cust = (await owner.post('/api/customers', { fullName: 'Priya Shah', phone: '4165550101', email: 'priya@example.com' })).data;
  const svc = (await owner.get('/api/services')).data.flatMap((c) => c.services).find((s) => s.name === 'Eyebrows');
  const a = (await owner.post('/api/appointments', { customerId: cust.id, date: day(2), time: '11:00', serviceIds: [svc.id], notify: true })).data;
  const other = (await owner.post('/api/appointments', { customerId: cust.id, date: day(2), time: '12:00', durationMinutes: 60 })).data;

  // The email's buttons are real links to this booking's page.
  const link = /href="https:\/\/book\.example\.com\/a\/([^"/]+)\/confirm"/.exec(sent[0].html);
  assert.ok(link, 'confirm link in email');
  const token = link[1];
  assert.match(sent[0].html, new RegExp(`/a/${token}/change"`));
  assert.match(sent[0].text, /book\.example\.com\/a\//);

  // Only the customer pages are served; the salon app is not.
  assert.equal((await get('/api/health')).status, 404);
  assert.equal((await get('/')).status, 404);
  assert.equal((await get('/index.html')).status, 404);

  // Forged and tampered links are rejected.
  assert.equal((await get(`/a/${a.id}-zzzzzz-AAAAAAAAAAAAAAAAAAAAAA`)).status, 404);
  assert.equal((await get(`/a/${other.id}${token.slice(String(a.id).length)}`)).status, 404);
  const expired = makeToken(t.ctx, { id: a.id, endAt: new Date(Date.now() - 8 * 86400000).toISOString() });
  assert.equal((await get('/a/' + expired)).status, 404);

  const view = await get('/a/' + token);
  assert.equal(view.status, 200);
  const html = await view.text();
  assert.match(html, /Hi Priya/);
  assert.doesNotMatch(html, /4165550101|priya@example\.com/); // no personal details on the page

  // Opening the confirm link alone changes nothing (mail scanners open links).
  assert.equal((await get(`/a/${token}/confirm`)).status, 200);
  assert.equal((await owner.get(`/api/appointments/${a.id}`)).data.status, 'booked');
  assert.equal((await post(`/a/${token}/confirm`)).status, 303);
  assert.equal((await owner.get(`/api/appointments/${a.id}`)).data.status, 'confirmed');
  assert.match(sent.at(-1).subject, /^Confirmed by customer: Priya Shah/);
  assert.equal(sent.at(-1).to, 'salon@example.com');

  // Change time: the 12:00 hour is taken by the other booking.
  const change = await (await get(`/a/${token}/change?date=${day(2)}`)).text();
  assert.match(change, /value="10:00"/);
  assert.doesNotMatch(change, /value="12:00"/);
  assert.doesNotMatch(change, /value="12:30"/);
  assert.equal((await post(`/a/${token}/change`, { date: day(2), time: '12:15' })).status, 409);
  assert.equal((await post(`/a/${token}/change`, { date: day(3), time: '14:00' })).status, 303);
  const moved = (await owner.get(`/api/appointments/${a.id}`)).data;
  assert.equal(moved.date, day(3));
  assert.equal(moved.time, '14:00');
  assert.equal(moved.durationMinutes, 10);
  assert.ok(sent.some((m) => /^Moved by customer/.test(m.subject)));
  assert.ok(sent.some((m) => m.to === 'priya@example.com' && /has moved/.test(m.subject)));

  // Cancel.
  assert.equal((await post(`/a/${token}/cancel`)).status, 303);
  assert.equal((await owner.get(`/api/appointments/${a.id}`)).data.status, 'cancelled');
  assert.match(await (await get('/a/' + token)).text(), /cancelled/);
  // A cancelled booking can't be moved back from the link.
  assert.equal((await post(`/a/${token}/change`, { date: day(4), time: '14:00' })).status, 303);
  assert.equal((await owner.get(`/api/appointments/${a.id}`)).data.status, 'cancelled');
});

test('bookings too close to start must be changed by phone', async () => {
  const owner = t.client();
  await owner.post('/api/auth/login', { username: 'kirti', password: 'Secret-pass-1' });
  const cust = (await owner.post('/api/customers', { fullName: 'Meera Rao', phone: '4165550202' })).data;
  const soon = new Date(Date.now() + 60 * 60000);
  const tz = 'America/Toronto';
  const hm = soon.toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const a = (await owner.post('/api/appointments', { customerId: cust.id, date: businessDate(soon, tz), time: hm, durationMinutes: 30, confirmOverlap: true })).data;
  const token = makeToken(t.ctx, a);
  assert.match(await (await get('/a/' + token)).text(), /too close/);
  assert.equal((await post(`/a/${token}/cancel`)).status, 303);
  assert.equal((await owner.get(`/api/appointments/${a.id}`)).data.status, 'booked');
});

test('anyone can book online with the Book now link once it is switched on', async () => {
  const owner = t.client();
  await owner.post('/api/auth/login', { username: 'kirti', password: 'Secret-pass-1' });
  const sent = [];
  t.ctx.mailer.transportOverride = { sendMail: async (m) => sent.push(m) };
  assert.equal((await get('/book')).status, 404); // off by default
  await owner.put('/api/settings', { appt_online_booking: true });

  const svcs = (await owner.get('/api/services')).data.flatMap((c) => c.services);
  const brows = svcs.find((s) => s.name === 'Eyebrows');
  const lip = svcs.find((s) => s.name === 'Upper Lip');
  const list = await (await get('/book')).text();
  assert.match(list, new RegExp(`name="s" value="${brows.id}"`));

  const times = await (await get(`/book/time?s=${brows.id}&s=${lip.id}&date=${day(5)}`)).text();
  assert.match(times, /20 min/);
  assert.match(times, /value="10:00"/);
  assert.equal((await get(`/book/details?s=${brows.id},${lip.id}&date=${day(5)}&time=10:00`)).status, 200);

  // Missing phone is caught; the bot trap books nothing.
  assert.equal((await post('/book', { s: `${brows.id},${lip.id}`, date: day(5), time: '10:00', name: 'Anita Roy', phone: '12' })).status, 400);
  await post('/book', { s: `${brows.id}`, date: day(5), time: '10:00', name: 'Bot', phone: '4165559999', website: 'x' });
  assert.equal((await owner.get('/api/customers/search?q=4165559999')).data.length, 0);

  const r = await post('/book', { s: `${brows.id},${lip.id}`, date: day(5), time: '10:00', name: 'Anita Roy', phone: '(416) 555-0303', email: 'anita@example.com', notes: 'First time' });
  assert.equal(r.status, 303);
  assert.match(r.headers.get('location'), /^\/a\/[\w-]+\?booked=1$/);
  assert.match(await (await get(r.headers.get('location'))).text(), /You’re booked/);

  const cust = (await owner.get('/api/customers/search?q=4165550303')).data[0];
  assert.equal(cust.fullName, 'Anita Roy');
  const appts = (await owner.get(`/api/appointments?customerId=${cust.id}`)).data;
  assert.equal(appts.length, 1);
  assert.equal(appts[0].time, '10:00');
  assert.deepEqual(appts[0].services.map((s) => s.name), ['Eyebrows', 'Upper Lip']);
  assert.ok(sent.some((m) => m.to === 'anita@example.com' && /You’re booked in/.test(m.html)));
  assert.ok(sent.some((m) => m.to === 'salon@example.com' && /^New online booking: Anita Roy/.test(m.subject)));

  // The same slot can't be booked twice; a returning customer is matched by phone.
  assert.equal((await post('/book', { s: `${brows.id}`, date: day(5), time: '10:00', name: 'Someone Else', phone: '4165550404' })).status, 409);
  const again = await post('/book', { s: `${brows.id}`, date: day(6), time: '11:00', name: 'Anita', phone: '416 555 0303' });
  assert.equal(again.status, 303);
  assert.equal((await owner.get(`/api/appointments?customerId=${cust.id}`)).data.length, 2);
  assert.equal((await owner.get('/api/customers/search?q=4165550303')).data.length, 1);
});

test('the owner blocks times; customers see free times per day up to a year ahead', async () => {
  const owner = t.client();
  await owner.post('/api/auth/login', { username: 'kirti', password: 'Secret-pass-1' });
  const brows = (await owner.get('/api/services')).data.flatMap((c) => c.services).find((s) => s.name === 'Eyebrows');
  const times = async (date) => (await get(`/book/time?s=${brows.id}&date=${date}`)).text();

  // A month calendar shows the free times for each day.
  let html = await times(day(8));
  assert.match(html, /\d+ free/);
  assert.match(html, /value="13:00"/);

  // Lunch blocked on one day; the whole of another day closed.
  const lunch = await owner.post('/api/appointment-blocks', { fromDate: day(8), fromTime: '13:00', toTime: '14:00', reason: 'Lunch' });
  assert.equal(lunch.status, 201);
  assert.equal(lunch.data.allDay, false);
  html = await times(day(8));
  assert.doesNotMatch(html, /value="13:00"|value="13:45"/);
  assert.match(html, /value="12:45"/);
  assert.match(html, /value="14:00"/);
  assert.equal((await post('/book', { s: `${brows.id}`, date: day(8), time: '13:15', name: 'Neha Jain', phone: '4165550505' })).status, 409);

  const holiday = (await owner.post('/api/appointment-blocks', { fromDate: day(9), toDate: day(10), allDay: true, reason: 'Holiday' })).data;
  assert.equal(holiday.toDate, day(10));
  html = await times(day(9));
  assert.match(html, /No free times on/);
  assert.doesNotMatch(html, /name="time"/);
  assert.equal((await post('/book', { s: `${brows.id}`, date: day(10), time: '11:00', name: 'Neha Jain', phone: '4165550505' })).status, 409);
  const list = (await owner.get(`/api/appointment-blocks?from=${day(8)}&to=${day(10)}`)).data;
  assert.equal(list.length, 2);
  assert.ok(!(await times(day(9))).includes('Holiday'), 'the reason is not shown to customers');

  // Staff get a warning but can still book over a block.
  const cust = (await owner.post('/api/customers', { fullName: 'Ritu Das', phone: '4165550606' })).data;
  const clash = await owner.post('/api/appointments', { customerId: cust.id, date: day(8), time: '13:00' });
  assert.equal(clash.status, 409);
  assert.match(clash.data.overlaps[0].customerName, /Blocked \(Lunch\)/);

  // Removing the block opens the time again.
  assert.equal((await owner.del(`/api/appointment-blocks/${lunch.data.id}`)).status, 200);
  assert.match(await times(day(8)), /value="13:00"/);

  // Bookings open a year ahead, and no further.
  html = await times(day(300));
  assert.match(html, /value="10:00"/);
  assert.equal((await post('/book', { s: `${brows.id}`, date: day(300), time: '10:00', name: 'Neha Jain', phone: '4165550505' })).status, 303);
  assert.equal((await post('/book', { s: `${brows.id}`, date: day(380), time: '10:00', name: 'Neha Jain', phone: '4165550505' })).status, 409);
  assert.equal((await get(`/book/time?s=${brows.id}&month=2099-01`)).status, 200);
});


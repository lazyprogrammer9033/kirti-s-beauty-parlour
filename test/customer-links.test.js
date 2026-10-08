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

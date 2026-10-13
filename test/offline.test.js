'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, setupOwner } = require('./helpers');

let t;
let owner;
let svcId;
before(async () => {
  t = await startApp();
  owner = await setupOwner(t);
  svcId = (await owner.get('/api/services')).data[0].services[0].id;
});
after(() => t.close());

test('snapshot carries services, tax and customers for offline check-in', async () => {
  await owner.post('/api/customers', { fullName: 'Snap Shot', phone: '4165557000', notes: 'Sensitive skin' });
  const snap = (await owner.get('/api/offline/snapshot')).data;
  assert.ok(snap.catalogue.length > 0);
  assert.equal(snap.tax.rateBp, 1300);
  const c = snap.customers.find((x) => x.fullName === 'Snap Shot');
  assert.equal(c.phoneDigits, '4165557000');
  assert.deepEqual(c.notes, [{ note: 'Sensitive skin' }]);
});

test('sending the same offline customer twice creates it once', async () => {
  const body = { fullName: 'Twice Sent', phone: '4165557001', clientRef: 'ref-customer-0001' };
  const a = await owner.post('/api/customers', body);
  const b = await owner.post('/api/customers', body);
  assert.equal(a.status, 201);
  assert.equal(b.status, 200);
  assert.equal(a.data.id, b.data.id);
  assert.equal((await owner.get('/api/customers/search?q=4165557001')).data.length, 1);
});

test('an offline visit keeps its time, is never duplicated, and checks the total', async () => {
  const cust = (await owner.post('/api/customers', { fullName: 'Offline Visit', phone: '4165557002' })).data;
  const quote = (await owner.post('/api/visits/quote', { items: [{ serviceId: svcId }] })).data;
  const at = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
  const body = { customerId: cust.id, items: [{ serviceId: svcId }], payments: [{ method: 'cash', amountCents: quote.totalCents }],
    clientRef: 'ref-visit-0001', offlineAt: at, expectedTotalCents: quote.totalCents, allowBalance: true };

  const wrong = await owner.post('/api/visits', { ...body, clientRef: 'ref-visit-0002', expectedTotalCents: quote.totalCents + 100 });
  assert.equal(wrong.status, 409);
  assert.equal(wrong.data.totalCents, quote.totalCents);

  const a = await owner.post('/api/visits', body);
  const b = await owner.post('/api/visits', body);
  assert.equal(a.status, 201);
  assert.equal(b.status, 200);
  assert.equal(a.data.invoiceNumber, b.data.invoiceNumber);
  const inv = (await owner.get('/api/invoices/' + a.data.invoiceId)).data;
  assert.equal(inv.issuedAt, at);
  assert.equal(inv.status, 'paid');
  assert.equal((await owner.get('/api/customers/' + cust.id)).data.visits.length, 1);

  const future = await owner.post('/api/visits', { ...body, clientRef: 'ref-visit-0003', offlineAt: new Date(Date.now() + 3600 * 1000).toISOString() });
  assert.equal(future.status, 400);
  assert.equal((await owner.post('/api/customers', { fullName: 'X', phone: '4165557009', clientRef: 'bad ref!' })).status, 400);
});

test('the app files and bill maths are served for offline use', async () => {
  const sw = await fetch(t.base + '/sw.js');
  const text = await sw.text();
  assert.match(text, /const VERSION = "/);
  assert.match(text, /"\/js\/views\/visit\.js"/);
  const money = await (await fetch(t.base + '/js/money.js')).text();
  assert.match(money, /export const \{ toCents, formatCad, calculateInvoice/);
  assert.equal((await fetch(t.base + '/api/health')).status, 200);
});

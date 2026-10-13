'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, setupOwner } = require('./helpers');

let t;
let owner;
let staff;
let ids;

before(async () => {
  t = await startApp();
  owner = await setupOwner(t);
  const catalogue = (await owner.get('/api/services')).data;
  const svc = (name) => catalogue.flatMap((c) => c.services).find((s) => s.name === name).id;
  const kirti = t.ctx.db().prepare("SELECT id FROM users WHERE username = 'kirti'").get().id;
  const meera = (await owner.post('/api/users', { displayName: 'Meera', username: 'meera', password: 'staff-pass-1', role: 'staff' })).data.id;
  await owner.post('/api/users', { displayName: 'Anu', username: 'anu', password: 'staff-pass-2', role: 'staff' });
  staff = t.client();
  await staff.post('/api/auth/login', { username: 'meera', password: 'staff-pass-1' });
  const customer = (await owner.post('/api/customers', { fullName: 'Asha Rao', phone: '4165550123' })).data.id;
  ids = { kirti, meera, customer };

  const visit = async (who, body) => {
    const r = await who.post('/api/visits', { customerId: customer, allowBalance: true, ...body });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    return r.data;
  };
  // Haircut and Pedicure are 45.00 + 13% tax = 50.85; a 10.00 custom charge is 11.30.
  await visit(owner, { staffUserId: meera, items: [{ serviceId: svc('Haircut') }, { type: 'custom', description: 'Hair spa add-on', price: '10' }] });
  await visit(owner, { items: [{ serviceId: svc('Pedicure') }] });
  await visit(staff, { items: [{ serviceId: svc('Haircut'), staffUserId: kirti }] });
  const voided = await visit(staff, { items: [{ serviceId: svc('Pedicure') }] });
  await owner.post(`/api/invoices/${voided.invoiceId}/void`, { reason: 'Entered twice' });
});
after(() => t.close());

test('owner dashboard shows each staff member’s sales, including staff with none', async () => {
  const d = (await owner.get('/api/dashboard')).data;
  const by = Object.fromEntries(d.staffSales.map((s) => [s.name, s]));
  assert.deepEqual(Object.keys(by), ['Kirti', 'Meera', 'Anu']);
  assert.equal(by.Kirti.todayCents, 5085 * 2);
  assert.equal(by.Kirti.todayVisits, 2);
  assert.equal(by.Meera.todayCents, 5085 + 1130);
  assert.equal(by.Meera.monthCents, 5085 + 1130);
  assert.equal(by.Meera.todayVisits, 1);
  assert.equal(by.Anu.todayCents, 0);
  const total = d.staffSales.reduce((s, x) => s + x.todayCents, 0);
  assert.equal(total, d.todayStats.salesCents);
});

test('staff report credits custom charges to the visit’s staff and skips voided bills', async () => {
  const r = (await owner.get('/api/reports/staff')).data;
  const meera = r.rows.find((x) => x.staff === 'Meera');
  assert.equal(meera.sales, 6215);
  assert.equal(meera.revenue, 5500);
  assert.equal(meera.services, 1);
  assert.equal(r.summary[0].value, 6215 + 10170);
  assert.equal(r.summary[2].value, 'Kirti');
});

test('staff do not see anyone’s sales', async () => {
  const d = (await staff.get('/api/dashboard')).data;
  assert.equal(d.staffSales, undefined);
  assert.equal((await staff.get('/api/reports/staff')).status, 403);
});

test('owner can download one staff member’s sales statement; staff cannot', async () => {
  const r = (await owner.get(`/api/reports/staff?staff=${ids.meera}`)).data;
  assert.equal(r.title, 'Sales Statement: Meera');
  assert.equal(r.summary[0].value, 6215);
  assert.deepEqual(r.rows.map((x) => [x.service, x.sales]), [['Haircut', 5085], ['Hair spa add-on', 1130]]);
  assert.ok(r.rows.every((x) => x.customer === 'Asha Rao'));
  const pdf = await owner.get(`/api/reports/staff?staff=${ids.meera}&format=pdf`);
  assert.equal(pdf.data.subarray(0, 4).toString(), '%PDF');
  assert.match(pdf.headers.get('content-disposition'), /meera-sales-statement_/);
  const csv = await owner.get(`/api/reports/staff?staff=${ids.meera}&format=csv`);
  assert.ok(csv.data.toString().includes('Hair spa add-on'));
  assert.equal((await staff.get(`/api/reports/staff?staff=${ids.meera}&format=pdf`)).status, 403);
  const all = (await owner.get('/api/reports/staff?staff=999')).data;
  assert.equal(all.title, 'Staff Report');
});

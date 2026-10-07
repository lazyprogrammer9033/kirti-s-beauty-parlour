'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, setupOwner } = require('./helpers');

let t;
let owner;
let catalogue;
const svc = (name) => catalogue.flatMap((c) => c.services).find((s) => s.name === name);

before(async () => {
  t = await startApp();
  owner = await setupOwner(t);
  catalogue = (await owner.get('/api/services')).data;
});
after(() => t.close());

test('first-run setup can only happen once', async () => {
  const again = await t.client().post('/api/auth/setup', { displayName: 'X', username: 'x', password: 'password123' });
  assert.equal(again.status, 409);
});

test('API requires sign in and the CSRF header', async () => {
  const anon = t.client();
  assert.equal((await anon.get('/api/customers/search?q=1')).status, 401);
  const noHeader = await owner.req('POST', '/api/customers', { fullName: 'A', phone: '4165550000' }, { 'X-Salon-Request': '0' });
  assert.equal(noHeader.status, 403);
});

test('wrong password is rejected and repeated failures lock the account briefly', async () => {
  const c = t.client();
  for (let i = 0; i < 5; i++) assert.equal((await c.post('/api/auth/login', { username: 'kirti', password: 'nope-nope' })).status, 401);
  assert.equal((await c.post('/api/auth/login', { username: 'kirti', password: 'Secret-pass-1' })).status, 429);
  t.ctx.loginLimiter.map.clear();
  assert.equal((await c.post('/api/auth/login', { username: 'kirti', password: 'Secret-pass-1' })).status, 200);
});

test('passwords are hashed, never stored in plain text', () => {
  const row = t.ctx.db().prepare("SELECT password_hash FROM users WHERE username = 'kirti'").get();
  assert.match(row.password_hash, /^scrypt\$/);
  assert.ok(!row.password_hash.includes('Secret-pass-1'));
});

let priya;
test('customer creation assigns a permanent customer ID', async () => {
  const r = await owner.post('/api/customers', { fullName: 'Priya Patel', phone: '416-555-1234', email: 'Priya@Example.com', notes: 'Sensitive skin.' });
  assert.equal(r.status, 201);
  assert.equal(r.data.customerCode, 'CUS-000001');
  priya = r.data.id;
  const r2 = await owner.post('/api/customers', { fullName: 'Anita Shah', phone: '6475550000' });
  assert.equal(r2.data.customerCode, 'CUS-000002');
});

test('duplicate phone number is detected in any format and needs confirmation', async () => {
  const dup = await owner.post('/api/customers', { fullName: 'Someone Else', phone: '+1 (416) 555 1234' });
  assert.equal(dup.status, 409);
  assert.equal(dup.data.duplicates[0].customerCode, 'CUS-000001');
  const forced = await owner.post('/api/customers', { fullName: 'Priya Sister', phone: '4165551234', confirmDuplicate: true });
  assert.equal(forced.status, 201);
});

test('returning customer lookup by phone, partial phone, name, email and ID', async () => {
  const byPhone = (await owner.get('/api/customers/search?q=4165551234')).data;
  assert.equal(byPhone[0].fullName, 'Priya Patel');
  assert.ok((await owner.get('/api/customers/search?q=416-555')).data.length >= 2);
  assert.equal((await owner.get('/api/customers/search?q=1234')).data.length, 2);
  assert.equal((await owner.get('/api/customers/search?q=anita')).data[0].customerCode, 'CUS-000002');
  assert.equal((await owner.get('/api/customers/search?q=priya@example')).data[0].id, priya);
  assert.equal((await owner.get('/api/customers/search?q=cus-1')).data[0].id, priya);
  assert.equal((await owner.get('/api/customers/search?q=CUS-000002')).data[0].fullName, 'Anita Shah');
});

test('quote matches the worked example: $105 - $10 discount + 13% HST = $107.35', async () => {
  const facial60 = svc('Deep Cleansing Facial');
  assert.equal(facial60.priceCents, 6000);
  const q = await owner.post('/api/visits/quote', {
    items: [{ serviceId: svc('Haircut').id }, { serviceId: facial60.id }],
    discount: { type: 'amount', amountCents: 1000 },
  });
  assert.equal(q.status, 200);
  assert.deepEqual([q.data.subtotalCents, q.data.discountCents, q.data.taxCents, q.data.totalCents], [10500, 1000, 1235, 10735]);
});

let firstInvoice;
test('new visit with multiple services, quantity, discount and split payment', async () => {
  const items = [{ serviceId: svc('Haircut').id }, { serviceId: svc('Eyebrows').id, quantity: 2 }];
  // 4500 + 2000 = 6500; 10% = 650; taxable 5850; tax 760.5 -> 761; total 6611
  const r = await owner.post('/api/visits', {
    customerId: priya,
    items,
    discount: { type: 'percent', percent: 10 },
    notes: 'Wants shorter fringe next time',
    payments: [{ method: 'cash', amountCents: 4000 }, { method: 'debit', amountCents: 2611 }],
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.match(r.data.invoiceNumber, /^INV-\d{4}-000001$/);
  assert.match(r.data.visitCode, /^VIS-000001$/);
  assert.equal(r.data.totalCents, 6611);
  assert.equal(r.data.balanceCents, 0);
  firstInvoice = r.data;
  const inv = (await owner.get('/api/invoices/' + r.data.invoiceId)).data;
  assert.equal(inv.status, 'paid');
  assert.equal(inv.items.reduce((s, i) => s + i.taxCents, 0), inv.taxCents);
  assert.equal(inv.items.reduce((s, i) => s + i.discountCents, 0), inv.discountCents);
  assert.equal(inv.payments.length, 2);
});

test('overpayment is refused; underpayment needs explicit confirmation and leaves a balance', async () => {
  const items = [{ serviceId: svc('Manicure').id }];
  const over = await owner.post('/api/visits', { customerId: priya, items, payments: [{ method: 'cash', amountCents: 999999 }] });
  assert.equal(over.status, 400);
  const under = await owner.post('/api/visits', { customerId: priya, items, payments: [{ method: 'cash', amountCents: 1000 }] });
  assert.equal(under.status, 400);
  assert.equal(under.data.needsBalanceConfirm, true);
  const ok = await owner.post('/api/visits', { customerId: priya, items, payments: [{ method: 'cash', amountCents: 1000 }], allowBalance: true });
  assert.equal(ok.status, 201);
  assert.equal(ok.data.balanceCents, 3390 - 1000);
  // Pay the rest later.
  const tooMuch = await owner.post(`/api/invoices/${ok.data.invoiceId}/payments`, { method: 'etransfer', amountCents: 5000 });
  assert.equal(tooMuch.status, 400);
  const paid = await owner.post(`/api/invoices/${ok.data.invoiceId}/payments`, { method: 'etransfer', amountCents: 2390 });
  assert.equal(paid.data.status, 'paid');
  assert.equal(paid.data.balanceCents, 0);
});

test('custom charges use the entered price; service prices always come from the catalogue', async () => {
  const r = await owner.post('/api/visits/quote', {
    items: [{ serviceId: svc('Haircut').id, priceCents: 1 }, { type: 'custom', description: 'Hair treatment add-on', price: '12.50', taxable: false }],
  });
  assert.equal(r.data.subtotalCents, 4500 + 1250);
  assert.equal(r.data.taxCents, 585); // only the haircut is taxed
});

test('tax rate changes and price changes never alter historical invoices', async () => {
  const before = (await owner.get('/api/invoices/' + firstInvoice.invoiceId)).data;
  assert.equal((await owner.put('/api/settings', { tax_rate_bp: 5 })).status, 200);
  assert.equal((await owner.put('/api/services/' + svc('Haircut').id, { price: '55.00' })).status, 200);
  const after = (await owner.get('/api/invoices/' + firstInvoice.invoiceId)).data;
  assert.deepEqual(after.items, before.items);
  assert.equal(after.taxCents, before.taxCents);
  assert.equal(after.taxRateBp, 1300);
  const q = await owner.post('/api/visits/quote', { items: [{ serviceId: svc('Haircut').id }] });
  assert.deepEqual([q.data.subtotalCents, q.data.taxCents], [5500, 275]);
  // Tax-included pricing: $55 incl. 5% => tax 2.62, total stays 55.00
  await owner.put('/api/settings', { prices_include_tax: true });
  const qi = await owner.post('/api/visits/quote', { items: [{ serviceId: svc('Haircut').id }] });
  assert.deepEqual([qi.data.taxCents, qi.data.totalCents], [262, 5500]);
  await owner.put('/api/settings', { tax_rate_bp: 13, prices_include_tax: false });
  await owner.put('/api/services/' + svc('Haircut').id, { price: '45.00' });
  // The database itself refuses to change invoice amounts.
  assert.throws(() => t.ctx.db().prepare('UPDATE invoices SET total_cents = 1 WHERE id = ?').run(firstInvoice.invoiceId), /immutable/);
  assert.throws(() => t.ctx.db().prepare('DELETE FROM invoices WHERE id = ?').run(firstInvoice.invoiceId), /cannot be deleted/);
});

test('customer profile shows summary, favourites, notes and full history', async () => {
  const p = (await owner.get('/api/customers/' + priya)).data;
  assert.equal(p.customerCode, 'CUS-000001');
  assert.equal(p.stats.totalVisits, 2);
  assert.equal(p.stats.totalSpentCents, 6611 + 3390);
  assert.equal(p.stats.averageCents, Math.round((6611 + 3390) / 2));
  assert.equal(p.stats.balanceCents, 0);
  assert.equal(p.stats.favouriteServices[0].name, 'Eyebrows');
  assert.equal(p.stats.lastPayment.method, 'etransfer');
  assert.equal(p.notes[0].note, 'Sensitive skin.');
  assert.equal(p.visits.length, 2);
  assert.equal(p.visits[1].notes, 'Wants shorter fringe next time');
  assert.equal(p.visits[1].services.length, 2);
});

test('voiding keeps the record but removes it from totals; only the owner can void', async () => {
  const staffCreate = await owner.post('/api/users', { displayName: 'Meera', username: 'meera', password: 'staff-pass-1', role: 'staff' });
  assert.equal(staffCreate.status, 200);
  const staff = t.client();
  assert.equal((await staff.post('/api/auth/login', { username: 'meera', password: 'staff-pass-1' })).status, 200);
  const v = await staff.post('/api/visits', { customerId: priya, items: [{ serviceId: svc('Pedicure').id }], payments: [{ method: 'credit', amountCents: 5085 }] });
  assert.equal(v.status, 201);
  assert.equal((await staff.post(`/api/invoices/${v.data.invoiceId}/void`, { reason: 'test' })).status, 403);
  const voided = await owner.post(`/api/invoices/${v.data.invoiceId}/void`, { reason: 'Entered twice' });
  assert.equal(voided.data.status, 'void');
  const p = (await owner.get('/api/customers/' + priya)).data;
  assert.equal(p.stats.totalVisits, 2);
  assert.equal(p.visits.length, 3);
});

test('staff permissions: billing yes; reports, settings, users, backups, exports, audit no', async () => {
  const staff = t.client();
  await staff.post('/api/auth/login', { username: 'meera', password: 'staff-pass-1' });
  assert.equal((await staff.get('/api/customers/search?q=priya')).status, 200);
  assert.equal((await staff.post('/api/customers', { fullName: 'Walk In', phone: '9055550101' })).status, 201);
  for (const url of ['/api/reports/sales', '/api/users', '/api/backups', '/api/export/customers.csv', '/api/audit']) {
    assert.equal((await staff.get(url)).status, 403, url);
  }
  assert.equal((await staff.put('/api/settings', { tax_rate_bp: 0 })).status, 403);
  assert.equal((await staff.put('/api/services/' + svc('Haircut').id, { price: '1.00' })).status, 403);
  const settings = (await staff.get('/api/settings')).data;
  assert.equal(settings.smtp_user, undefined);
  // Staff discounts are allowed by default, custom charges are not.
  const custom = await staff.post('/api/visits/quote', { items: [{ type: 'custom', description: 'x', price: '5' }] });
  assert.equal(custom.status, 403);
  const dash = (await staff.get('/api/dashboard')).data;
  assert.equal(dash.financials, false);
  assert.equal(dash.yearSalesCents, undefined);
});

test('dashboard and every report return data and export to CSV and PDF', async () => {
  const d = (await owner.get('/api/dashboard')).data;
  assert.equal(d.financials, true);
  assert.equal(d.todayStats.salesCents, 6611 + 3390);
  assert.equal(d.todayStats.newCustomers, 1);
  assert.equal(d.dailySales.length, 30);
  assert.equal(d.topCustomers[0].name, 'Priya Patel');
  for (const type of ['sales', 'customers', 'services', 'payments', 'staff', 'spending']) {
    const r = await owner.get(`/api/reports/${type}`);
    assert.equal(r.status, 200, type);
    assert.ok(Array.isArray(r.data.rows));
    const csv = await owner.get(`/api/reports/${type}?format=csv`);
    assert.equal(csv.status, 200);
    assert.ok(csv.data.toString().includes(','));
    const pdf = await owner.get(`/api/reports/${type}?format=pdf`);
    assert.equal(pdf.data.subarray(0, 4).toString(), '%PDF');
  }
  const sales = (await owner.get('/api/reports/sales?group=month')).data;
  assert.equal(sales.summary[0].value, 6611 + 3390);
  const pays = (await owner.get('/api/reports/payments')).data;
  assert.equal(pays.rows.find((r) => r.method === 'Cash').amount, 5000);
});

test('receipt PDF is generated and email sends with the PDF attached', async () => {
  const pdf = await owner.get(`/api/invoices/${firstInvoice.invoiceNumber}/pdf`);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.data.subarray(0, 4).toString(), '%PDF');
  const sent = [];
  t.ctx.mailer.transportOverride = { sendMail: async (m) => sent.push(m) };
  const r = await owner.post(`/api/invoices/${firstInvoice.invoiceId}/email`, {});
  assert.equal(r.status, 200);
  assert.equal(sent[0].to, 'priya@example.com');
  assert.equal(sent[0].attachments[0].filename, firstInvoice.invoiceNumber + '.pdf');
  t.ctx.mailer.transportOverride = null;
  const noMail = await owner.post(`/api/invoices/${firstInvoice.invoiceId}/email`, {});
  assert.equal(noMail.status, 400);
});

test('export all data as Excel and each table as CSV', async () => {
  const x = await owner.get('/api/export/all.xlsx');
  assert.equal(x.status, 200);
  assert.equal(x.data.subarray(0, 2).toString(), 'PK');
  const csv = (await owner.get('/api/export/invoices.csv')).data.toString();
  assert.ok(csv.includes('66.11'));
  for (const name of ['customers', 'customer_notes', 'visits', 'invoice_items', 'payments', 'services']) {
    assert.equal((await owner.get(`/api/export/${name}.csv`)).status, 200);
  }
});

test('backup and restore round trip, with a safety copy and confirmation', async () => {
  const b = await owner.post('/api/backups');
  assert.equal(b.status, 201);
  assert.equal(b.data.status, 'success');
  // Add data after the backup, then restore: it should disappear.
  await owner.post('/api/customers', { fullName: 'After Backup', phone: '2895550199' });
  assert.equal((await owner.post(`/api/backups/${b.data.id}/restore`, {})).status, 400);
  const r = await owner.post(`/api/backups/${b.data.id}/restore`, { confirm: 'RESTORE' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(r.data.safetyBackup, /pre-restore/);
  assert.equal((await owner.get('/api/customers/search?q=after backup')).data.length, 0);
  const list = (await owner.get('/api/backups')).data;
  assert.ok(list.status.lastSuccess);
  // Uploading a backup file restores too; a random file is rejected.
  const file = (await owner.get(`/api/backups/${b.data.id}/download`)).data;
  assert.equal((await owner.req('POST', '/api/backups/restore-upload', Buffer.alloc(4096, 1), { 'X-Confirm': 'RESTORE' })).status, 400);
  const up = await owner.req('POST', '/api/backups/restore-upload', file, { 'X-Confirm': 'RESTORE', 'X-Filename': 'x.db' });
  assert.equal(up.status, 200, JSON.stringify(up.data));
});

test('audit log records important actions and cannot be modified', async () => {
  const log = (await owner.get('/api/audit?limit=500')).data.map((a) => a.action);
  for (const a of ['customer.created', 'invoice.created', 'payment.recorded', 'invoice.voided', 'service.price_changed', 'user.created', 'settings.tax_changed', 'backup.restored']) {
    assert.ok(log.includes(a), a);
  }
  assert.throws(() => t.ctx.db().prepare('DELETE FROM audit_logs').run(), /append-only/);
  assert.throws(() => t.ctx.db().prepare("UPDATE audit_logs SET action = 'x'").run(), /append-only/);
});

test('customers cannot be deleted, only made inactive by the owner', async () => {
  assert.throws(() => t.ctx.db().prepare('DELETE FROM customers').run(), /cannot be deleted/);
  const staff = t.client();
  await staff.post('/api/auth/login', { username: 'meera', password: 'staff-pass-1' });
  const base = { fullName: 'Anita Shah', phone: '6475550000' };
  const anita = (await owner.get('/api/customers/search?q=anita')).data[0].id;
  assert.equal((await staff.put('/api/customers/' + anita, { ...base, status: 'inactive' })).status, 403);
  assert.equal((await owner.put('/api/customers/' + anita, { ...base, status: 'inactive' })).status, 200);
});

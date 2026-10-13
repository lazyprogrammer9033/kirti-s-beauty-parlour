'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers');

test('default first run opens as the owner with no setup and no sample services', async () => {
  const t = await startApp({ requireLogin: undefined, sampleServices: false });
  try {
    const c = t.client();
    const status = (await c.get('/api/auth/status')).data;
    assert.equal(status.setupRequired, false);
    assert.equal(status.requireLogin, false);
    assert.equal(status.user.role, 'owner');
    assert.equal(status.user.openAccess, true);
    assert.deepEqual((await c.get('/api/services')).data, []);
    const cust = await c.post('/api/customers', { fullName: 'Asha', phone: '4165550101' });
    assert.equal(cust.status, 201);
  } finally {
    await t.close();
  }
});

test('turning on sign-in sets the owner password and locks out anonymous use', async () => {
  const t = await startApp({ requireLogin: false });
  try {
    const owner = t.client();
    assert.equal((await owner.post('/api/auth/require-login', { enabled: true, username: 'kirti', password: 'short' })).status, 400);
    const on = await owner.post('/api/auth/require-login', { enabled: true, username: 'kirti', password: 'Secret-pass-1' });
    assert.equal(on.status, 200);
    // The owner keeps working through the session cookie set by that call.
    assert.equal((await owner.get('/api/auth/status')).data.user.openAccess, false);

    const anon = t.client();
    assert.equal((await anon.get('/api/customers/search?q=1')).status, 401);
    assert.equal((await anon.post('/api/auth/login', { username: 'kirti', password: 'Secret-pass-1' })).status, 200);

    const staff = await owner.post('/api/users', { displayName: 'Meera', username: 'meera', role: 'staff', password: 'staff-pass-1' });
    assert.equal(staff.status, 200);
    const sc = t.client();
    await sc.post('/api/auth/login', { username: 'meera', password: 'staff-pass-1' });
    assert.equal((await sc.post('/api/auth/require-login', { enabled: false })).status, 403);

    assert.equal((await owner.post('/api/auth/require-login', { enabled: false })).status, 200);
    assert.equal((await t.client().get('/api/auth/status')).data.user.role, 'owner');
  } finally {
    await t.close();
  }
});

'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, Client } = require('./helpers');

let t;
after(() => t && t.close());

test('sign-in ends when the browser closes and after 30 minutes unused', async () => {
  t = await startApp();
  const c = t.client();
  const r = await c.post('/api/auth/setup', { displayName: 'Kirti', username: 'kirti', password: 'Secret-pass-1', businessName: "Kirti's Beauty Parlour" });
  assert.equal(r.status, 200);
  // A browser-session cookie: no Expires or Max-Age, so closing the browser forgets it.
  const set = r.headers.get('set-cookie');
  assert.match(set, /HttpOnly/);
  assert.doesNotMatch(set, /Expires=|Max-Age=/i);

  // A new browser (no cookie) is signed out.
  assert.equal((await new Client(t.base).get('/api/customers')).status, 401);

  // Using the app keeps the session going; 30 idle minutes end it.
  const db = t.ctx.db();
  const row = () => db.prepare('SELECT expires_at FROM sessions').get();
  const soon = new Date(Date.now() + 5 * 60000).toISOString();
  db.prepare('UPDATE sessions SET expires_at = ?').run(soon);
  assert.equal((await c.get('/api/customers')).status, 200);
  assert.ok(Date.parse(row().expires_at) > Date.now() + 25 * 60000, 'activity extends the session');
  db.prepare('UPDATE sessions SET expires_at = ?').run(new Date(Date.now() - 1000).toISOString());
  assert.equal((await c.get('/api/customers')).status, 401);
});

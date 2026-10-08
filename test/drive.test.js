'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, setupOwner } = require('./helpers');

// A fake Google API that records calls, so the Drive flow can be tested offline.
function fakeGoogle() {
  const files = new Map();
  let n = 0;
  const calls = [];
  const json = (obj, status = 200, headers = {}) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...headers } });
  const fetch = async (url, opts = {}) => {
    const u = new URL(url);
    calls.push(`${opts.method || 'GET'} ${u.pathname}`);
    if (u.pathname === '/token') {
      const body = new URLSearchParams(String(opts.body));
      if (body.get('grant_type') === 'authorization_code') {
        const idToken = 'x.' + Buffer.from(JSON.stringify({ email: 'owner@gmail.com' })).toString('base64url') + '.y';
        return json({ access_token: 'at1', refresh_token: 'rt1', expires_in: 3600, id_token: idToken });
      }
      return json({ access_token: 'at2', expires_in: 3600 });
    }
    if (u.pathname === '/revoke') return json({});
    if (!u.pathname.startsWith('/session/')) assert.match(opts.headers.Authorization || '', /^Bearer at/);
    if (u.pathname === '/drive/files' && (opts.method || 'GET') === 'GET') {
      const q = u.searchParams.get('q');
      const parent = /'([^']+)' in parents/.exec(q)?.[1];
      const name = /name = '([^']+)'/.exec(q)?.[1];
      const list = [...files.values()].filter((f) => (!name || f.name === name) && (f.parents || ['root'])[0] === parent);
      return json({ files: list });
    }
    if (u.pathname === '/drive/files' && opts.method === 'POST') {
      const meta = JSON.parse(opts.body);
      const id = 'f' + ++n;
      files.set(id, { id, ...meta, parents: meta.parents || ['root'] });
      return json({ id });
    }
    if (u.pathname.startsWith('/drive/files/')) {
      const id = u.pathname.split('/').pop();
      if (opts.method === 'DELETE') return files.delete(id) ? new Response(null, { status: 204 }) : json({ error: { message: 'not found' } }, 404);
      if (u.searchParams.get('alt') === 'media') return new Response(files.get(id).content);
      return json({ id, trashed: false });
    }
    if (u.pathname === '/upload/files' && opts.method === 'POST') {
      const meta = JSON.parse(opts.body);
      const id = 'f' + ++n;
      files.set(id, { id, ...meta, createdTime: new Date().toISOString() });
      return json({}, 200, { location: 'https://g.test/session/' + id });
    }
    if (u.pathname.startsWith('/session/')) {
      const id = u.pathname.split('/').pop();
      files.get(id).content = Buffer.from(opts.body);
      files.get(id).size = String(opts.body.length);
      return json({ id, name: files.get(id).name });
    }
    return json({ error: { message: 'unexpected ' + url } }, 500);
  };
  return {
    files,
    calls,
    options: { fetch, authUrl: 'https://g.test/auth', tokenUrl: 'https://g.test/token', revokeUrl: 'https://g.test/revoke', apiUrl: 'https://g.test/drive', uploadUrl: 'https://g.test/upload' },
  };
}

let t;
after(() => t && t.close());

test('connect Google Drive, back up into Beauty Parlour/Backups, and restore from Drive', async () => {
  const g = fakeGoogle();
  t = await startApp({ google: g.options });
  const owner = await setupOwner(t);
  assert.equal((await owner.post('/api/drive/connect')).status, 400); // no credentials yet
  assert.equal((await owner.post('/api/drive/credentials', { clientId: '123-abc.apps.googleusercontent.com', clientSecret: 's3cret' })).status, 200);
  const { url } = (await owner.post('/api/drive/connect')).data;
  const state = new URL(url).searchParams.get('state');
  assert.match(new URL(url).searchParams.get('scope'), /drive\.file/);

  const cb = await owner.get(`/api/drive/callback?state=${state}&code=abc`);
  assert.equal(cb.status, 302);
  assert.match(cb.headers.get('location'), /drive=connected/);
  const status = (await owner.get('/api/drive/status')).data;
  assert.equal(status.connected, true);
  assert.equal(status.account, 'owner@gmail.com');
  const names = [...g.files.values()].map((f) => f.name).sort();
  assert.deepEqual(names, ['Backups', 'Beauty Parlour', 'Exports', 'Receipts', 'Reports']);

  // Secrets are encrypted at rest and never returned to the browser.
  const raw = t.ctx.db().prepare("SELECT value FROM business_settings WHERE key = 'drive_refresh_token'").get().value;
  assert.match(raw, /^enc:v1:/);
  const settings = (await owner.get('/api/settings')).data;
  assert.equal(settings.drive_refresh_token, undefined);
  assert.equal(settings.drive_refresh_token_set, '1');

  await owner.post('/api/customers', { fullName: 'Before Backup', phone: '4165550001' });
  const b = await owner.post('/api/backups');
  assert.equal(b.data.driveStatus, 'uploaded', b.data.error);
  const backupsFolder = [...g.files.values()].find((f) => f.name === 'Backups').id;
  const uploaded = [...g.files.values()].find((f) => f.name === b.data.filename);
  assert.equal(uploaded.parents[0], backupsFolder);

  assert.equal((await owner.post('/api/export/drive')).status, 200);
  assert.equal((await owner.post('/api/reports/sales/drive', {})).status, 200);

  await owner.post('/api/customers', { fullName: 'After Backup', phone: '4165550002' });
  const list = (await owner.get('/api/drive/backups')).data;
  assert.equal(list.length, 1);
  const r = await owner.post(`/api/drive/backups/${list[0].id}/restore`, { confirm: 'RESTORE' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await owner.get('/api/customers/search?q=after backup')).data.length, 0);
  assert.equal((await owner.get('/api/customers/search?q=before backup')).data.length, 1);

  // Old automatic backups are removed from Drive as well as this computer.
  const old = new Date(Date.now() - 60 * 86400000).toISOString();
  g.files.set('fold', { id: 'fold', name: 'salon-backup-old-auto.db', parents: [backupsFolder] });
  t.ctx.db().prepare("INSERT INTO backups (filename, kind, size_bytes, status, drive_status, drive_file_id, created_at, updated_at) VALUES ('salon-backup-old-auto.db', 'auto', 1, 'success', 'uploaded', 'fold', ?, ?)").run(old, old);
  await t.ctx.backups.prune();
  assert.equal(g.files.has('fold'), false);
  assert.equal(t.ctx.db().prepare("SELECT drive_file_id FROM backups WHERE filename = 'salon-backup-old-auto.db'").get().drive_file_id, null);

  assert.equal((await owner.post('/api/drive/disconnect')).status, 200);
  assert.equal((await owner.get('/api/drive/status')).data.connected, false);
});

test('a forged Drive callback without a valid state is rejected', async () => {
  const owner = t.client();
  await owner.post('/api/auth/login', { username: 'kirti', password: 'Secret-pass-1' });
  const cb = await owner.get('/api/drive/callback?state=forged&code=abc');
  assert.match(cb.headers.get('location'), /drive=error/);
});

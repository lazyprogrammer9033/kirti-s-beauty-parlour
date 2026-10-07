'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../server/app');

// Starts a fresh app on a random port with its own temp data folder.
async function startApp(options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'salon-test-'));
  const app = createApp({ dataDir, scheduler: false, ...options });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const close = async () => {
    await new Promise((r) => server.close(r));
    app.locals.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  };
  return { app, ctx: app.locals.ctx, base, dataDir, close, client: () => new Client(base) };
}

// Minimal cookie-keeping HTTP client.
class Client {
  constructor(base) {
    this.base = base;
    this.cookie = '';
  }
  async req(method, url, body, headers = {}) {
    const isBuf = Buffer.isBuffer(body);
    const res = await fetch(this.base + url, {
      method,
      redirect: 'manual',
      headers: {
        ...(body !== undefined && !isBuf ? { 'Content-Type': 'application/json' } : {}),
        ...(isBuf ? { 'Content-Type': 'application/octet-stream' } : {}),
        ...(method !== 'GET' ? { 'X-Salon-Request': '1' } : {}),
        ...(this.cookie ? { Cookie: this.cookie } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : isBuf ? body : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, data, headers: res.headers };
  }
  get(u, h) {
    return this.req('GET', u, undefined, h);
  }
  post(u, b, h) {
    return this.req('POST', u, b ?? {}, h);
  }
  put(u, b) {
    return this.req('PUT', u, b);
  }
}

async function setupOwner(t) {
  const c = t.client();
  const r = await c.post('/api/auth/setup', { displayName: 'Kirti', username: 'kirti', password: 'Secret-pass-1', businessName: "Kirti's Beauty Parlour" });
  if (r.status !== 200) throw new Error('setup failed ' + JSON.stringify(r.data));
  return c;
}

module.exports = { startApp, setupOwner, Client };

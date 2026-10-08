'use strict';

const assert = require('node:assert/strict');

// A fake Google Calendar that keeps events per calendar, per account.
function fakeCalendar() {
  const events = new Map(); // `${calendar}/${id}` -> event
  let n = 0;
  let account = 'sharma.kirti56@gmail.com';
  let down = false;
  const calls = [];
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
  const fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const method = opts.method || 'GET';
    calls.push(`${method} ${u.pathname}`);
    if (u.pathname === '/token') {
      const body = new URLSearchParams(String(opts.body));
      if (body.get('grant_type') === 'authorization_code') {
        const idToken = 'x.' + Buffer.from(JSON.stringify({ email: account })).toString('base64url') + '.y';
        return json({ access_token: 'at-' + account, refresh_token: 'rt-' + account, expires_in: 3600, id_token: idToken, scope: 'https://www.googleapis.com/auth/calendar.events openid email' });
      }
      return json({ access_token: 'at-refresh', expires_in: 3600 });
    }
    if (u.pathname === '/revoke') return json({});
    if (down) throw new TypeError('fetch failed', { cause: new Error('ENOTFOUND') });
    assert.match(opts.headers.Authorization || '', /^Bearer at-/);
    if (u.pathname === '/cal/users/me/calendarList') {
      return json({ items: [{ id: account, summary: account, primary: true }, { id: 'salon@group.calendar.google.com', summary: 'Salon bookings' }] });
    }
    const m = /^\/cal\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(u.pathname);
    if (m) {
      const cal = decodeURIComponent(m[1]);
      const key = (id) => `${cal}/${id}`;
      if (method === 'POST') {
        const id = 'ev' + ++n;
        events.set(key(id), { id, ...JSON.parse(opts.body) });
        return json({ id });
      }
      const id = decodeURIComponent(m[2]);
      if (!events.has(key(id))) return json({ error: { message: 'Not Found' } }, 404);
      if (method === 'PUT') {
        events.set(key(id), { id, ...JSON.parse(opts.body) });
        return json({ id });
      }
      if (method === 'DELETE') {
        events.delete(key(id));
        return new Response(null, { status: 204 });
      }
    }
    return json({ error: { message: 'unexpected ' + method + ' ' + url } }, 500);
  };
  return {
    events,
    calls,
    setAccount: (a) => (account = a),
    setDown: (d) => (down = d),
    inCalendar: (cal) => [...events.entries()].filter(([k]) => k.startsWith(cal + '/')).map(([, v]) => v),
    options: { fetch, authUrl: 'https://g.test/auth', tokenUrl: 'https://g.test/token', revokeUrl: 'https://g.test/revoke', apiUrl: 'https://g.test/drive', uploadUrl: 'https://g.test/upload', calendarUrl: 'https://g.test/cal' },
  };
}

module.exports = { fakeCalendar };

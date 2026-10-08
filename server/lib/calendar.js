'use strict';

const crypto = require('crypto');
const { nowIso } = require('./time');

// calendar.events lets the app add and change events; calendarlist.readonly lets
// the owner pick which of her calendars bookings go into. Nothing else is read.
const SCOPES = 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly openid email';
const ACCOUNT_KEYS = ['calendar_refresh_token', 'calendar_account_email', 'calendar_connected_at', 'calendar_id', 'calendar_name'];
const ACTIVE = ['booked', 'confirmed', 'completed'];
const TIMEOUT_MS = 10000;

function calendarError(message, status = 400) {
  return Object.assign(new Error(message), { status, expose: true });
}

// Copies appointments into the owner's Google Calendar (one way: app -> calendar).
// It is a separate Google sign-in from Drive backups, so the calendar can live in
// a different Google account, but it uses the same Google app credentials.
class CalendarService {
  constructor(ctx, opts = {}) {
    this.ctx = ctx;
    this.authUrl = opts.authUrl || 'https://accounts.google.com/o/oauth2/v2/auth';
    this.tokenUrl = opts.tokenUrl || 'https://oauth2.googleapis.com/token';
    this.revokeUrl = opts.revokeUrl || 'https://oauth2.googleapis.com/revoke';
    this.apiUrl = opts.calendarUrl || 'https://www.googleapis.com/calendar/v3';
    this.fetch = opts.fetch || ((...a) => fetch(...a));
    this.pendingStates = new Map();
    this.accessToken = null;
    this.accessTokenExpires = 0;
    this.syncing = null;
  }

  credentials() {
    return this.ctx.drive.credentials();
  }

  isConfigured() {
    const c = this.credentials();
    return !!(c.clientId && c.clientSecret);
  }

  isConnected() {
    return this.isConfigured() && !!this.ctx.settings.get('calendar_refresh_token');
  }

  calendarId() {
    return this.ctx.settings.get('calendar_id') || 'primary';
  }

  status() {
    const s = this.ctx.settings;
    const counts = this.ctx.db().prepare(`SELECT SUM(sync_status = 'pending') AS pending, SUM(sync_status = 'failed') AS failed FROM appointments`).get();
    const lastError = this.ctx.db().prepare(`SELECT sync_error AS error FROM appointments WHERE sync_status = 'failed' ORDER BY updated_at DESC LIMIT 1`).get();
    return {
      configured: this.isConfigured(),
      connected: this.isConnected(),
      account: s.get('calendar_account_email') || null,
      connectedAt: s.get('calendar_connected_at') || null,
      calendarId: this.isConnected() ? this.calendarId() : null,
      calendarName: s.get('calendar_name') || null,
      pending: counts.pending || 0,
      failed: counts.failed || 0,
      lastError: lastError ? lastError.error : null,
    };
  }

  hasState(state) {
    return this.pendingStates.has(state);
  }

  beginAuth(userId, redirectUri, loginHint) {
    if (!this.isConfigured()) throw calendarError('Set up the Google app first (Settings › Backup & Data › Google Drive).');
    const state = crypto.randomBytes(24).toString('base64url');
    this.pendingStates.set(state, { userId, redirectUri, expires: Date.now() + 10 * 60 * 1000 });
    const params = new URLSearchParams({
      client_id: this.credentials().clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: SCOPES,
      access_type: 'offline',
      // select_account always shows the account chooser, so a different Google account can be picked.
      prompt: 'select_account consent',
      state,
    });
    if (loginHint) params.set('login_hint', loginHint);
    return `${this.authUrl}?${params}`;
  }

  async completeAuth(state, code) {
    const pending = this.pendingStates.get(state);
    this.pendingStates.delete(state);
    if (!pending || pending.expires < Date.now()) throw calendarError('The Google sign-in link expired. Please try connecting again.');
    const { clientId, clientSecret } = this.credentials();
    const res = await this.fetch(this.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: pending.redirectUri, grant_type: 'authorization_code' }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const tok = await res.json();
    if (!res.ok || !tok.refresh_token) throw calendarError('Google did not grant access: ' + (tok.error_description || tok.error || 'no refresh token'));
    const granted = String(tok.scope || SCOPES);
    if (!granted.includes('calendar.events')) throw calendarError('Please tick the box that lets the app see and edit calendar events, then try again.');
    let email = null;
    if (tok.id_token) {
      try {
        email = JSON.parse(Buffer.from(tok.id_token.split('.')[1], 'base64url').toString('utf8')).email || null;
      } catch {
        /* ignore */
      }
    }
    // Switching accounts: take this salon's future bookings out of the old calendar first.
    if (this.isConnected()) await this.clearFutureEvents();
    const s = this.ctx.settings;
    s.set('calendar_refresh_token', tok.refresh_token, pending.userId);
    s.set('calendar_account_email', email || '', pending.userId);
    s.set('calendar_connected_at', nowIso(), pending.userId);
    s.set('calendar_id', 'primary', pending.userId);
    s.set('calendar_name', email || 'Main calendar', pending.userId);
    this.accessToken = tok.access_token;
    this.accessTokenExpires = Date.now() + (Number(tok.expires_in || 3600) - 60) * 1000;
    this.markUpcomingPending();
    this.syncPending().catch(() => {});
    return { userId: pending.userId, email };
  }

  async disconnect(userId) {
    if (this.isConnected()) await this.clearFutureEvents();
    const token = this.ctx.settings.get('calendar_refresh_token');
    if (token) {
      try {
        await this.fetch(this.revokeUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }), signal: AbortSignal.timeout(TIMEOUT_MS) });
      } catch {
        /* revocation is best effort */
      }
    }
    for (const k of ACCOUNT_KEYS) this.ctx.settings.set(k, '', userId);
    this.ctx.db().prepare('UPDATE appointments SET google_event_id = NULL, google_calendar_id = NULL, sync_status = NULL, sync_error = NULL').run();
    this.accessToken = null;
  }

  async token() {
    if (!this.isConnected()) throw calendarError('Google Calendar is not connected. The owner can connect it in Settings › Appointments.');
    if (this.accessToken && Date.now() < this.accessTokenExpires) return this.accessToken;
    const { clientId, clientSecret } = this.credentials();
    const res = await this.fetch(this.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: this.ctx.settings.get('calendar_refresh_token'), grant_type: 'refresh_token' }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const tok = await res.json();
    if (!res.ok) throw calendarError('Google Calendar access has expired or was removed. Please reconnect it in Settings › Appointments. (' + (tok.error || res.status) + ')', 502);
    this.accessToken = tok.access_token;
    this.accessTokenExpires = Date.now() + (Number(tok.expires_in || 3600) - 60) * 1000;
    return this.accessToken;
  }

  async api(method, path, json) {
    const token = await this.token();
    const res = await this.fetch(this.apiUrl + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(json ? { 'Content-Type': 'application/json' } : {}) },
      body: json ? JSON.stringify(json) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      let detail = '';
      try {
        detail = (await res.json()).error?.message || '';
      } catch {
        /* ignore */
      }
      const e = calendarError(`Google Calendar request failed (${res.status}) ${detail}`.trim(), 502);
      e.googleStatus = res.status;
      throw e;
    }
    return res.status === 204 ? null : res.json();
  }

  async listCalendars() {
    const out = await this.api('GET', '/users/me/calendarList?minAccessRole=writer&maxResults=100');
    return (out.items || []).map((c) => ({ id: c.id, name: c.summaryOverride || c.summary || c.id, primary: !!c.primary }));
  }

  // Moves this salon's upcoming bookings from the old calendar into the new one.
  async setCalendar(id, userId) {
    const cal = (await this.listCalendars()).find((c) => c.id === id || (id === 'primary' && c.primary));
    if (!cal) throw calendarError('That calendar was not found, or you cannot add events to it.');
    const newId = cal.primary ? 'primary' : cal.id;
    if (newId !== this.calendarId()) await this.clearFutureEvents();
    this.ctx.settings.set('calendar_id', newId, userId);
    this.ctx.settings.set('calendar_name', cal.name, userId);
    this.markUpcomingPending();
    await this.syncPending();
    return { id: newId, name: cal.name };
  }

  // Deletes this salon's future events from whatever calendar they are in now.
  async clearFutureEvents() {
    const db = this.ctx.db();
    const rows = db.prepare('SELECT id, google_event_id, google_calendar_id FROM appointments WHERE google_event_id IS NOT NULL AND start_at >= ?').all(nowIso());
    for (const r of rows) {
      try {
        await this.api('DELETE', `/calendars/${encodeURIComponent(r.google_calendar_id || 'primary')}/events/${encodeURIComponent(r.google_event_id)}`);
      } catch (e) {
        if (![404, 410].includes(e.googleStatus)) console.warn('Could not remove calendar event:', e.message);
      }
      db.prepare('UPDATE appointments SET google_event_id = NULL, google_calendar_id = NULL WHERE id = ?').run(r.id);
    }
  }

  markUpcomingPending() {
    if (!this.isConnected()) return;
    this.ctx.db().prepare(`UPDATE appointments SET sync_status = 'pending', sync_error = NULL
      WHERE COALESCE(end_at, start_at) >= ? AND (status IN ('booked','confirmed','completed') OR google_event_id IS NOT NULL)`).run(nowIso());
  }

  // Called after every change to a booking. Never throws: a failure is recorded
  // on the appointment and retried by the timer.
  async syncAppointment(id) {
    const db = this.ctx.db();
    if (!this.isConnected()) {
      db.prepare('UPDATE appointments SET sync_status = NULL, sync_error = NULL WHERE id = ?').run(id);
      return null;
    }
    db.prepare("UPDATE appointments SET sync_status = 'pending' WHERE id = ?").run(id);
    try {
      await this.push(id);
      db.prepare("UPDATE appointments SET sync_status = 'synced', sync_error = NULL WHERE id = ?").run(id);
      return 'synced';
    } catch (e) {
      db.prepare("UPDATE appointments SET sync_status = 'failed', sync_error = ? WHERE id = ?").run(e.name === 'TimeoutError' || e.cause ? 'Could not reach Google. Will try again.' : e.message, id);
      return 'failed';
    }
  }

  async push(id) {
    const db = this.ctx.db();
    const a = db.prepare(`SELECT a.*, c.full_name, c.phone, c.email, c.customer_code FROM appointments a JOIN customers c ON c.id = a.customer_id WHERE a.id = ?`).get(id);
    if (!a) return;
    const calId = this.calendarId();
    const eventPath = (cal, ev) => `/calendars/${encodeURIComponent(cal)}/events/${encodeURIComponent(ev)}`;
    // In a different calendar than the one chosen now: remove the old copy.
    if (a.google_event_id && a.google_calendar_id && a.google_calendar_id !== calId) {
      try {
        await this.api('DELETE', eventPath(a.google_calendar_id, a.google_event_id));
      } catch (e) {
        if (![404, 410].includes(e.googleStatus)) throw e;
      }
      db.prepare('UPDATE appointments SET google_event_id = NULL, google_calendar_id = NULL WHERE id = ?').run(id);
      a.google_event_id = null;
    }
    if (!ACTIVE.includes(a.status)) {
      if (a.google_event_id) {
        try {
          await this.api('DELETE', eventPath(calId, a.google_event_id));
        } catch (e) {
          if (![404, 410].includes(e.googleStatus)) throw e;
        }
        db.prepare('UPDATE appointments SET google_event_id = NULL, google_calendar_id = NULL WHERE id = ?').run(id);
      }
      return;
    }
    const event = this.eventBody(a);
    if (a.google_event_id) {
      try {
        await this.api('PUT', eventPath(calId, a.google_event_id), event);
        return;
      } catch (e) {
        if (![404, 410].includes(e.googleStatus)) throw e;
      }
    }
    const created = await this.api('POST', `/calendars/${encodeURIComponent(calId)}/events`, event);
    db.prepare('UPDATE appointments SET google_event_id = ?, google_calendar_id = ? WHERE id = ?').run(created.id, calId, id);
  }

  eventBody(a) {
    const services = this.ctx.db().prepare(`SELECT s.name FROM appointment_services x JOIN services s ON s.id = x.service_id WHERE x.appointment_id = ? ORDER BY x.id`).all(a.id).map((s) => s.name);
    const tz = this.ctx.settings.timezone();
    const lines = [
      `Customer: ${a.full_name} (${a.customer_code})`,
      `Phone: ${a.phone}`,
      a.email ? `Email: ${a.email}` : null,
      services.length ? `Services: ${services.join(', ')}` : null,
      a.notes ? `Notes: ${a.notes}` : null,
      a.status === 'completed' ? 'Visit completed.' : null,
      '',
      `Booked in ${this.ctx.settings.get('business_name') || 'the salon app'}. Change it in the app, not here: edits made here are replaced.`,
    ].filter((l) => l !== null);
    return {
      summary: `${a.full_name}${services.length ? ' · ' + services.join(', ') : ''}`,
      description: lines.join('\n'),
      start: { dateTime: a.start_at, timeZone: tz },
      end: { dateTime: a.end_at || a.start_at, timeZone: tz },
      status: 'confirmed',
      extendedProperties: { private: { salonAppointmentId: String(a.id) } },
    };
  }

  async syncPending() {
    if (!this.isConnected()) return { synced: 0, failed: 0 };
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      const ids = this.ctx.db().prepare("SELECT id FROM appointments WHERE sync_status IN ('pending','failed') ORDER BY start_at").all().map((r) => r.id);
      let synced = 0;
      let failed = 0;
      for (const id of ids) {
        if ((await this.syncAppointment(id)) === 'synced') synced++;
        else failed++;
      }
      return { synced, failed };
    })();
    try {
      return await this.syncing;
    } finally {
      this.syncing = null;
    }
  }
}

module.exports = { CalendarService, SCOPES };

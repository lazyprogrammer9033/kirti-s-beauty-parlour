'use strict';

const { nowIso } = require('./time');
const { encrypt, decrypt } = require('./secrets');

// Settings whose values are encrypted at rest and never sent to the browser.
const SECRET_KEYS = new Set(['smtp_pass', 'drive_client_secret', 'drive_refresh_token', 'calendar_refresh_token']);

class Settings {
  constructor(holder, key) {
    this.holder = holder;
    this.key = key;
  }

  all() {
    const rows = this.holder.get().prepare('SELECT key, value FROM business_settings').all();
    const out = {};
    for (const r of rows) out[r.key] = SECRET_KEYS.has(r.key) ? decrypt(this.key, r.value) : r.value;
    return out;
  }

  get(key) {
    const row = this.holder.get().prepare('SELECT value FROM business_settings WHERE key = ?').get(key);
    if (!row) return undefined;
    return SECRET_KEYS.has(key) ? decrypt(this.key, row.value) : row.value;
  }

  set(key, value, userId) {
    const now = nowIso();
    const stored = value == null ? '' : SECRET_KEYS.has(key) ? encrypt(this.key, String(value)) : String(value);
    this.holder.get().prepare(`INSERT INTO business_settings (key, value, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
      .run(key, stored, userId || null, now, now);
  }

  // Values safe to show in the browser (secrets replaced with a "set" flag).
  publicView() {
    const all = this.all();
    for (const k of SECRET_KEYS) {
      all[k + '_set'] = all[k] ? '1' : '0';
      delete all[k];
    }
    return all;
  }

  tax() {
    return {
      name: this.get('tax_name') || 'Tax',
      rateBp: Number(this.get('tax_rate_bp') || 0),
      pricesIncludeTax: this.get('prices_include_tax') === '1',
    };
  }

  timezone() {
    return this.get('timezone') || 'America/Toronto';
  }
}

module.exports = { Settings, SECRET_KEYS };

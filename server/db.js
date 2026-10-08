'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const migrations = require('./migrations');
const crypto = require('crypto');
const { nowIso } = require('./lib/time');
const { hashPassword } = require('./lib/secrets');

const REQUIRED_TABLES = ['customers', 'visits', 'invoices', 'invoice_items', 'payments', 'services', 'users'];

// Holds the live connection so a restore can swap the underlying file.
class DbHolder {
  constructor(file, seedOptions = {}) {
    this.file = file;
    this.seedOptions = seedOptions;
    this.conn = null;
  }

  open() {
    if (this.file !== ':memory:') fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.conn = new Database(this.file);
    this.conn.pragma('journal_mode = WAL');
    this.conn.pragma('foreign_keys = ON');
    this.conn.pragma('busy_timeout = 5000');
    this.conn.pragma('synchronous = NORMAL');
    migrate(this.conn);
    seed(this.conn, this.seedOptions);
    return this.conn;
  }

  close() {
    if (this.conn) this.conn.close();
    this.conn = null;
  }

  get() {
    return this.conn;
  }
}

function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const applied = new Set(db.prepare('SELECT id FROM schema_migrations').all().map((r) => r.id));
  for (const m of migrations) {
    if (applied.has(m.id)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(m.id, m.name, nowIso());
    })();
  }
}

const DEFAULT_SETTINGS = {
  business_name: "Kirti's Beauty Parlour",
  business_address: '',
  business_phone: '',
  business_email: '',
  business_website: '',
  business_social: '',
  business_logo: '',
  // '0' opens the app straight away as the owner, with no sign-in screen.
  require_login: '0',
  timezone: 'America/Toronto',
  currency: 'CAD',
  tax_name: 'HST',
  tax_rate_bp: '1300',
  prices_include_tax: '0',
  receipt_footer: 'Thank you for visiting us!\nWe look forward to seeing you again.',
  receipt_show_tax_number: '0',
  tax_number: '',
  staff_can_discount: '1',
  staff_can_custom_charge: '0',
  backup_auto_enabled: '1',
  backup_frequency: 'hourly',
  backup_hour: '22',
  backup_keep_local: '30',
  smtp_host: '',
  smtp_port: '587',
  smtp_user: '',
  smtp_pass: '',
  smtp_from: '',
  appt_default_minutes: '30',
  appt_confirm_email: '1',
  appt_reminder_email: '1',
  appt_reminder_hours: '24',
  // Customer links stay off until the owner sets up the public address.
  public_base_url: '',
  appt_customer_links: '0',
  appt_open_time: '10:00',
  appt_close_time: '19:00',
  appt_open_days: '0,1,2,3,4,5,6',
  appt_change_cutoff_hours: '2',
};

// Sample catalogue used by tests and demos. A real salon starts empty and adds
// its own services and prices from the Services screen.
const SAMPLE_SERVICES = [
  ['Hair', [['Haircut', 4500, 45], ['Hair Styling', 5000, 45], ['Hair Colour', 12000, 120], ['Highlights', 15000, 150], ['Blow Dry', 3500, 30]]],
  ['Facial', [['Basic Facial', 4000, 45], ['Deep Cleansing Facial', 6000, 60], ['Hydrating Facial', 7000, 60]]],
  ['Waxing', [['Eyebrows', 1000, 10], ['Upper Lip', 800, 10], ['Full Face', 3000, 30], ['Arms', 3500, 30], ['Legs', 5000, 45]]],
  ['Nails', [['Manicure', 3000, 30], ['Pedicure', 4500, 45], ['Gel Nails', 5500, 60]]],
];

function seed(db, { sampleServices = false, requireLogin } = {}) {
  const now = nowIso();
  const roleCount = db.prepare('SELECT COUNT(*) c FROM roles').get().c;
  if (roleCount === 0) {
    const ins = db.prepare('INSERT INTO roles (code, name, created_at, updated_at) VALUES (?, ?, ?, ?)');
    ins.run('owner', 'Owner', now, now);
    ins.run('staff', 'Staff', now, now);
  }
  const insSetting = db.prepare('INSERT OR IGNORE INTO business_settings (key, value, created_at, updated_at) VALUES (?, ?, ?, ?)');
  const defaults = { ...DEFAULT_SETTINGS, ...(requireLogin === undefined ? {} : { require_login: requireLogin ? '1' : '0' }) };
  for (const [k, v] of Object.entries(defaults)) insSetting.run(k, v, now, now);

  // Open access needs someone to act as: create the owner with an unguessable
  // password, which they replace if they later turn sign-in on.
  const openAccess = db.prepare("SELECT value FROM business_settings WHERE key = 'require_login'").get().value === '0';
  if (openAccess && db.prepare('SELECT COUNT(*) c FROM users').get().c === 0) {
    const ownerRole = db.prepare("SELECT id FROM roles WHERE code = 'owner'").get().id;
    db.prepare('INSERT INTO users (username, display_name, password_hash, role_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('kirti', 'Kirti', hashPassword(crypto.randomBytes(32).toString('base64url')), ownerRole, now, now);
  }

  const catCount = db.prepare('SELECT COUNT(*) c FROM service_categories').get().c;
  if (sampleServices && catCount === 0) {
    db.transaction(() => {
      const insCat = db.prepare('INSERT INTO service_categories (name, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?)');
      const insSvc = db.prepare(`INSERT INTO services (category_id, name, price_cents, duration_minutes, taxable, sort_order, created_at, updated_at)
        VALUES (?, ?, ?, ?, 1, ?, ?, ?)`);
      SAMPLE_SERVICES.forEach(([cat, items], ci) => {
        const catId = insCat.run(cat, ci, now, now).lastInsertRowid;
        items.forEach(([name, price, mins], si) => insSvc.run(catId, name, price, mins, si, now, now));
      });
    })();
  }
}

// Validates that a file is a database produced by this application.
function validateBackupFile(file) {
  let db;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    const integrity = db.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') return { ok: false, error: 'Backup file failed the integrity check.' };
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
    const missing = REQUIRED_TABLES.filter((t) => !tables.has(t));
    if (missing.length) return { ok: false, error: 'This file is not a salon backup (missing tables: ' + missing.join(', ') + ').' };
    const counts = {
      customers: db.prepare('SELECT COUNT(*) c FROM customers').get().c,
      invoices: db.prepare('SELECT COUNT(*) c FROM invoices').get().c,
    };
    return { ok: true, counts };
  } catch (e) {
    return { ok: false, error: 'Could not read backup file: ' + e.message };
  } finally {
    if (db) db.close();
  }
}

module.exports = { DbHolder, validateBackupFile, DEFAULT_SETTINGS };

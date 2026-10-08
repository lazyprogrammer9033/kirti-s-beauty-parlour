'use strict';

const { requirePerm, HttpError, str } = require('../lib/http');
const { audit } = require('../lib/audit');
const { can } = require('../lib/auth');
const { toCents } = require('../lib/money');

// Keys the owner may change from the Settings screen, with validation.
const EDITABLE = {
  business_name: (v) => str(v, { required: true, max: 120, label: 'Business name' }),
  business_address: (v) => str(v, { max: 300 }) || '',
  business_phone: (v) => str(v, { max: 40 }) || '',
  business_email: (v) => str(v, { max: 160 }) || '',
  business_website: (v) => str(v, { max: 200 }) || '',
  business_social: (v) => str(v, { max: 300 }) || '',
  business_logo: (v) => {
    const s = String(v || '');
    if (s && !/^data:image\/(png|jpeg|jpg);base64,[A-Za-z0-9+/=]+$/.test(s)) throw new HttpError(400, 'Logo must be a PNG or JPEG image');
    if (s.length > 700000) throw new HttpError(400, 'Logo image is too large (max ~500 KB)');
    return s;
  },
  timezone: (v) => {
    try {
      new Intl.DateTimeFormat('en-CA', { timeZone: String(v) });
    } catch {
      throw new HttpError(400, 'Unknown time zone');
    }
    return String(v);
  },
  tax_name: (v) => str(v, { required: true, max: 20, label: 'Tax name' }),
  tax_rate_bp: (v) => {
    const pct = Number(v);
    if (!Number.isFinite(pct) || pct < 0 || pct > 50) throw new HttpError(400, 'Tax rate must be between 0 and 50%');
    return String(Math.round(pct * 100));
  },
  prices_include_tax: (v) => (v === true || v === '1' || v === 1 ? '1' : '0'),
  tax_number: (v) => str(v, { max: 40 }) || '',
  receipt_show_tax_number: (v) => (v === true || v === '1' || v === 1 ? '1' : '0'),
  receipt_footer: (v) => str(v, { max: 500 }) || '',
  staff_can_discount: (v) => (v === true || v === '1' || v === 1 ? '1' : '0'),
  staff_can_custom_charge: (v) => (v === true || v === '1' || v === 1 ? '1' : '0'),
  backup_auto_enabled: (v) => (v === true || v === '1' || v === 1 ? '1' : '0'),
  backup_frequency: (v) => {
    if (!['hourly', 'daily'].includes(v)) throw new HttpError(400, 'Backup frequency must be hourly or daily');
    return v;
  },
  backup_hour: (v) => {
    const h = Number(v);
    if (!Number.isInteger(h) || h < 0 || h > 23) throw new HttpError(400, 'Backup hour must be 0–23');
    return String(h);
  },
  backup_keep_local: (v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 3 || n > 365) throw new HttpError(400, 'Keep between 3 and 365 backups');
    return String(n);
  },
  app_base_url: (v) => {
    const s = str(v, { max: 200 }) || '';
    if (s && !/^https?:\/\/[^\s/]+(:\d+)?\/?$/.test(s)) throw new HttpError(400, 'App address must look like https://salon.example.com');
    return s.replace(/\/$/, '');
  },
  smtp_host: (v) => str(v, { max: 120 }) || '',
  smtp_port: (v) => {
    const n = Number(v || 587);
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw new HttpError(400, 'Invalid email port');
    return String(n);
  },
  smtp_user: (v) => str(v, { max: 160 }) || '',
  smtp_pass: (v) => String(v || ''),
  smtp_from: (v) => str(v, { max: 160 }) || '',
  appt_default_minutes: (v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 5 || n > 480) throw new HttpError(400, 'Default length must be 5–480 minutes');
    return String(n);
  },
  public_base_url: (v) => {
    const s = str(v, { max: 200 }) || '';
    if (s && !/^https:\/\/[a-z0-9.-]+(:\d+)?\/?$/i.test(s)) throw new HttpError(400, 'The customer page address must start with https://');
    return s.replace(/\/$/, '');
  },
  appt_customer_links: (v) => (v === true || v === '1' || v === 1 ? '1' : '0'),
  appt_open_time: (v) => {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v))) throw new HttpError(400, 'Opening time must look like 10:00');
    return String(v);
  },
  appt_close_time: (v) => {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v))) throw new HttpError(400, 'Closing time must look like 19:00');
    return String(v);
  },
  appt_open_days: (v) => {
    const days = [...new Set(String(Array.isArray(v) ? v.join(',') : v).split(',').filter((x) => x !== '').map(Number))];
    if (days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new HttpError(400, 'Invalid opening days');
    return days.sort().join(',');
  },
  appt_change_cutoff_hours: (v) => {
    const n = Number(v);
    if (![0, 2, 4, 12, 24, 48].includes(n)) throw new HttpError(400, 'Choose how close to the appointment customers can change it');
    return String(n);
  },
  appt_confirm_email: (v) => (v === true || v === '1' || v === 1 ? '1' : '0'),
  appt_reminder_email: (v) => (v === true || v === '1' || v === 1 ? '1' : '0'),
  appt_reminder_hours: (v) => {
    const n = Number(v);
    if (![2, 4, 12, 24, 48].includes(n)) throw new HttpError(400, 'Choose when to send reminders');
    return String(n);
  },
};

// What staff need for billing and receipts; everything else is owner-only.
const STAFF_VISIBLE = ['business_name', 'business_address', 'business_phone', 'business_email', 'business_website', 'business_logo', 'currency',
  'tax_name', 'tax_rate_bp', 'prices_include_tax', 'receipt_footer', 'staff_can_discount', 'staff_can_custom_charge', 'timezone', 'tax_number', 'receipt_show_tax_number',
  'appt_default_minutes', 'appt_confirm_email'];

module.exports = function settingsRoutes(api, ctx) {
  const owner = requirePerm('settings.manage');

  api.get('/settings', (req, res) => {
    const all = ctx.settings.publicView();
    delete all.drive_folders;
    const out = can(req.user, 'settings.manage') ? all : Object.fromEntries(STAFF_VISIBLE.map((k) => [k, all[k]]));
    out.email_configured = ctx.mailer.configured() ? '1' : '0';
    out.calendar_connected = ctx.calendar.isConnected() ? '1' : '0';
    res.json(out);
  });

  api.put('/settings', owner, (req, res) => {
    const before = ctx.settings.all();
    const changed = {};
    const updates = {};
    for (const [k, v] of Object.entries(req.body || {})) {
      if (!EDITABLE[k]) continue;
      if (k === 'smtp_pass' && !v) continue; // blank means "keep existing password"
      updates[k] = EDITABLE[k](v);
    }
    ctx.db().transaction(() => {
      for (const [k, v] of Object.entries(updates)) {
        if ((before[k] ?? '') === v) continue;
        ctx.settings.set(k, v, req.user.id);
        changed[k] = k === 'smtp_pass' || k === 'business_logo' ? '(changed)' : { from: before[k] ?? '', to: v };
      }
    })();
    if (Object.keys(changed).length) {
      audit(ctx.db(), req, changed.tax_rate_bp || changed.prices_include_tax || changed.tax_name ? 'settings.tax_changed' : 'settings.updated', 'settings', null, changed);
    }
    res.json({ ok: true, changed: Object.keys(changed) });
  });

  api.post('/settings/test-email', owner, async (req, res) => {
    const to = str(req.body.to, { required: true, max: 160, label: 'Email' });
    try {
      await ctx.mailer.send({ to, subject: 'Test email from your salon app', text: 'Email is set up correctly. Receipts can now be emailed to customers.' });
    } catch (e) {
      if (e.expose) throw e;
      throw new HttpError(502, 'Could not send: ' + e.message);
    }
    res.json({ ok: true });
  });
};

module.exports.toCents = toCents;

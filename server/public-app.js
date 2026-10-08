'use strict';

const express = require('express');
const { readToken, freeSlots, monthDays, firstFreeDay, bookableDay, lastBookableDay, changeable } = require('./lib/customer-links');
const { getAppointment, emailCustomer, notifySalon } = require('./lib/appointments');
const { audit } = require('./lib/audit');
const { defaultLogo } = require('./lib/brand');
const { bookingRoutes } = require('./public-booking');
const { nowIso, zonedToUtc, isValidYmd, isValidHm, businessDate, localTime } = require('./lib/time');

// The only part of the salon app that is reachable from the internet (through
// a tunnel to its own port). It serves one page per appointment, opened from
// the signed link in the customer's email, where they can confirm, cancel or
// pick a new time. Nothing else in the app is served here.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

class RateLimiter {
  constructor(max = 60, windowMs = 60000) {
    this.max = max;
    this.windowMs = windowMs;
    this.hits = new Map();
  }
  hit(key) {
    const now = Date.now();
    const e = this.hits.get(key);
    if (!e || e.reset < now) {
      this.hits.set(key, { n: 1, reset: now + this.windowMs });
      if (this.hits.size > 5000) for (const [k, v] of this.hits) if (v.reset < now) this.hits.delete(k);
      return true;
    }
    return ++e.n <= this.max;
  }
}

function createPublicApp(ctx) {
  const app = express();
  app.set('trust proxy', 'loopback');
  app.disable('x-powered-by');
  const limiter = new RateLimiter();

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    const ip = req.get('cf-connecting-ip') || req.ip;
    if (!limiter.hit(ip)) return res.status(429).type('text/plain').send('Too many requests. Please try again in a minute.');
    next();
  });
  app.use(express.urlencoded({ extended: false, limit: '4kb' }));

  const salon = () => {
    const s = ctx.settings;
    return { name: s.get('business_name') || 'Beauty Parlour', phone: s.get('business_phone') || '', address: s.get('business_address') || '', logo: s.get('business_logo') || defaultLogo(), tz: s.timezone() };
  };
  const when = (iso, tz) => {
    const d = new Date(iso);
    return `${d.toLocaleDateString('en-CA', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric' })}, ${d.toLocaleTimeString('en-CA', { timeZone: tz, hour: 'numeric', minute: '2-digit' })}`;
  };
  const dayLabel = (ymd) => new Date(ymd + 'T12:00:00Z').toLocaleDateString('en-CA', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
  const timeLabel = (hm) => {
    const [h, m] = hm.split(':').map(Number);
    return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'a.m.' : 'p.m.'}`;
  };

  // A month calendar showing how many times are free each day, then the free
  // times on the chosen day as buttons. link({ date } | { month }) builds the
  // page's own URL; form is the <form ...> tag the time buttons submit with.
  function slotPicker({ query, minutes, ignoreId, link, form, hidden = '', skipTime }) {
    const tz = salon().tz;
    const today = businessDate(new Date(), tz);
    const firstMonth = today.slice(0, 7);
    const lastMonth = lastBookableDay(ctx).slice(0, 7);
    let date = isValidYmd(query.date) && bookableDay(ctx, query.date) ? query.date : null;
    let month = /^\d{4}-\d{2}$/.test(query.month || '') ? query.month : null;
    if (!month) month = (date || firstFreeDay(ctx, minutes, ignoreId) || today).slice(0, 7);
    if (month < firstMonth) month = firstMonth;
    if (month > lastMonth) month = lastMonth;
    const days = monthDays(ctx, month, minutes, ignoreId);
    if (date && date.slice(0, 7) !== month) date = null;
    if (!date) date = (days.find((d) => d.state === 'open') || {}).date || null;
    const shift = (n) => {
      const [y, m] = month.split('-').map(Number);
      const d = new Date(Date.UTC(y, m - 1 + n, 1));
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    };
    const monthName = new Date(month + '-15T12:00:00Z').toLocaleDateString('en-CA', { timeZone: 'UTC', month: 'long', year: 'numeric' });
    const lead = new Date(month + '-01T12:00:00Z').getUTCDay();
    const cell = (d) => {
      const n = Number(d.date.slice(8));
      if (d.state === 'open') return `<a class="d${d.date === date ? ' on' : ''}" href="${esc(link({ date: d.date }))}">${n}<small>${d.free} free</small></a>`;
      return `<span class="d ${d.state}">${n}<small>${d.state === 'full' ? 'Full' : d.state === 'closed' ? 'Closed' : '&nbsp;'}</small></span>`;
    };
    const slots = date ? freeSlots(ctx, date, minutes, ignoreId).filter((t) => !(skipTime && skipTime(date, t))) : [];
    const anyFree = days.some((d) => d.state === 'open');
    return `<div class="mon">${month > firstMonth ? `<a href="${esc(link({ month: shift(-1) }))}" aria-label="Previous month">‹</a>` : '<span>‹</span>'}<b>${esc(monthName)}</b>${month < lastMonth ? `<a href="${esc(link({ month: shift(1) }))}" aria-label="Next month">›</a>` : '<span>›</span>'}</div>
<div class="cal">${['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((w) => `<span class="wd">${w}</span>`).join('')}${'<span></span>'.repeat(lead)}${days.map(cell).join('')}</div>
${date && slots.length ? `<h3>${esc(dayLabel(date))} · ${slots.length} time${slots.length === 1 ? '' : 's'} free</h3>
${form}${hidden}<input type="hidden" name="date" value="${esc(date)}"><div class="times">${slots
  .map((t) => `<button class="chip" type="submit" name="time" value="${t}">${esc(timeLabel(t))}</button>`).join('')}</div></form>`
  : `<div class="note bad">${date && anyFree ? `No free times on ${esc(dayLabel(date))}. Please pick another day.` : 'There are no free times online this month. Try the next month, or call us.'}</div>`}`;
  }

  function page(res, title, body, status = 200) {
    const s = salon();
    const logo = /^data:image\/(png|jpeg|jpg);base64,/.test(s.logo) ? `<img src="${esc(s.logo)}" alt="" class="logo">` : '';
    res.status(status).type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · ${esc(s.name)}</title><meta name="robots" content="noindex">
<style>
:root{--p:#9d4f6a;--ink:#2d1d27;--muted:#8d7983;--line:#eee2e5;--bg:#fbf7f5;--soft:#f6e5ea;--ok:#3f8a68;--okbg:#e5f3ec;--bad:#b9434f;--badbg:#fbe6e8}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 -apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif}
main{max-width:520px;margin:0 auto;padding:24px 16px 40px}.card{background:#fff;border:1px solid var(--line);border-radius:20px;padding:24px}
.brand{text-align:center;margin-bottom:16px}.logo{width:64px;height:64px;object-fit:contain;border-radius:14px;display:block;margin:0 auto 8px}
.name{font-family:Georgia,serif;font-size:22px;color:var(--p)}h1{font-family:Georgia,serif;font-weight:normal;font-size:28px;margin:0 0 8px}
.box{background:var(--soft);border-radius:14px;padding:14px 18px;margin:16px 0}.box dt{color:var(--muted);font-size:14px}.box dd{margin:0 0 8px;font-weight:600}
.btn{display:block;width:100%;text-align:center;padding:14px 18px;border-radius:999px;font-weight:600;font-size:16px;text-decoration:none;border:1px solid var(--p);background:#fff;color:var(--p);margin:10px 0;cursor:pointer;font-family:inherit}
.btn.primary{background:var(--p);color:#fff}.btn.danger{border-color:var(--bad);color:var(--bad)}
.note{padding:12px 16px;border-radius:14px;margin:12px 0}.ok{background:var(--okbg);color:var(--ok)}.bad{background:var(--badbg);color:var(--bad)}
.muted{color:var(--muted);font-size:14px}.days,.times{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0 16px}
.chip{padding:10px 14px;border-radius:999px;border:1px solid var(--line);background:#fff;color:var(--ink);text-decoration:none;font-size:15px;font-family:inherit;cursor:pointer}
.chip.on{background:var(--ink);color:#fff;border-color:var(--ink)}
.mon{display:flex;align-items:center;justify-content:space-between;margin:16px 0 8px}.mon b{font-size:17px}.mon a,.mon span{padding:6px 12px;border-radius:999px;text-decoration:none;color:var(--p);font-size:20px}.mon span{color:var(--line)}
.cal{display:grid;grid-template-columns:repeat(7,1fr);gap:4px;margin-bottom:8px}.cal .wd{text-align:center;font-size:12px;color:var(--muted)}
.cal .d{text-align:center;padding:6px 0;border-radius:10px;border:1px solid transparent;color:var(--muted);font-size:15px;text-decoration:none;min-width:0}
.cal .d small{display:block;font-size:10px;line-height:1.2;white-space:nowrap;overflow:hidden}.cal a.d{border-color:var(--line);color:var(--ink);background:#fff}.cal a.d small{color:var(--ok)}
.cal a.d.on{background:var(--ink);border-color:var(--ink);color:#fff}.cal a.d.on small{color:#fff}.cal .d.past{opacity:.4}
.cat{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:18px 0 6px}
.svc{display:flex;align-items:center;gap:12px;padding:12px 14px;border:1px solid var(--line);border-radius:14px;margin:8px 0;cursor:pointer}
.svc input{width:20px;height:20px;accent-color:var(--p)}.grow{flex:1}
.fld{display:block;font-size:14px;color:var(--muted);margin:12px 0}.fld input,.fld textarea{display:block;width:100%;margin-top:4px;padding:12px 14px;border:1px solid var(--line);border-radius:12px;font:inherit;color:var(--ink);background:#fff}
.hp{position:absolute;left:-9999px}footer{text-align:center;margin-top:18px}
</style></head><body><main><div class="brand">${logo}<div class="name">${esc(s.name)}</div></div><div class="card">${body}</div>
<footer class="muted">${[s.address, s.phone].filter(Boolean).map(esc).join(' · ')}</footer></main></body></html>`);
  }

  const details = (a, tz) => `<dl class="box"><dt>When</dt><dd>${esc(when(a.startAt, tz))}</dd>
${a.services.length ? `<dt>Services</dt><dd>${esc(a.services.map((x) => x.name).join(', '))}</dd>` : ''}</dl>`;
  const callUs = () => (salon().phone ? `<a class="btn" href="tel:${esc(salon().phone.replace(/[^\d+]/g, ''))}">Call ${esc(salon().phone)}</a>` : '');
  const bookAnother = () => (ctx.settings.get('appt_online_booking') === '1' ? '<a class="btn" href="/book">Book another appointment</a>' : '');
  const STATUS = { confirmed: 'Confirmed', completed: 'Completed', cancelled: 'Cancelled', no_show: 'Missed' };

  // Every page starts by checking the link and loading the appointment.
  function load(req, res) {
    const id = readToken(ctx, req.params.token);
    const a = id && getAppointment(ctx.db(), id);
    if (!a) {
      page(res, 'Link not valid', `<h1>This link has expired</h1><p>Please contact us to make changes to your appointment.</p>${callUs()}`, 404);
      return null;
    }
    a.firstName = String(a.customerName).trim().split(/\s+/)[0];
    return a;
  }

  // Runs after the page has answered, so a slow calendar or mail server never
  // leaves the customer waiting (and tapping again).
  function inBackground(fn) {
    Promise.resolve().then(fn).catch((e) => console.error('After customer change:', e.message));
  }

  async function afterCustomerChange(a, action, details2) {
    await ctx.calendar.syncAppointment(a.id).catch(() => {});
    const fresh = getAppointment(ctx.db(), a.id);
    await notifySalon(ctx, fresh, action, details2).catch((e) => console.error('Could not email the salon:', e.message));
    return fresh;
  }

  const customerReq = (req) => ({ user: null, ip: req.get('cf-connecting-ip') || req.ip });

  app.get('/a/:token', (req, res) => {
    const a = load(req, res);
    if (!a) return;
    const tz = salon().tz;
    if (!['booked', 'confirmed'].includes(a.status)) {
      return page(res, 'Your appointment', `<h1>Hi ${esc(a.firstName)}</h1>${details(a, tz)}<div class="note ${a.status === 'cancelled' ? 'bad' : 'ok'}">This appointment is ${esc((STATUS[a.status] || a.status).toLowerCase())}.</div>${bookAnother()}${callUs()}`);
    }
    const can = changeable(ctx, a);
    page(res, 'Your appointment', `<h1>Hi ${esc(a.firstName)}</h1>${req.query.booked ? '<div class="note ok">You’re booked! We look forward to seeing you.</div>' : req.query.moved ? '<div class="note ok">Done! Your appointment has moved to the time below. We’ve emailed you the details.</div>' : '<p>Here is your appointment.</p>'}${details(a, tz)}
${a.status === 'confirmed' ? '<div class="note ok">You have confirmed this appointment. Thank you!</div>' : `<form method="post" action="${esc(req.params.token)}/confirm"><button class="btn primary" type="submit">Confirm</button></form>`}
${can ? `<a class="btn" href="${esc(req.params.token)}/change">Change time</a><a class="btn danger" href="${esc(req.params.token)}/cancel">Cancel</a>` : '<p class="muted">It’s too close to your appointment to change it online. Please call us.</p>'}
${bookAnother()}${callUs()}`);
  });

  // Already confirmed (e.g. the Back button after confirming): show the appointment, not the question again.
  app.get('/a/:token/confirm', (req, res) => {
    const a = load(req, res);
    if (!a) return;
    if (a.status !== 'booked') return res.redirect(303, '../' + req.params.token);
    page(res, 'Confirm', `<h1>Confirm your appointment</h1>${details(a, salon().tz)}<form method="post"><button class="btn primary" type="submit">Yes, I’ll be there</button></form><a class="btn" href="../${esc(req.params.token)}">Back</a>`);
  });

  app.post('/a/:token/confirm', async (req, res) => {
    const a = load(req, res);
    if (!a) return;
    if (a.status === 'booked') {
      ctx.db().prepare("UPDATE appointments SET status = 'confirmed', updated_at = ? WHERE id = ? AND status = 'booked'").run(nowIso(), a.id);
      audit(ctx.db(), customerReq(req), 'appointment.confirmed', 'appointment', a.id, { by: 'customer' });
      inBackground(() => afterCustomerChange(a, 'confirmed'));
    }
    res.redirect(303, '../' + req.params.token);
  });

  app.get('/a/:token/cancel', (req, res) => {
    const a = load(req, res);
    if (!a) return;
    if (!changeable(ctx, a)) return res.redirect(303, '../' + req.params.token);
    page(res, 'Cancel', `<h1>Cancel your appointment?</h1>${details(a, salon().tz)}<form method="post"><button class="btn danger" type="submit">Yes, cancel it</button></form><a class="btn" href="../${esc(req.params.token)}">Keep my appointment</a>`);
  });

  app.post('/a/:token/cancel', async (req, res) => {
    const a = load(req, res);
    if (!a) return;
    if (changeable(ctx, a)) {
      ctx.db().prepare("UPDATE appointments SET status = 'cancelled', updated_at = ? WHERE id = ? AND status IN ('booked','confirmed')").run(nowIso(), a.id);
      audit(ctx.db(), customerReq(req), 'appointment.cancelled', 'appointment', a.id, { by: 'customer' });
      inBackground(async () => {
        const fresh = await afterCustomerChange(a, 'cancelled');
        await emailCustomer(ctx, fresh, 'cancelled').catch(() => {});
      });
    }
    res.redirect(303, '../' + req.params.token);
  });

  app.get('/a/:token/change', (req, res) => {
    const a = load(req, res);
    if (!a) return;
    if (!changeable(ctx, a)) return res.redirect(303, '../' + req.params.token);
    const minutes = a.durationMinutes || Math.round((Date.parse(a.endAt) - Date.parse(a.startAt)) / 60000) || 30;
    const tz = salon().tz;
    const current = businessDate(new Date(a.startAt), tz);
    const currentTime = localTime(new Date(a.startAt), tz);
    const query = req.query.date || req.query.month ? req.query : { date: current };
    page(res, 'Change time', `<h1>Pick a new time</h1><p class="muted">Now: ${esc(when(a.startAt, tz))} · ${minutes} min</p>
${slotPicker({ query, minutes, ignoreId: a.id, link: (p) => '?' + new URLSearchParams(p), form: '<form method="post">', skipTime: (d, t) => d === current && t === currentTime })}
<a class="btn" href="../${esc(req.params.token)}">Back</a>${callUs()}`);
  });

  app.post('/a/:token/change', async (req, res) => {
    const a = load(req, res);
    if (!a) return;
    const back = () => res.redirect(303, '../' + req.params.token);
    if (!changeable(ctx, a)) return back();
    const { date, time } = req.body || {};
    const minutes = a.durationMinutes || Math.round((Date.parse(a.endAt) - Date.parse(a.startAt)) / 60000) || 30;
    if (!isValidYmd(date) || !isValidHm(time) || !freeSlots(ctx, date, minutes, a.id).includes(time)) {
      return page(res, 'Change time', `<h1>That time was just taken</h1><p>Please pick another time.</p><a class="btn primary" href="change?date=${esc(isValidYmd(date) ? date : '')}">See free times</a>`, 409);
    }
    const start = zonedToUtc(date, time, salon().tz);
    // Same time again (a second tap, or an old page): nothing to change or email.
    if (start.toISOString() === new Date(a.startAt).toISOString()) return back();
    const end = new Date(start.getTime() + minutes * 60000);
    const from = a.startAt;
    const now = nowIso();
    ctx.db().prepare("UPDATE appointments SET start_at = ?, end_at = ?, duration_minutes = ?, reminder_sent_at = NULL, reminders_sent = NULL, scheduled_at = ?, updated_at = ? WHERE id = ? AND status IN ('booked','confirmed')")
      .run(start.toISOString(), end.toISOString(), minutes, now, now, a.id);
    audit(ctx.db(), customerReq(req), 'appointment.rescheduled', 'appointment', a.id, { by: 'customer', from, to: start.toISOString() });
    res.redirect(303, '../' + req.params.token + '?moved=1');
    inBackground(async () => {
      const fresh = await afterCustomerChange(a, 'rescheduled', { from });
      await emailCustomer(ctx, fresh, 'updated').catch(() => {});
    });
  });

  bookingRoutes(app, ctx, { page, esc, salonTz: () => salon().tz, timeLabel, slotPicker, RateLimiter });

  app.get('/healthz', (req, res) => res.type('text/plain').send('ok'));
  app.use((req, res) => page(res, 'Not found', '<h1>Page not found</h1><p>Please use the link from your appointment email.</p>', 404));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    page(res, 'Something went wrong', '<h1>Something went wrong</h1><p>Please try again, or call us.</p>', 500);
  });
  return app;
}

module.exports = { createPublicApp };

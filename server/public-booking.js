'use strict';

const { freeSlots, makeToken } = require('./lib/customer-links');
const { getAppointment, emailCustomer, notifySalon } = require('./lib/appointments');
const { nextCustomerCode } = require('./lib/codes');
const { normalizePhone, formatPhone } = require('./lib/phone');
const { audit } = require('./lib/audit');
const { nowIso, zonedToUtc, isValidYmd, isValidHm } = require('./lib/time');

// "Book now" for anyone with the link (Instagram bio, Google profile):
// pick services -> pick a free time -> name and phone. The booking lands in
// the app and the calendar like any other, and the salon gets an email.
// Off until the owner turns on online booking in Settings › Appointments.

function bookingRoutes(app, ctx, { page, esc, salonTz, timeLabel, slotPicker, RateLimiter }) {
  const bookLimiter = new RateLimiter(5, 60 * 60 * 1000); // 5 bookings an hour per visitor
  const enabled = () => ctx.settings.get('appt_online_booking') === '1' && !!ctx.settings.get('public_base_url');

  function catalogue() {
    const rows = ctx.db().prepare(`SELECT s.id, s.name, s.price_cents AS priceCents, s.duration_minutes AS durationMinutes, c.name AS category
      FROM services s JOIN service_categories c ON c.id = s.category_id WHERE s.active = 1 AND c.active = 1 ORDER BY c.sort_order, c.name, s.sort_order, s.name`).all();
    return rows;
  }
  const money = (c) => '$' + (c / 100).toFixed(2);

  // ?s=1,2,3 -> chosen services (only active ones) and the total length.
  function chosen(q) {
    const ids = String(q || '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 10);
    const all = catalogue();
    const services = ids.map((id) => all.find((s) => s.id === id)).filter(Boolean);
    const minutes = services.reduce((t, s) => t + (s.durationMinutes || 0), 0) || Number(ctx.settings.get('appt_default_minutes') || 30);
    return { services, minutes, key: services.map((s) => s.id).join(',') };
  }

  const closed = (res) => page(res, 'Book', `<h1>Online booking is closed</h1><p>Please call us to book.</p>`, 404);

  app.get('/book', (req, res) => {
    if (!enabled()) return closed(res);
    const all = catalogue();
    if (!all.length) return page(res, 'Book', '<h1>Book an appointment</h1><p>Please call us to book.</p>');
    const groups = [...new Set(all.map((s) => s.category))];
    const picked = new Set(chosen(req.query.s).services.map((s) => s.id));
    page(res, 'Book', `<h1>Book an appointment</h1><p class="muted">Choose one or more services.</p>
<form method="get" action="/book/time">${groups.map((g) => `<h3 class="cat">${esc(g)}</h3>${all.filter((s) => s.category === g).map((s) => `
<label class="svc"><input type="checkbox" name="s" value="${s.id}"${picked.has(s.id) ? ' checked' : ''}><span class="grow">${esc(s.name)}${s.durationMinutes ? `<span class="muted"> · ${s.durationMinutes} min</span>` : ''}</span><span>${money(s.priceCents)}</span></label>`).join('')}`).join('')}
<button class="btn primary" type="submit">Next: pick a time</button></form>`);
  });

  // Checkbox values arrive as s=1&s=2; keep them as one "1,2" value from here on.
  const sParam = (q) => (Array.isArray(q.s) ? q.s.join(',') : q.s || '');

  app.get('/book/time', (req, res) => {
    if (!enabled()) return closed(res);
    const c = chosen(sParam(req.query));
    if (!c.services.length) return res.redirect(303, '/book');
    const link = (p) => `/book/time?${new URLSearchParams({ s: c.key, ...p })}`;
    page(res, 'Pick a time', `<h1>Pick a day and time</h1><p class="muted">${esc(c.services.map((s) => s.name).join(', '))} · ${c.minutes} min</p>
${slotPicker({ query: req.query, minutes: c.minutes, link, form: '<form method="get" action="/book/details">', hidden: `<input type="hidden" name="s" value="${c.key}">` })}
<a class="btn" href="/book?s=${c.key}">Back</a>`);
  });

  function detailsForm(res, c, date, time, values = {}, error = '') {
    const start = zonedToUtc(date, time, salonTz());
    const whenText = `${start.toLocaleDateString('en-CA', { timeZone: salonTz(), weekday: 'long', month: 'long', day: 'numeric' })}, ${timeLabel(time)}`;
    page(res, 'Your details', `<h1>Almost done</h1><dl class="box"><dt>When</dt><dd>${esc(whenText)}</dd><dt>Services</dt><dd>${esc(c.services.map((s) => s.name).join(', '))}</dd></dl>
${error ? `<div class="note bad">${esc(error)}</div>` : ''}
<form method="post" action="/book">
<input type="hidden" name="s" value="${c.key}"><input type="hidden" name="date" value="${esc(date)}"><input type="hidden" name="time" value="${esc(time)}">
<label class="fld">Your name<input name="name" required maxlength="80" autocomplete="name" value="${esc(values.name)}"></label>
<label class="fld">Mobile number<input name="phone" type="tel" required maxlength="30" autocomplete="tel" value="${esc(values.phone)}"></label>
<label class="fld">Email (for your confirmation)<input name="email" type="email" maxlength="160" autocomplete="email" value="${esc(values.email)}"></label>
<label class="fld">Anything we should know? (optional)<textarea name="notes" rows="2" maxlength="300">${esc(values.notes)}</textarea></label>
<label class="hp" aria-hidden="true">Leave empty<input name="website" tabindex="-1" autocomplete="off"></label>
<button class="btn primary" type="submit">Book appointment</button></form>
<a class="btn" href="/book/time?s=${c.key}&amp;date=${esc(date)}">Back</a>`, error ? 400 : 200);
  }

  app.get('/book/details', (req, res) => {
    if (!enabled()) return closed(res);
    const c = chosen(sParam(req.query));
    const { date, time } = req.query;
    if (!c.services.length || !isValidYmd(date) || !isValidHm(time)) return res.redirect(303, '/book');
    detailsForm(res, c, date, time);
  });

  app.post('/book', async (req, res) => {
    if (!enabled()) return closed(res);
    const b = req.body || {};
    const c = chosen(b.s);
    const { date, time } = b;
    if (!c.services.length || !isValidYmd(date) || !isValidHm(time)) return res.redirect(303, '/book');
    if (b.website) return page(res, 'Booked', '<h1>Thank you</h1>'); // bots fill the hidden field
    const name = String(b.name || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    const phoneDigits = normalizePhone(b.phone);
    const email = String(b.email || '').trim().slice(0, 160);
    const notes = String(b.notes || '').trim().slice(0, 300);
    const values = { name, phone: b.phone, email, notes };
    if (name.length < 2) return detailsForm(res, c, date, time, values, 'Please enter your name.');
    if (phoneDigits.length < 10 || phoneDigits.length > 15) return detailsForm(res, c, date, time, values, 'Please enter your mobile number with area code.');
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return detailsForm(res, c, date, time, values, 'Please check your email address.');
    if (!freeSlots(ctx, date, c.minutes).includes(time)) {
      return page(res, 'Pick a time', `<h1>That time was just taken</h1><p>Please pick another time.</p><a class="btn primary" href="/book/time?s=${c.key}&amp;date=${esc(date)}">See free times</a>`, 409);
    }
    if (!bookLimiter.hit(req.get('cf-connecting-ip') || req.ip)) return page(res, 'Book', '<h1>Please call us</h1><p>We received several bookings from this device. Please call us to book more.</p>', 429);

    const db = ctx.db();
    const now = nowIso();
    const start = zonedToUtc(date, time, salonTz());
    const end = new Date(start.getTime() + c.minutes * 60000);
    const id = db.transaction(() => {
      // A returning customer is matched by phone number; their details are not changed.
      let customer = db.prepare('SELECT id, full_name, email FROM customers WHERE phone_digits = ? ORDER BY id LIMIT 1').get(phoneDigits);
      let extraNote = '';
      if (customer) {
        if (email && !customer.email) db.prepare('UPDATE customers SET email = ?, updated_at = ? WHERE id = ?').run(email, now, customer.id);
        if (customer.full_name.toLowerCase() !== name.toLowerCase()) extraNote = `Booked online as “${name}”.`;
      } else {
        const code = nextCustomerCode(db);
        const cid = db.prepare(`INSERT INTO customers (customer_code, full_name, name_search, phone, phone_digits, email, referral_source, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 'Online booking', 'active', ?, ?)`).run(code, name, name.toLowerCase(), formatPhone(b.phone), phoneDigits, email || null, now, now).lastInsertRowid;
        customer = { id: cid };
        audit(db, { user: null, ip: req.ip }, 'customer.created', 'customer', cid, { customerCode: code, by: 'online booking' });
      }
      const apptNotes = [notes, extraNote].filter(Boolean).join(' ') || null;
      const aid = db.prepare(`INSERT INTO appointments (customer_id, start_at, end_at, duration_minutes, status, notes, created_at, updated_at, scheduled_at, sync_status)
        VALUES (?, ?, ?, ?, 'booked', ?, ?, ?, ?, ?)`).run(customer.id, start.toISOString(), end.toISOString(), c.minutes, apptNotes, now, now, now, ctx.calendar.isConnected() ? 'pending' : null).lastInsertRowid;
      const ins = db.prepare('INSERT INTO appointment_services (appointment_id, service_id, created_at, updated_at) VALUES (?, ?, ?, ?)');
      for (const s of c.services) ins.run(aid, s.id, now, now);
      audit(db, { user: null, ip: req.ip }, 'appointment.booked', 'appointment', aid, { by: 'online booking', startAt: start.toISOString() });
      return aid;
    })();

    // Answer straight away; the calendar copy and emails follow in the background
    // so a slow mail server never leaves the customer tapping Book again.
    res.redirect(303, '/a/' + makeToken(ctx, getAppointment(db, id)) + '?booked=1');
    (async () => {
      await ctx.calendar.syncAppointment(id).catch(() => {});
      const a = getAppointment(db, id);
      try {
        if (await emailCustomer(ctx, a, 'confirmation')) db.prepare('UPDATE appointments SET confirmation_sent_at = ? WHERE id = ?').run(nowIso(), id);
      } catch (e) {
        console.error('Could not email the customer:', e.message);
      }
      await notifySalon(ctx, a, 'booked').catch((e) => console.error('Could not email the salon:', e.message));
    })();
  });

}

module.exports = { bookingRoutes };

'use strict';
// Screenshots of the main screens with made-up sample data, for design review.
// Uses a throwaway data folder; never touches a real salon database.
//   NODE_PATH=$(npm root -g) node scripts/design-shots.js [output-folder]
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { startApp } = require('../test/helpers');
const { createPublicApp } = require('../server/public-app');

const OUT = path.resolve(process.argv[2] || path.join(__dirname, '..', 'test-output', 'design'));
const LOGO = path.join(__dirname, '..', 'public', 'img', 'logo-mark.png');

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const t = await startApp({ requireLogin: false, sampleServices: false });
  const c = t.client();
  const s = t.ctx.settings;
  s.set('business_name', "Kirti's Beauty Parlour");
  s.set('business_phone', '(416) 555-0199');
  s.set('business_address', 'Brampton, ON');
  if (fs.existsSync(LOGO)) s.set('business_logo', 'data:image/png;base64,' + fs.readFileSync(LOGO).toString('base64'));

  // Catalogue like the salon's real one.
  const cat = async (name) => (await c.post('/api/service-categories', { name })).data.id;
  const threading = await cat('Threading');
  const facials = await cat('Facials');
  const waxing = await cat('Waxing');
  const svc = async (categoryId, name, price, durationMinutes) => (await c.post('/api/services', { categoryId, name, price, durationMinutes })).data.id;
  const ids = {
    brow: await svc(threading, 'Eyebrow threading', '10', 15),
    lip: await svc(threading, 'Upper lip threading', '5', 10),
    face: await svc(threading, 'Full face threading', '30', 30),
    classic: await svc(facials, 'Classic facial', '60', 60),
    newstyle: await svc(facials, 'New Style Facial', '75', 75),
    arms: await svc(waxing, 'Full arms wax', '35', 30),
  };

  const people = [
    ['Priya Sharma', '4165551234', 'priya@example.com'],
    ['Anjali Mehta', '6475550142', 'anjali@example.com'],
    ['Sara Thompson', '9055550178', ''],
    ['Neha Kapoor', '4375550111', 'neha@example.com'],
    ['Fatima Khan', '4165550190', ''],
  ];
  const cust = [];
  for (const [fullName, phone, email] of people) cust.push((await c.post('/api/customers', { fullName, phone, email })).data.id);
  await c.post(`/api/customers/${cust[0]}/notes`, { body: 'Sensitive skin. Prefers evening appointments.' });

  const visit = async (customerId, items, method, pay = true) => {
    const q = (await c.post('/api/visits/quote', { customerId, items })).data;
    const total = q.totalCents ?? q.calc?.totalCents;
    const r = await c.post('/api/visits', { customerId, items, payments: pay ? [{ method, amountCents: total }] : [], allowBalance: !pay });
    if (r.status >= 300) console.warn('visit failed', r.status, r.data);
  };
  await visit(cust[0], [{ serviceId: ids.brow }, { serviceId: ids.lip }], 'cash');
  await visit(cust[1], [{ serviceId: ids.classic }], 'debit');
  await visit(cust[2], [{ serviceId: ids.face }], 'credit');
  await visit(cust[3], [{ serviceId: ids.newstyle }, { serviceId: ids.brow }], 'etransfer');
  await visit(cust[0], [{ serviceId: ids.arms }], 'cash', false);

  const tz = s.timezone();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
  const appt = (customerId, time, serviceIds) => c.post('/api/appointments', { customerId, date: today, time, serviceIds, confirmOverlap: true });
  await appt(cust[4], '11:00', [ids.brow]);
  await appt(cust[1], '13:30', [ids.classic]);
  await appt(cust[3], '16:00', [ids.face]);

  // Customer booking pages
  s.set('appt_online_booking', '1');
  s.set('public_base_url', 'https://book.example');
  const pub = await new Promise((r) => { const srv = createPublicApp(t.ctx).listen(0, '127.0.0.1', () => r(srv)); });
  const pubBase = `http://127.0.0.1:${pub.address().port}`;

  const browser = await chromium.launch();
  const ipad = await browser.newContext({ viewport: { width: 1180, height: 820 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const page = await ipad.newPage();
  page.on('pageerror', (e) => console.warn('page error:', e.message));
  const shot = async (name, full = false) => {
    await page.waitForTimeout(450);
    await page.evaluate(() => { window.scrollTo(0, 0); document.querySelectorAll('.bill').forEach((b) => (b.scrollTop = 0)); });
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: full });
    console.log('saved', name);
  };
  const go = async (hash, waitFor) => {
    await page.goto(t.base + '/#/' + hash);
    await page.locator(waitFor).first().waitFor();
  };

  await go('dashboard', '.today-card'); await shot('01-dashboard');
  await go('visit?customer=' + cust[0], '.selected-customer');
  await page.locator('.service-tile', { hasText: 'Eyebrow threading' }).click();
  await page.locator('.service-tile', { hasText: 'Upper lip' }).click();
  await page.locator('.method').first().click();
  await shot('02-new-visit');
  await go('visit', '.keypad'); await shot('03-visit-lookup');
  await go('customers', '.customer-card'); await shot('04-customers');
  await go('customer/' + cust[0], '.visit'); await shot('05-customer-profile');
  await go('appointments', '.appt-card'); await shot('06-appointments');
  await go('billing', '.table'); await shot('07-billing');
  await go('invoice/1', '.receipt'); await shot('08-receipt');
  await go('reports/sales', '.stat-grid'); await shot('09-reports');
  await go('services', '.svc-row'); await shot('10-services');
  await go('settings', 'form'); await shot('11-settings');
  await go('customers', '.customer-card');
  await page.getByRole('button', { name: 'New Customer' }).first().click();
  await page.locator('.modal').waitFor(); await shot('12-new-customer-form');

  // Customer-facing pages on a phone
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const p2 = await phone.newPage();
  await p2.goto(pubBase + '/book'); await p2.waitForTimeout(300);
  await p2.screenshot({ path: path.join(OUT, '20-booking-services.png') });
  await p2.goto(pubBase + `/book/time?s=${ids.brow}`); await p2.waitForTimeout(300);
  await p2.screenshot({ path: path.join(OUT, '21-booking-time.png'), fullPage: true });
  const timeLink = await p2.locator('a.d').first().getAttribute('href').catch(() => null);
  if (timeLink) {
    await p2.goto(pubBase + timeLink.replace(/#.*$/, '')); await p2.waitForTimeout(300);
    await p2.screenshot({ path: path.join(OUT, '22-booking-pick-time.png'), fullPage: true });
    const btn = p2.locator('.times button').first();
    if (await btn.count()) { await btn.click(); await p2.waitForTimeout(400); await p2.screenshot({ path: path.join(OUT, '23-booking-details.png'), fullPage: true }); }
  }

  // Sign-in screen
  s.set('require_login', '1');
  const fresh = await browser.newContext({ viewport: { width: 1180, height: 820 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const p3 = await fresh.newPage();
  await p3.goto(t.base + '/'); await p3.locator('input[type=password]').waitFor(); await p3.waitForTimeout(400);
  await p3.screenshot({ path: path.join(OUT, '13-sign-in.png') });

  await browser.close();
  pub.close();
  await t.close();
})().catch((e) => { console.error(e); process.exit(1); });

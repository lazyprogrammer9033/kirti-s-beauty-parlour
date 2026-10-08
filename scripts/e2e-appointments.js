'use strict';
// Browser walkthrough of booking appointments with a (fake) Google Calendar
// connected, saving screenshots to test-output/. Requires Playwright:
//   NODE_PATH=$(npm root -g) node scripts/e2e-appointments.js
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { chromium } = require('playwright');
const { startApp } = require('../test/helpers');
const { fakeCalendar } = require('../test/fake-calendar');

const OUT = path.join(__dirname, '..', 'test-output');

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const g = fakeCalendar();
  const t = await startApp({ requireLogin: false, google: g.options });
  const sent = [];
  t.ctx.mailer.transportOverride = { sendMail: async (m) => sent.push(m) };
  const browser = await chromium.launch();
  const errors = [];
  const shot = async (page, name) => (await page.waitForTimeout(250), page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: true }));
  try {
    const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && !/fonts\.(googleapis|gstatic)/.test(m.text()) && !m.text().includes('Failed to load resource') && errors.push(m.text()));
    page.on('dialog', (d) => d.accept());

    // Connect Google Calendar (the fake one) from Settings › Appointments.
    t.ctx.settings.set('drive_client_id', '123-abc.apps.googleusercontent.com');
    t.ctx.settings.set('drive_client_secret', 's3cret');
    await page.goto(t.base + '/#/settings/appointments');
    await page.getByRole('button', { name: 'Connect Google Calendar' }).waitFor();
    await page.locator('input[type=email]').first().fill('sharma.kirti56@gmail.com');
    await shot(page, 'appt-01-settings-not-connected');
    let consentUrl;
    await page.route('https://g.test/auth**', (route) => {
      consentUrl = new URL(route.request().url());
      route.fulfill({ status: 200, contentType: 'text/html', body: 'consent' });
    });
    await page.getByRole('button', { name: 'Connect Google Calendar' }).click();
    await page.waitForURL(/g\.test\/auth/);
    assert.equal(consentUrl.searchParams.get('login_hint'), 'sharma.kirti56@gmail.com');
    await page.goto(`${t.base}/api/drive/callback?state=${consentUrl.searchParams.get('state')}&code=abc`);
    await page.getByText('Bookings are added to sharma.kirti56@gmail.com').waitFor();
    await page.locator('select option', { hasText: 'Salon bookings' }).waitFor({ state: 'attached' });
    await shot(page, 'appt-02-settings-connected');

    // Book from the Appointments screen.
    const cust = await (await fetch(t.base + '/api/customers', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Salon-Request': '1' }, body: JSON.stringify({ fullName: 'Priya Patel', phone: '4165551234', email: 'priya@example.com' }) })).json();
    assert.ok(cust.id);
    await page.goto(t.base + '/#/appointments');
    await page.getByText('No appointments').waitFor();
    await page.getByRole('button', { name: 'Book appointment' }).first().click();
    const modal = page.locator('.modal');
    await modal.locator('input[type=search]').fill('Priya');
    await modal.locator('.lookup-row').first().click();
    await modal.getByText('Email a confirmation to priya@example.com').waitFor();
    await modal.locator('.chip', { hasText: 'Waxing' }).click();
    await modal.locator('.chip', { hasText: 'Eyebrows' }).click();
    await modal.locator('.chip', { hasText: 'Upper Lip' }).click();
    await modal.locator('select').first().selectOption('21:00');
    await shot(page, 'appt-03-book-modal');
    await modal.getByRole('button', { name: 'Book' }).click();
    await page.locator('.appt-card').waitFor();
    await page.getByText('In Google Calendar').waitFor();
    assert.equal(g.inCalendar('primary').length, 1);
    assert.equal(sent.length, 1);
    await shot(page, 'appt-04-day-list');

    // Details, then start the visit with the booked services in the bill.
    await page.locator('.appt-card').click();
    await shot(page, 'appt-05-details');
    await page.getByRole('link', { name: 'Start visit' }).click();
    await page.locator('.selected-customer').waitFor();
    await page.locator('.bill-line', { hasText: 'Upper Lip' }).waitFor();
    await shot(page, 'appt-06-visit-from-appointment');

    // Customer profile shows the booking.
    await page.goto(t.base + '/#/customer/' + cust.id);
    await page.getByRole('heading', { name: 'Appointments' }).waitFor();
    await shot(page, 'appt-07-customer-profile');

    // Phone size.
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
    const p2 = await phone.newPage();
    await p2.goto(t.base + '/#/appointments');
    await p2.locator('.appt-card').waitFor();
    await shot(p2, 'appt-08-phone');

    assert.deepEqual(errors, []);
    console.log('Appointments walkthrough passed');
  } finally {
    await browser.close();
    await t.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

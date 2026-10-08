'use strict';
// Browser walkthrough of blocking time and the customer booking calendar,
// saving screenshots to test-output/. Requires Playwright:
//   NODE_PATH=$(npm root -g) node scripts/e2e-blocks.js
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { chromium } = require('playwright');
const { startApp } = require('../test/helpers');
const { createPublicApp } = require('../server/public-app');
const { addDays, businessDate } = require('../server/lib/time');

const OUT = path.join(__dirname, '..', 'test-output');

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const t = await startApp({ requireLogin: false });
  const pub = await new Promise((resolve) => {
    const s = createPublicApp(t.ctx).listen(0, '127.0.0.1', () => resolve(s));
  });
  const pubBase = `http://127.0.0.1:${pub.address().port}`;
  t.ctx.settings.set('public_base_url', 'https://book.example.com');
  t.ctx.settings.set('appt_online_booking', '1');
  t.ctx.settings.set('appt_open_days', '2,3,4,5,6,0');
  const day = addDays(businessDate(new Date(), 'America/Toronto'), 3);
  const browser = await chromium.launch();
  const errors = [];
  const shot = async (page, name) => (await page.waitForTimeout(250), page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: true }));
  try {
    const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && !/fonts\.(googleapis|gstatic)/.test(m.text()) && !m.text().includes('Failed to load resource') && errors.push(m.text()));

    // Block lunch on one day from the Appointments screen.
    await page.goto(`${t.base}/#/appointments/${day}`);
    await page.getByRole('button', { name: 'Block time' }).click();
    const modal = page.locator('.modal');
    await modal.getByText('All day').click();
    await modal.locator('input[type=time]').first().fill('13:00');
    await modal.locator('input[type=time]').nth(1).fill('14:00');
    await modal.locator('input[placeholder^="Lunch"]').fill('Lunch');
    await shot(page, 'block-01-modal');
    await modal.getByRole('button', { name: 'Block', exact: true }).click();
    await page.getByText('Blocked 1:00 p.m. to 2:00 p.m.').waitFor();

    // And close the next two days for a holiday.
    await page.getByRole('button', { name: 'Block time' }).click();
    await modal.locator('input[type=date]').first().fill(addDays(day, 1));
    await modal.locator('input[type=date]').nth(1).fill(addDays(day, 2));
    await modal.locator('input[placeholder^="Lunch"]').fill('Family wedding');
    await modal.getByRole('button', { name: 'Block', exact: true }).click();
    await page.getByText('Closed all day').waitFor();
    await shot(page, 'block-02-closed-day');
    await page.goto(`${t.base}/#/appointments/${day}`);
    await page.getByText('Blocked 1:00 p.m. to 2:00 p.m.').waitFor();
    await shot(page, 'block-03-lunch');

    // Reminder choices in Settings.
    await page.goto(t.base + '/#/settings/appointments');
    await page.getByText('1 week before').waitFor();
    await page.getByText('Send reminders').scrollIntoViewIfNeeded();
    await shot(page, 'block-04-settings-reminders');

    // What a customer sees on their phone.
    const phone = await browser.newContext({ viewport: { width: 375, height: 760 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    const cp = await phone.newPage();
    cp.on('pageerror', (e) => errors.push(e.message));
    await cp.goto(pubBase + '/book');
    await cp.getByText('Eyebrows').click();
    await cp.getByRole('button', { name: 'Next: pick a time' }).click();
    await cp.getByText('Pick a day and time').waitFor();
    await cp.goto(cp.url().replace(/&date=[^&]*/, '') + `&date=${day}`);
    assert.equal(await cp.locator('button[value="13:00"]').count(), 0);
    assert.equal(await cp.locator('button[value="12:45"]').count(), 1);
    await shot(cp, 'block-05-customer-calendar');
    await cp.goto(cp.url().replace(/&date=[^&]*/, '') + `&date=${addDays(day, 1)}`);
    await cp.getByText(/No free times on/).waitFor();
    await cp.getByRole('link', { name: 'Next month' }).click();
    await cp.getByText(/\d+ times? free/).waitFor();
    await shot(cp, 'block-06-next-month');
    const width = await cp.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(width <= 375, 'no sideways scrolling on a phone: ' + width);

    assert.deepEqual(errors, []);
    console.log('OK: block time and booking calendar walkthrough');
  } finally {
    await browser.close();
    await new Promise((r) => pub.close(r));
    await t.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

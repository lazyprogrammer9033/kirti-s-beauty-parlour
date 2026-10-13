'use strict';
// Browser walkthrough of offline mode on an iPad-sized screen: the salon
// computer disappears, visits are saved on the iPad, then sync when it's back.
//   NODE_PATH=$(npm root -g) node scripts/e2e-offline.js
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { chromium } = require('playwright');
const { startApp, Client } = require('../test/helpers');

const OUT = path.join(__dirname, '..', 'test-output');

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const t = await startApp({ requireLogin: false });
  const browser = await chromium.launch();
  const errors = [];
  const shot = async (page, name) => (await page.waitForTimeout(250), page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: true }));
  const server = new Client(t.base);
  try {
    const existing = (await server.post('/api/customers', { fullName: 'Priya Patel', phone: '416-555-1234' })).data;

    const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && !/fonts\.(googleapis|gstatic)|Failed to load resource|net::ERR_INTERNET_DISCONNECTED/.test(m.text()) && errors.push(m.text()));

    // First visit while connected: the app and a copy of the data are saved.
    await page.goto(t.base + '/');
    await page.getByText('Good', { exact: false }).first().waitFor();
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('salon.offline.snapshot') || 'null')?.customers?.length === 1);
    await page.reload();
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);

    // The salon computer goes away. The app still opens.
    await ctx.setOffline(true);
    await page.reload();
    await page.locator('.offline-bar.off').waitFor();
    await page.getByText('This page needs the salon computer').waitFor();
    await shot(page, '30-offline-dashboard');

    // Existing customer, found from the saved copy.
    await page.getByRole('link', { name: 'New Visit' }).last().tap();
    for (const d of '4165551234') await page.locator(`.key[aria-label="${d}"]`).tap();
    await page.locator('.lookup-row').first().tap();
    await page.locator('.selected-customer').waitFor();
    await page.locator('.chip', { hasText: 'Waxing' }).tap();
    await page.locator('.service-tile', { hasText: 'Eyebrows' }).tap();
    await page.waitForFunction(() => document.querySelector('.totals .grand')?.textContent.includes('11.30'));
    await page.getByRole('button', { name: /Complete · \$11\.30/ }).tap();
    await page.getByRole('heading', { name: 'Saved on this iPad' }).waitFor();
    assert.match(await page.locator('.success').innerText(), /Temporary receipt OFF-[A-Z0-9]{4}-0001/);
    await shot(page, '31-offline-saved');

    // New customer made offline, with the same phone someone else adds on the computer.
    await page.getByRole('button', { name: 'Next customer' }).tap();
    for (const d of '6475550199') await page.locator(`.key[aria-label="${d}"]`).tap();
    await page.locator('.new-inline input').first().fill('Meena Shah');
    await page.getByRole('button', { name: 'Create New Customer' }).tap();
    await page.locator('.selected-customer').waitFor();
    assert.match(await page.locator('.selected-customer').innerText(), /saved on this iPad/);
    await page.locator('.chip', { hasText: 'Waxing' }).tap();
    await page.locator('.service-tile', { hasText: 'Upper Lip' }).tap();
    await page.getByRole('button', { name: 'Pay later' }).tap();
    await page.getByRole('button', { name: /Save visit/ }).tap();
    await page.getByRole('heading', { name: 'Saved on this iPad' }).waitFor();
    await page.locator('.offline-bar', { hasText: '3 waiting to sync' }).waitFor();
    await page.locator('.offline-bar').getByRole('button', { name: 'See list' }).tap();
    await shot(page, '32-offline-list');
    await page.getByRole('button', { name: 'Close' }).tap();

    await server.post('/api/customers', { fullName: 'Meena S.', phone: '647-555-0199' });

    // Back online: the first visit syncs; the new customer asks about the duplicate phone.
    await ctx.setOffline(false);
    await page.locator('.offline-bar.attn').waitFor({ timeout: 20000 });
    await page.locator('.offline-bar').getByRole('button', { name: 'Review' }).tap();
    await shot(page, '33-sync-duplicate');
    await page.getByRole('button', { name: /Same person as Meena S\./ }).tap();
    await page.getByText('Everything has been sent to the salon computer.').waitFor();
    await page.getByRole('button', { name: 'Close' }).tap();
    assert.equal(await page.locator('.offline-bar').isHidden(), true);

    const invoices = (await server.get('/api/invoices')).data;
    assert.equal(invoices.length, 2);
    assert.ok(invoices.every((i) => /^INV-\d{4}-00000[12]$/.test(i.invoiceNumber)));
    const priya = (await server.get('/api/customers/' + existing.id)).data;
    assert.equal(priya.visits.length, 1);
    const meena = (await server.get('/api/customers/search?q=6475550199')).data;
    assert.equal(meena.length, 1, 'the offline customer was merged into the existing one');
    assert.equal(meena[0].totalVisits, 1);
    const owing = invoices.find((i) => i.customerId === meena[0].id);
    assert.equal(owing.totalCents, 904);
    assert.equal(owing.balanceCents, 904);

    assert.deepEqual(errors, []);
    console.log('E2E OFFLINE OK — screenshots in test-output/');
  } catch (e) {
    console.error('E2E OFFLINE FAILED:', e.message);
    await browser.contexts()[0]?.pages()[0]?.screenshot({ path: path.join(OUT, 'offline-failure.png') }).catch(() => {});
    if (errors.length) console.error(errors.join('\n'));
    process.exitCode = 1;
  } finally {
    await browser.close();
    await t.close();
  }
})();

'use strict';
// Browser walkthrough of the main workflows at iPad and Mac sizes, saving
// screenshots to test-output/. Requires Playwright (not an app dependency):
//   NODE_PATH=$(npm root -g) node scripts/e2e.js
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { chromium } = require('playwright');
const { startApp } = require('../test/helpers');

const OUT = path.join(__dirname, '..', 'test-output');
const DEVICES = {
  'ipad-landscape': { viewport: { width: 1180, height: 820 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 },
  'ipad-portrait': { viewport: { width: 820, height: 1180 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 },
  mac: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 },
  phone: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 },
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  // Default first run: no sign-in screen. Sample services make billing testable.
  const t = await startApp({ requireLogin: false });
  const browser = await chromium.launch();
  const errors = [];
  const shot = async (page, name) => (await page.waitForTimeout(250), page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: true }));
  const watch = (page, label) => {
    page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && !/fonts\.(googleapis|gstatic)/.test(m.text()) && !m.text().includes('Failed to load resource') && errors.push(`${label} console: ${m.text()}`));
  };

  try {
    // ---------- Full workflow on iPad landscape ----------
    const ctx = await browser.newContext(DEVICES['ipad-landscape']);
    const page = await ctx.newPage();
    watch(page, 'ipad');
    await page.goto(t.base + '/');
    await page.getByText('Good', { exact: false }).first().waitFor();
    assert.equal(await page.getByRole('button', { name: 'Sign out' }).count(), 0);
    await page.waitForTimeout(400);
    await shot(page, '02-dashboard-empty-ipad');

    // Register a customer from the dashboard quick action.
    await page.getByRole('button', { name: 'New Customer' }).click();
    const modal = page.locator('.modal');
    await modal.locator('input').nth(0).fill('Priya Patel');
    await modal.locator('input').nth(1).fill('416-555-1234');
    await modal.locator('input[type=email]').fill('priya@example.com');
    await modal.locator('textarea').fill('Sensitive skin. Prefers evening appointments.');
    await shot(page, '03-new-customer-form');
    await page.getByRole('button', { name: 'Create customer' }).click();
    await page.locator('.profile-head').waitFor();
    assert.ok((await page.locator('.profile-meta').innerText()).includes('CUS-000001'));

    // Duplicate phone warning.
    await page.goto(t.base + '/#/customers');
    await page.getByRole('button', { name: 'New Customer' }).first().click();
    await modal.locator('input').nth(0).fill('Another Person');
    await modal.locator('input').nth(1).fill('(416) 555 1234');
    await page.getByRole('button', { name: 'Create customer' }).click();
    await page.getByText('Phone number already registered').waitFor();
    await shot(page, '04-duplicate-warning');
    await page.getByRole('button', { name: 'Cancel' }).last().click();
    await page.locator('.profile-head').waitFor();

    // New visit: keypad lookup -> services -> discount -> pay.
    await page.goto(t.base + '/#/visit');
    await page.locator('.keypad').waitFor();
    for (const d of '4165551234') await page.locator(`.key[aria-label="${d}"]`).tap();
    await page.locator('.lookup-row').first().waitFor();
    await shot(page, '05-visit-lookup');
    await page.locator('.lookup-row').first().tap();
    await page.locator('.selected-customer').waitFor();
    await page.locator('.service-tile', { hasText: 'Haircut' }).tap();
    await page.locator('.chip', { hasText: 'Facial' }).tap();
    await page.locator('.service-tile', { hasText: 'Deep Cleansing Facial' }).tap();
    await page.locator('.bill-row input').fill('10');
    await page.waitForFunction(() => document.querySelector('.totals .grand')?.textContent.includes('107.35'));
    await page.locator('.method', { hasText: 'Credit Card' }).tap();
    await shot(page, '06-visit-bill-ipad-landscape');
    await page.locator('.bill textarea').fill('Trimmed 2 inches');
    await page.getByRole('button', { name: /Complete · \$107\.35/ }).tap();
    await page.getByText('Payment complete').waitFor();
    await shot(page, '07-payment-complete');

    // Receipt
    await page.getByRole('link', { name: 'Print receipt' }).tap();
    await page.locator('.receipt').waitFor();
    const receipt = await page.locator('.receipt').innerText();
    assert.match(receipt, /INV-\d{4}-000001/);
    assert.match(receipt, /\$107\.35/);
    assert.match(receipt, /\$12\.35/);
    await shot(page, '08-receipt');

    // Second visit with split payment and a balance owing
    await page.goto(t.base + '/#/visit?customer=1');
    await page.locator('.selected-customer').waitFor();
    await page.getByRole('button', { name: 'Same as last time' }).tap();
    await page.waitForFunction(() => document.querySelectorAll('.bill-line').length === 2);
    await page.getByRole('button', { name: 'Split payment' }).tap();
    const amounts = page.locator('.split-row input');
    await amounts.nth(0).fill('50');
    await amounts.nth(1).fill('20');
    await page.getByText(/Remaining/).waitFor();
    await shot(page, '09-split-payment');
    await page.getByRole('button', { name: /Complete/ }).tap();
    await page.getByText('Visit saved').waitFor();

    // Profile with history
    await page.goto(t.base + '/#/customer/1');
    await page.locator('.visit').nth(1).waitFor();
    assert.equal(await page.locator('.visit').count(), 2);
    assert.ok((await page.locator('.alert.warn').innerText()).includes('Outstanding'));
    await shot(page, '10-customer-profile-ipad');

    // Record the outstanding payment from the receipt page
    await page.locator('.visit').first().click();
    await page.getByRole('button', { name: 'Record payment' }).click();
    await page.locator('.modal .method', { hasText: 'E-transfer' }).click();
    await page.locator('.modal').getByRole('button', { name: 'Record payment' }).click();
    await page.getByText('Payment recorded').waitFor();

    // Dashboard, billing, reports, services, settings
    await page.goto(t.base + '/#/dashboard');
    await page.locator('.stat-card').first().waitFor();
    await page.waitForTimeout(300);
    await shot(page, '11-dashboard-ipad-landscape');
    await page.locator('.search-input').fill('4165551234');
    await page.locator('.search-results .customer-card').waitFor();
    await shot(page, '12-dashboard-search');
    await page.goto(t.base + '/#/billing');
    await page.locator('.table').waitFor();
    await shot(page, '13-billing');
    for (const r of ['sales', 'services', 'payments', 'customers', 'spending']) {
      await page.goto(t.base + '/#/reports/' + r);
      await page.locator('.stat-grid').waitFor();
      if (r === 'sales' || r === 'payments') await shot(page, `14-report-${r}`);
    }
    await page.goto(t.base + '/#/services');
    await page.locator('.svc-row').first().waitFor();
    await shot(page, '15-services');
    await page.locator('.svc-row', { hasText: 'Haircut' }).getByRole('button', { name: /Edit/ }).click();
    await page.locator('.modal input[inputmode=decimal]').fill('50.00');
    await page.locator('.modal').getByRole('button', { name: 'Save' }).click();
    await page.getByText('Service updated').waitFor();
    await page.goto(t.base + '/#/settings/backup');
    await page.getByRole('button', { name: 'Backup Now' }).click();
    await page.getByText('Your data is backed up').waitFor();
    await shot(page, '16-settings-backup');
    await page.goto(t.base + '/#/settings/tax');
    await page.locator('form').first().waitFor();
    await shot(page, '17-settings-tax');
    await page.goto(t.base + '/#/settings/audit');
    await page.locator('tbody tr').first().waitFor();
    await shot(page, '18-audit');

    // Historical receipt keeps the original $45 haircut price
    await page.goto(t.base + '/#/invoice/1');
    await page.locator('.receipt').waitFor();
    assert.match(await page.locator('.receipt').innerText(), /\$45\.00/);

    // ---------- Other screen sizes ----------
    const state = await ctx.storageState();
    for (const name of ['ipad-portrait', 'mac', 'phone']) {
      const c2 = await browser.newContext({ ...DEVICES[name], storageState: state });
      const p = await c2.newPage();
      watch(p, name);
      await p.goto(t.base + '/#/dashboard');
      await p.locator('.stat-card').first().waitFor();
      await p.waitForTimeout(300);
      await shot(p, `20-dashboard-${name}`);
      await p.goto(t.base + '/#/visit?customer=1');
      await p.locator('.selected-customer').waitFor();
      await p.locator('.service-tile').first().click();
      await p.waitForFunction(() => document.querySelector('.totals .grand'));
      await shot(p, `21-visit-${name}`);
      await p.goto(t.base + '/#/customer/1');
      await p.locator('.visit').first().waitFor();
      await shot(p, `22-profile-${name}`);
      // No horizontal scrolling on any screen.
      const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(overflow <= 1, `${name} has horizontal overflow of ${overflow}px`);
      await c2.close();
    }

    // Turn on the sign-in screen from My Account; the owner stays signed in.
    await page.goto(t.base + '/#/settings/account');
    await page.getByText('No sign-in needed').waitFor();
    await shot(page, '22-signin-off');
    await page.locator('form.card input[type=password]').fill('Secret-pass-1');
    await page.getByRole('button', { name: 'Turn on sign-in' }).click();
    await page.getByText('Sign-in screen is on').waitFor();
    await page.getByRole('button', { name: 'Sign out' }).waitFor();

    // Staff account cannot see reports or settings tabs
    await page.goto(t.base + '/#/settings/users');
    await page.getByRole('button', { name: 'Add staff' }).click();
    const um = page.locator('.modal');
    await um.locator('input').nth(0).fill('Meera');
    await um.locator('input').nth(1).fill('meera');
    await um.locator('input[type=password]').fill('staff-pass-1');
    await um.getByRole('button', { name: 'Save' }).click();
    await page.getByText('Saved').waitFor();
    const sctx = await browser.newContext(DEVICES['ipad-landscape']);
    const sp = await sctx.newPage();
    watch(sp, 'staff');
    await sp.goto(t.base + '/');
    await sp.getByText('Welcome back').waitFor();
    await sp.locator('form input').nth(0).fill('meera');
    await sp.locator('form input').nth(1).fill('staff-pass-1');
    await sp.getByRole('button', { name: 'Sign in' }).click();
    await sp.locator('.quick-actions').waitFor();
    assert.equal(await sp.locator('.nav-link[data-path=reports]').count(), 0);
    await shot(sp, '23-staff-dashboard');
    await sctx.close();

    assert.deepEqual(errors, []);
    console.log('E2E OK — screenshots in test-output/');
  } catch (e) {
    console.error('E2E FAILED:', e.message);
    if (errors.length) console.error(errors.join('\n'));
    process.exitCode = 1;
  } finally {
    await browser.close();
    await t.close();
  }
})();

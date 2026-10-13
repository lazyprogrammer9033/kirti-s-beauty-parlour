'use strict';
// Renders public/img/icon.svg to the PNG sizes iPad/Android need. Run once after changing the icon.
// Requires Playwright (not an app dependency): NODE_PATH=$(npm root -g) node scripts/make-icons.js
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

(async () => {
  const svg = fs.readFileSync(path.join(__dirname, '..', 'public', 'img', 'icon.svg'), 'utf8');
  const browser = await chromium.launch();
  for (const [name, size, pad] of [['apple-touch-icon.png', 180, 0], ['icon-192.png', 192, 0], ['icon-512.png', 512, 0]]) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    // iOS rounds corners itself, so the touch icon is drawn square.
    const body = name.startsWith('apple') ? svg.replace('rx="112"', 'rx="0"') : svg;
    await page.setContent(`<html><body style="margin:0">${body.replace('<svg ', `<svg width="${size}" height="${size}" style="padding:${pad}px" `)}</body></html>`);
    await page.screenshot({ path: path.join(__dirname, '..', 'public', 'img', name), omitBackground: true });
    await page.close();
  }
  await browser.close();
})();

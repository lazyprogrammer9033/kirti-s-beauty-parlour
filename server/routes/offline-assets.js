'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PUBLIC = path.join(__dirname, '..', '..', 'public');
const MONEY = path.join(__dirname, '..', 'lib', 'money.js');

function listFiles(dir, base = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listFiles(path.join(dir, e.name), base + '/' + e.name) : [base + '/' + e.name]);
}

// The bill maths runs on the iPad while offline, from the same file the server uses.
function moneyModule() {
  return `const cjs = { exports: {} };\n(function (module) {\n${fs.readFileSync(MONEY, 'utf8')}\n})(cjs);\nexport const { toCents, formatCad, calculateInvoice, allocate, roundDiv } = cjs.exports;\n`;
}

// The service worker keeps a copy of the app on the iPad so it opens with the
// salon computer off. Its version changes whenever any app file changes.
function serviceWorker() {
  const files = listFiles(PUBLIC).filter((f) => f !== '/index.html');
  const hash = crypto.createHash('sha256');
  for (const f of files) hash.update(f).update(fs.readFileSync(path.join(PUBLIC, f)));
  hash.update(moneyModule()).update(fs.readFileSync(path.join(PUBLIC, 'index.html')));
  const version = hash.digest('hex').slice(0, 12);
  const precache = ['/', '/js/money.js', ...files];
  return `const VERSION = ${JSON.stringify(version)};\nconst PRECACHE = ${JSON.stringify(precache)};\n${fs.readFileSync(path.join(__dirname, '..', 'sw-template.js'), 'utf8')}`;
}

module.exports = function offlineAssets(app, ctx) {
  app.get('/js/money.js', (req, res) => {
    res.type('application/javascript').set('Cache-Control', 'no-cache').send(moneyModule());
  });
  app.get('/sw.js', (req, res) => {
    res.type('application/javascript').set('Cache-Control', 'no-cache').send(serviceWorker());
  });
  // The certificate the iPad installs once so it trusts this computer's https address.
  app.get('/salon-certificate.crt', (req, res) => {
    const file = path.join(ctx.dataDir, 'https', 'ca.crt');
    if (!fs.existsSync(file)) return res.status(404).type('text/plain').send('Secure access is not set up on this computer.');
    res.type('application/x-x509-ca-cert').set('Content-Disposition', 'attachment; filename="salon-certificate.crt"').send(fs.readFileSync(file));
  });
};

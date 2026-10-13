'use strict';

const path = require('path');
const https = require('https');
const { createApp } = require('./app');
const { ensureCertificates, localNames } = require('./lib/tls');

const port = Number(process.env.PORT || 3000);
const httpsPort = Number(process.env.HTTPS_PORT || 3443);
const host = process.env.HOST || '0.0.0.0';
const app = createApp({
  dataDir: process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : undefined,
  secureCookies: process.env.SECURE_COOKIES === '1',
  trustProxy: process.env.TRUST_PROXY === '1' ? true : 'loopback',
});

// https runs beside http so the iPad can keep the app for offline use.
const secure = process.env.HTTPS === '0' ? null : ensureCertificates(app.locals.ctx.dataDir);

const servers = [];
servers.push(app.listen(port, host, () => {
  const { dns, ips } = localNames();
  const lan = ips.filter((ip) => ip !== '127.0.0.1');
  console.log(`\n  Salon Manager is running.\n`);
  console.log(`  On this computer:   http://localhost:${port}`);
  console.log(`  On the iPad (Wi-Fi): http://${dns[2]}:${port}`);
  for (const a of lan) console.log(`                   or http://${a}:${port}`);
  if (secure) {
    console.log(`\n  iPad with offline mode (after the one-time certificate step in the README):`);
    console.log(`                      https://${dns[2]}:${httpsPort}`);
    for (const a of lan) console.log(`                   or https://${a}:${httpsPort}`);
  }
  console.log(`\n  Data folder:        ${app.locals.ctx.dataDir}\n`);
}));
app.locals.ctx.https = secure ? { port: httpsPort } : null;
if (secure) {
  const s = https.createServer({ key: secure.key, cert: secure.cert }, app);
  s.on('error', (e) => console.warn(`  Secure (https) access is off: ${e.message}`));
  servers.push(s.listen(httpsPort, host));
}


function shutdown() {
  let open = servers.length;
  for (const s of servers) s.close(() => --open === 0 && (app.locals.close(), process.exit(0)));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

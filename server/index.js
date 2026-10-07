'use strict';

const path = require('path');
const os = require('os');
const { createApp } = require('./app');

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
const app = createApp({
  dataDir: process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : undefined,
  secureCookies: process.env.SECURE_COOKIES === '1',
  trustProxy: process.env.TRUST_PROXY === '1' ? true : 'loopback',
});

const server = app.listen(port, host, () => {
  const addrs = Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => a.address);
  console.log(`\n  Salon Manager is running.\n`);
  console.log(`  On this computer:   http://localhost:${port}`);
  const local = os.hostname().replace(/\.local$/, '') + '.local';
  console.log(`  On the iPad (Wi-Fi): http://${local}:${port}`);
  for (const a of addrs) console.log(`                   or http://${a}:${port}`);
  console.log(`  Data folder:        ${app.locals.ctx.dataDir}\n`);
});

function shutdown() {
  server.close(() => {
    app.locals.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

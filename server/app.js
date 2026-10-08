'use strict';

const path = require('path');
const express = require('express');
const { DbHolder } = require('./db');
const { Settings } = require('./lib/settings');
const { loadSecretKey } = require('./lib/secrets');
const { loadUser, can, LoginLimiter } = require('./lib/auth');
const { HttpError } = require('./lib/http');
const { BackupService } = require('./lib/backup');
const { DriveService } = require('./lib/drive');
const { Mailer } = require('./lib/email');
const { CalendarService } = require('./lib/calendar');
const { AppointmentScheduler } = require('./lib/appointments');

/**
 * Builds the application. Options:
 *   dataDir      folder holding salon.db, backups/ and secret.key
 *   dbFile       override database path (tests use a temp file)
 *   secureCookies  set when served over HTTPS
 *   scheduler    start the automatic backup timer (default true)
 *   requireLogin   first-run default for the sign-in screen (default off)
 *   sampleServices seed a demo service catalogue into an empty database
 */
// With sign-in turned off, every request acts as the first active owner.
function openAccessUser(ctx) {
  if (ctx.settings.get('require_login') !== '0') return null;
  const row = ctx.db().prepare(`SELECT u.id, u.username, u.display_name, r.code AS role FROM users u JOIN roles r ON r.id = u.role_id
    WHERE u.active = 1 AND r.code = 'owner' ORDER BY u.id LIMIT 1`).get();
  return row ? { id: row.id, username: row.username, displayName: row.display_name, role: row.role, sessionId: null, openAccess: true } : null;
}

function createApp(options = {}) {
  const dataDir = options.dataDir || path.join(__dirname, '..', 'data');
  const dbFile = options.dbFile || path.join(dataDir, 'salon.db');
  const holder = new DbHolder(dbFile, { requireLogin: options.requireLogin, sampleServices: options.sampleServices });
  holder.open();

  const secretKey = loadSecretKey(dataDir);
  const settings = new Settings(holder, secretKey);
  const ctx = {
    holder,
    db: () => holder.get(),
    settings,
    dataDir,
    secureCookies: !!options.secureCookies,
    loginLimiter: new LoginLimiter(options.loginLimiter),
  };
  ctx.drive = new DriveService(ctx, options.google || {});
  ctx.backups = new BackupService(ctx);
  ctx.mailer = new Mailer(ctx, options.mailTransport);
  ctx.calendar = new CalendarService(ctx, options.google || {});
  ctx.appointments = new AppointmentScheduler(ctx);

  const app = express();
  app.set('trust proxy', options.trustProxy ?? 'loopback');
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
        "font-src 'self' https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; frame-src 'self' blob:; " +
        "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
    );
    next();
  });

  // Every API request carries the signed-in user (or null).
  app.use('/api', (req, res, next) => {
    req.user = loadUser(ctx.db(), req) || openAccessUser(ctx);
    res.setHeader('Cache-Control', 'no-store');
    // CSRF defence: state-changing requests must carry a custom header, which a
    // cross-site form or image cannot add. Combined with SameSite cookies.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('X-Salon-Request') !== '1') {
      return next(new HttpError(403, 'Missing request header'));
    }
    next();
  });

  app.use('/api', express.json({ limit: '2mb' }));

  const api = express.Router();
  api.get('/health', (req, res) => res.json({ ok: true }));
  require('./routes/auth')(api, ctx);
  require('./routes/drive').publicRoutes(api, ctx);
  api.use((req, res, next) => (req.user ? next() : next(new HttpError(401, 'Please sign in'))));
  require('./routes/customers')(api, ctx);
  require('./routes/services')(api, ctx);
  require('./routes/appointments')(api, ctx);
  require('./routes/visits')(api, ctx);
  require('./routes/invoices')(api, ctx);
  require('./routes/dashboard')(api, ctx);
  require('./routes/reports')(api, ctx);
  require('./routes/settings')(api, ctx);
  require('./routes/users')(api, ctx);
  require('./routes/backups')(api, ctx);
  require('./routes/drive').privateRoutes(api, ctx);
  require('./routes/exports')(api, ctx);
  require('./routes/audit')(api, ctx);
  require('./routes/offline')(api, ctx);
  app.use('/api', api);
  app.use('/api', (req, res, next) => next(new HttpError(404, 'Not found')));

  require('./routes/offline-assets')(app, ctx);
  app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html', maxAge: 0 }));
  app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || (err.type === 'entity.too.large' ? 413 : 500);
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 && !err.expose ? 'Something went wrong. Please try again.' : err.message, ...(err.data || {}) });
  });

  if (options.scheduler !== false) {
    ctx.backups.startScheduler();
    ctx.appointments.start();
  }

  app.locals.ctx = ctx;
  app.locals.can = can;
  app.locals.close = () => {
    ctx.backups.stopScheduler();
    ctx.appointments.stop();
    holder.close();
  };
  return app;
}

module.exports = { createApp };

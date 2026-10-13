'use strict';

const { hashPassword, verifyPassword } = require('../lib/secrets');
const { createSession, sessionCookie, clearCookie, can, ROLE_PERMISSIONS } = require('../lib/auth');
const { HttpError, str } = require('../lib/http');
const { audit } = require('../lib/audit');
const { nowIso } = require('../lib/time');

function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  if (pw.length > 200) throw new HttpError(400, 'Password is too long');
}

function userPayload(user) {
  if (!user) return null;
  const perms = ROLE_PERMISSIONS[user.role] || [];
  return { id: user.id, username: user.username, displayName: user.displayName, role: user.role, permissions: perms };
}

module.exports = function authRoutes(api, ctx) {
  const secure = (req) => ctx.secureCookies || req.secure;

  api.get('/auth/status', (req, res) => {
    const db = ctx.db();
    const users = db.prepare('SELECT COUNT(*) c FROM users').get().c;
    const user = userPayload(req.user);
    if (user) user.openAccess = !!req.user.openAccess;
    res.json({ setupRequired: users === 0, user, requireLogin: ctx.settings.get('require_login') !== '0', businessName: ctx.settings.get('business_name') });
  });

  // First run only: create the owner account.
  api.post('/auth/setup', (req, res) => {
    const db = ctx.db();
    const displayName = str(req.body.displayName, { required: true, max: 80, label: 'Name' });
    const username = str(req.body.username, { required: true, max: 40, label: 'Username' });
    validatePassword(req.body.password);
    const ownerRole = db.prepare("SELECT id FROM roles WHERE code = 'owner'").get().id;
    const created = db.transaction(() => {
      if (db.prepare('SELECT COUNT(*) c FROM users').get().c > 0) return null;
      const now = nowIso();
      const id = db.prepare('INSERT INTO users (username, display_name, password_hash, role_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(username, displayName, hashPassword(req.body.password), ownerRole, now, now).lastInsertRowid;
      if (req.body.businessName) ctx.settings.set('business_name', str(req.body.businessName, { max: 120 }), id);
      return id;
    })();
    if (!created) throw new HttpError(409, 'Setup has already been completed');
    req.user = { id: created, username };
    audit(db, req, 'user.created', 'user', created, { role: 'owner', firstRun: true });
    const { token, expires } = createSession(db, created);
    res.setHeader('Set-Cookie', sessionCookie(token, expires, secure(req)));
    res.json({ ok: true });
  });

  api.post('/auth/login', (req, res) => {
    const db = ctx.db();
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    if (ctx.loginLimiter.isLocked(req.ip, username)) {
      throw new HttpError(429, 'Too many attempts. Please wait 5 minutes and try again.');
    }
    const row = db.prepare('SELECT id, username, password_hash, active FROM users WHERE username = ?').get(username);
    const ok = row && row.active && verifyPassword(password, row.password_hash);
    if (!ok) {
      ctx.loginLimiter.fail(req.ip, username);
      audit(db, { ip: req.ip }, 'auth.login_failed', 'user', row ? row.id : null, { username });
      throw new HttpError(401, 'Incorrect username or password');
    }
    ctx.loginLimiter.success(req.ip, username);
    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(nowIso(), row.id);
    const { token, expires } = createSession(db, row.id);
    req.user = { id: row.id, username: row.username };
    audit(db, req, 'auth.login', 'user', row.id);
    res.setHeader('Set-Cookie', sessionCookie(token, expires, secure(req)));
    res.json({ ok: true });
  });

  api.post('/auth/logout', (req, res) => {
    if (req.user) ctx.db().prepare('DELETE FROM sessions WHERE id = ?').run(req.user.sessionId);
    res.setHeader('Set-Cookie', clearCookie(secure(req)));
    res.json({ ok: true });
  });

  // Turns the sign-in screen on (setting the owner's username and password at
  // the same time) or off again. Owner only.
  api.post('/auth/require-login', (req, res) => {
    if (!req.user) throw new HttpError(401, 'Please sign in');
    if (!can(req.user, 'settings.manage')) throw new HttpError(403, 'Only the owner can change this');
    const db = ctx.db();
    if (req.body.enabled) {
      const username = str(req.body.username, { required: true, max: 40, label: 'Username' });
      validatePassword(req.body.password);
      const taken = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(username, req.user.id);
      if (taken) throw new HttpError(409, 'That username is already used by another account');
      db.prepare('UPDATE users SET username = ?, password_hash = ?, updated_at = ? WHERE id = ?').run(username, hashPassword(req.body.password), nowIso(), req.user.id);
      ctx.settings.set('require_login', '1', req.user.id);
      audit(db, req, 'auth.login_required', 'user', req.user.id, { enabled: true });
      const { token, expires } = createSession(db, req.user.id);
      res.setHeader('Set-Cookie', sessionCookie(token, expires, secure(req)));
    } else {
      ctx.settings.set('require_login', '0', req.user.id);
      audit(db, req, 'auth.login_required', 'user', req.user.id, { enabled: false });
    }
    res.json({ ok: true, requireLogin: !!req.body.enabled });
  });

  api.post('/auth/password', (req, res) => {
    if (!req.user) throw new HttpError(401, 'Please sign in');
    const db = ctx.db();
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    if (!verifyPassword(String(req.body.currentPassword || ''), row.password_hash)) throw new HttpError(400, 'Current password is incorrect');
    validatePassword(req.body.newPassword);
    db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(hashPassword(req.body.newPassword), nowIso(), req.user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(req.user.id, req.user.sessionId);
    audit(db, req, 'user.password_changed', 'user', req.user.id);
    res.json({ ok: true });
  });
};

module.exports.validatePassword = validatePassword;
module.exports.userPayload = userPayload;
module.exports.can = can;

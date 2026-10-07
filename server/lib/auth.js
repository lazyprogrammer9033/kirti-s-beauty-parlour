'use strict';

const crypto = require('crypto');
const { sha256 } = require('./secrets');

const COOKIE = 'salon_sid';
const SESSION_DAYS = 14;

const ROLE_PERMISSIONS = {
  owner: ['*'],
  staff: [
    'customers.view',
    'customers.edit',
    'visits.create',
    'invoices.view',
    'payments.record',
    'services.view',
  ],
};

function can(user, permission) {
  if (!user) return false;
  const perms = ROLE_PERMISSIONS[user.role] || [];
  return perms.includes('*') || perms.includes(permission);
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 86400000);
  db.prepare('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run(sha256(token), userId, expires.toISOString(), now.toISOString());
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now.toISOString());
  return { token, expires };
}

function sessionCookie(token, expires, secure) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Expires=${expires.toUTCString()}${secure ? '; Secure' : ''}`;
}

function clearCookie(secure) {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secure ? '; Secure' : ''}`;
}

function loadUser(db, req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const row = db.prepare(`SELECT u.id, u.username, u.display_name, u.active, r.code AS role, s.id AS sid, s.expires_at
    FROM sessions s JOIN users u ON u.id = s.user_id JOIN roles r ON r.id = u.role_id WHERE s.id = ?`).get(sha256(token));
  if (!row || !row.active || row.expires_at < new Date().toISOString()) return null;
  return { id: row.id, username: row.username, displayName: row.display_name, role: row.role, sessionId: row.sid };
}

// Simple in-memory brute-force protection for the login form.
class LoginLimiter {
  constructor({ maxFailures = 5, lockMs = 5 * 60 * 1000 } = {}) {
    this.maxFailures = maxFailures;
    this.lockMs = lockMs;
    this.map = new Map();
  }
  key(ip, username) {
    return ip + '|' + String(username || '').toLowerCase();
  }
  isLocked(ip, username) {
    const e = this.map.get(this.key(ip, username));
    return !!(e && e.lockedUntil && e.lockedUntil > Date.now());
  }
  fail(ip, username) {
    const k = this.key(ip, username);
    const e = this.map.get(k) || { count: 0 };
    e.count += 1;
    if (e.count >= this.maxFailures) {
      e.lockedUntil = Date.now() + this.lockMs;
      e.count = 0;
    }
    this.map.set(k, e);
  }
  success(ip, username) {
    this.map.delete(this.key(ip, username));
  }
}

module.exports = { COOKIE, can, createSession, sessionCookie, clearCookie, loadUser, LoginLimiter, ROLE_PERMISSIONS, parseCookies };

'use strict';

const { requirePerm, HttpError, intParam, str } = require('../lib/http');
const { hashPassword } = require('../lib/secrets');
const { audit } = require('../lib/audit');
const { nowIso } = require('../lib/time');
const { validatePassword } = require('./auth');

module.exports = function userRoutes(api, ctx) {
  const owner = requirePerm('users.manage');

  // Staff list (names only) is needed by everyone to pick "performed by".
  api.get('/staff', (req, res) => {
    res.json(ctx.db().prepare('SELECT id, display_name AS displayName FROM users WHERE active = 1 ORDER BY display_name').all());
  });

  api.get('/users', owner, (req, res) => {
    res.json(ctx.db().prepare(`SELECT u.id, u.username, u.display_name AS displayName, r.code AS role, u.active, u.last_login_at AS lastLoginAt, u.created_at AS createdAt
      FROM users u JOIN roles r ON r.id = u.role_id ORDER BY u.active DESC, u.display_name`).all());
  });

  const roleId = (db, code) => {
    const r = db.prepare('SELECT id FROM roles WHERE code = ?').get(code);
    if (!r) throw new HttpError(400, 'Invalid role');
    return r.id;
  };

  api.post('/users', owner, (req, res) => {
    const db = ctx.db();
    const displayName = str(req.body.displayName, { required: true, max: 80, label: 'Name' });
    const username = str(req.body.username, { required: true, max: 40, label: 'Username' });
    if (!/^[a-zA-Z0-9._-]+$/.test(username)) throw new HttpError(400, 'Username may only contain letters, numbers, dot, dash and underscore');
    validatePassword(req.body.password);
    const role = req.body.role === 'owner' ? 'owner' : 'staff';
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new HttpError(409, 'That username is already taken');
    const now = nowIso();
    const id = db.prepare('INSERT INTO users (username, display_name, password_hash, role_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(username, displayName, hashPassword(req.body.password), roleId(db, role), now, now).lastInsertRowid;
    audit(db, req, 'user.created', 'user', id, { username, role });
    res.json({ id });
  });

  api.put('/users/:id', owner, (req, res) => {
    const db = ctx.db();
    const id = intParam(req.params.id);
    const user = db.prepare('SELECT u.*, r.code AS role FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?').get(id);
    if (!user) throw new HttpError(404, 'User not found');
    const displayName = req.body.displayName != null ? str(req.body.displayName, { required: true, max: 80, label: 'Name' }) : user.display_name;
    const role = req.body.role ? (req.body.role === 'owner' ? 'owner' : 'staff') : user.role;
    const active = req.body.active != null ? (req.body.active ? 1 : 0) : user.active;
    const ownersLeft = db.prepare(`SELECT COUNT(*) c FROM users u JOIN roles r ON r.id = u.role_id WHERE r.code = 'owner' AND u.active = 1 AND u.id != ?`).get(id).c;
    if (user.role === 'owner' && (role !== 'owner' || !active) && ownersLeft === 0) {
      throw new HttpError(400, 'There must always be at least one active owner');
    }
    const changes = {};
    db.transaction(() => {
      db.prepare('UPDATE users SET display_name = ?, role_id = ?, active = ?, updated_at = ? WHERE id = ?').run(displayName, roleId(db, role), active, nowIso(), id);
      if (req.body.password) {
        validatePassword(req.body.password);
        db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(req.body.password), id);
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
        changes.passwordReset = true;
      }
      if (!active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    })();
    if (displayName !== user.display_name) changes.displayName = displayName;
    if (role !== user.role) changes.role = { from: user.role, to: role };
    if (active !== user.active) changes.active = !!active;
    audit(db, req, 'user.updated', 'user', id, changes);
    res.json({ ok: true });
  });
};

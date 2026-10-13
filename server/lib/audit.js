'use strict';

const { nowIso } = require('./time');

function audit(db, req, action, entityType, entityId, details) {
  const user = req && req.user;
  db.prepare(`INSERT INTO audit_logs (user_id, username, action, entity_type, entity_id, details, ip, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    user ? user.id : null,
    user ? user.username : null,
    action,
    entityType || null,
    entityId == null ? null : String(entityId),
    details == null ? null : JSON.stringify(details),
    req ? req.ip : null,
    nowIso()
  );
}

module.exports = { audit };

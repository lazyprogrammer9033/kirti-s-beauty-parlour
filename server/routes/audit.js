'use strict';

const { requirePerm } = require('../lib/http');

// Read-only: the audit log has no update or delete endpoint, and database
// triggers reject any attempt to change it.
module.exports = function auditRoutes(api, ctx) {
  api.get('/audit', requirePerm('audit.view'), (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const cond = [];
    const args = [];
    if (req.query.action) cond.push('action LIKE ?') && args.push(String(req.query.action) + '%');
    if (req.query.entityType) cond.push('entity_type = ?') && args.push(String(req.query.entityType));
    if (req.query.entityId) cond.push('entity_id = ?') && args.push(String(req.query.entityId));
    const rows = ctx.db().prepare(`SELECT id, username, action, entity_type AS entityType, entity_id AS entityId, details, ip, created_at AS createdAt
      FROM audit_logs ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
    res.json(rows.map((r) => ({ ...r, details: r.details ? JSON.parse(r.details) : null })));
  });
};

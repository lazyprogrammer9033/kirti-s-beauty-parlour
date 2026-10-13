'use strict';

const { requirePerm } = require('../lib/http');
const { catalogue } = require('./services');
const { localNames } = require('../lib/tls');

// Everything the iPad needs to keep checking customers in while the salon
// computer is unreachable: services, staff, tax and a light customer list.
module.exports = function offlineRoutes(api, ctx) {
  // Addresses for the one-time iPad setup in Settings.
  api.get('/offline/setup', requirePerm('settings.manage'), (req, res) => {
    const { dns, ips } = localNames();
    res.json({ https: ctx.https || null, host: dns[2], ips: ips.filter((ip) => ip !== '127.0.0.1') });
  });

  api.get('/offline/snapshot', requirePerm('visits.create'), (req, res) => {
    const db = ctx.db();
    const customers = db.prepare(`SELECT c.id, c.customer_code AS customerCode, c.full_name AS fullName, c.phone, c.phone_digits AS phoneDigits, c.email,
        (SELECT COUNT(*) FROM visits v WHERE v.customer_id = c.id AND v.status = 'completed') AS totalVisits,
        (SELECT MAX(v.visit_at) FROM visits v WHERE v.customer_id = c.id AND v.status = 'completed') AS lastVisitAt,
        (SELECT GROUP_CONCAT(vs.service_name, '|') FROM visit_services vs WHERE vs.visit_id =
          (SELECT v.id FROM visits v WHERE v.customer_id = c.id AND v.status = 'completed' ORDER BY v.visit_at DESC, v.id DESC LIMIT 1)) AS lastServices,
        (SELECT COALESCE(SUM(i.balance_cents), 0) FROM invoices i WHERE i.customer_id = c.id AND i.status IN ('unpaid', 'partial')) AS balanceCents
      FROM customers c WHERE c.status = 'active' ORDER BY c.id`).all();
    const notes = db.prepare(`SELECT customer_id AS customerId, note FROM customer_notes
      WHERE customer_id IN (SELECT id FROM customers WHERE status = 'active') ORDER BY created_at DESC, id DESC`).all();
    const notesBy = new Map();
    for (const n of notes) {
      const list = notesBy.get(n.customerId) || [];
      if (list.length < 3) list.push({ note: n.note });
      notesBy.set(n.customerId, list);
    }
    for (const c of customers) {
      c.lastServices = c.lastServices ? c.lastServices.split('|') : [];
      c.notes = notesBy.get(c.id) || [];
    }
    res.json({
      at: new Date().toISOString(),
      catalogue: catalogue(db, false),
      staff: db.prepare('SELECT id, display_name AS displayName FROM users WHERE active = 1 ORDER BY display_name').all(),
      tax: ctx.settings.tax(),
      customers,
    });
  });
};

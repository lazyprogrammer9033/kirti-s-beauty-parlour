'use strict';

const { requirePerm, HttpError, intParam, str } = require('../lib/http');
const { can } = require('../lib/auth');
const { normalizePhone, formatPhone } = require('../lib/phone');
const { nextCustomerCode } = require('../lib/codes');
const { audit } = require('../lib/audit');
const { nowIso, businessDate, isValidYmd } = require('../lib/time');

// Columns shown on search results: identity plus visit summary.
const SUMMARY_SELECT = `
  c.id, c.customer_code AS customerCode, c.full_name AS fullName, c.phone, c.email, c.status,
  (SELECT COUNT(*) FROM visits v WHERE v.customer_id = c.id AND v.status = 'completed') AS totalVisits,
  (SELECT MAX(v.visit_at) FROM visits v WHERE v.customer_id = c.id AND v.status = 'completed') AS lastVisitAt,
  (SELECT COALESCE(SUM(i.total_cents), 0) FROM invoices i WHERE i.customer_id = c.id AND i.status != 'void') AS totalSpentCents,
  (SELECT COALESCE(SUM(i.balance_cents), 0) FROM invoices i WHERE i.customer_id = c.id AND i.status != 'void') AS balanceCents`;

function searchCustomers(db, rawQuery, limit = 20) {
  const q = String(rawQuery || '').trim();
  if (!q) return [];
  const digits = q.replace(/[\s()+.-]/g, '');

  if (/^cus-?\d+$/i.test(q)) {
    const num = q.replace(/\D/g, '');
    const code = 'CUS-' + num.padStart(6, '0');
    return db.prepare(`SELECT ${SUMMARY_SELECT} FROM customers c WHERE c.customer_code = ? OR c.customer_code LIKE ? LIMIT ?`)
      .all(code, 'CUS-%' + num, limit);
  }
  if (/^\d{3,}$/.test(digits)) {
    const p = normalizePhone(digits);
    // Prefix match uses the phone index; suffix match helps "last 4 digits" searches.
    return db.prepare(`SELECT ${SUMMARY_SELECT} FROM customers c
      WHERE (c.phone_digits >= ? AND c.phone_digits < ?) OR (length(?) >= 4 AND c.phone_digits LIKE ?)
      ORDER BY (c.phone_digits = ?) DESC, (c.status = 'active') DESC, c.full_name LIMIT ?`)
      .all(p, p + ':', p, '%' + p, p, limit);
  }
  if (q.includes('@')) {
    return db.prepare(`SELECT ${SUMMARY_SELECT} FROM customers c WHERE c.email LIKE ? ORDER BY c.full_name LIMIT ?`)
      .all('%' + q.toLowerCase() + '%', limit);
  }
  const words = q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 5);
  const where = words.map(() => 'c.name_search LIKE ?').join(' AND ');
  return db.prepare(`SELECT ${SUMMARY_SELECT} FROM customers c WHERE ${where}
    ORDER BY (c.name_search LIKE ?) DESC, (c.status = 'active') DESC, c.full_name LIMIT ?`)
    .all(...words.map((w) => '%' + w + '%'), words[0] + '%', limit);
}

function readCustomerInput(body) {
  const fullName = str(body.fullName, { required: true, max: 120, label: 'Full name' });
  const phoneRaw = str(body.phone, { required: true, max: 30, label: 'Phone number' });
  const digits = normalizePhone(phoneRaw);
  if (digits.length < 7 || digits.length > 15) throw new HttpError(400, 'Please enter a valid phone number');
  const email = str(body.email, { max: 160 });
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Please enter a valid email address');
  const dob = str(body.dateOfBirth, { max: 10 });
  if (dob && !isValidYmd(dob)) throw new HttpError(400, 'Invalid date of birth');
  const firstVisit = str(body.firstVisitDate, { max: 10 });
  if (firstVisit && !isValidYmd(firstVisit)) throw new HttpError(400, 'Invalid first visit date');
  const status = body.status === 'inactive' ? 'inactive' : 'active';
  return {
    fullName,
    phone: formatPhone(phoneRaw),
    phoneDigits: digits,
    email: email ? email.toLowerCase() : null,
    dateOfBirth: dob,
    address: str(body.address, { max: 300 }),
    preferredServices: str(body.preferredServices, { max: 300 }),
    referralSource: str(body.referralSource, { max: 120 }),
    firstVisitDate: firstVisit,
    status,
    notes: str(body.notes, { max: 2000 }),
  };
}

function customerProfile(db, id) {
  const c = db.prepare(`SELECT id, customer_code AS customerCode, full_name AS fullName, phone, email, date_of_birth AS dateOfBirth,
      address, preferred_services AS preferredServices, referral_source AS referralSource, first_visit_date AS firstVisitDate,
      status, created_at AS createdAt, updated_at AS updatedAt
    FROM customers WHERE id = ?`).get(id);
  if (!c) return null;

  const stats = db.prepare(`SELECT COUNT(*) AS totalVisits, MIN(v.visit_at) AS firstVisitAt, MAX(v.visit_at) AS lastVisitAt,
      COALESCE(SUM(i.total_cents), 0) AS totalSpentCents, COALESCE(SUM(i.balance_cents), 0) AS balanceCents
    FROM visits v JOIN invoices i ON i.visit_id = v.id WHERE v.customer_id = ? AND v.status = 'completed'`).get(id);
  stats.averageCents = stats.totalVisits ? Math.round(stats.totalSpentCents / stats.totalVisits) : 0;

  const favourites = db.prepare(`SELECT vs.service_name AS name, SUM(vs.quantity) AS count
    FROM visit_services vs JOIN visits v ON v.id = vs.visit_id
    WHERE v.customer_id = ? AND v.status = 'completed' GROUP BY vs.service_name ORDER BY count DESC, MAX(v.visit_at) DESC LIMIT 5`).all(id);

  const lastPayment = db.prepare(`SELECT p.amount_cents AS amountCents, p.method, p.received_at AS receivedAt
    FROM payments p WHERE p.customer_id = ? AND p.status = 'completed' ORDER BY p.received_at DESC, p.id DESC LIMIT 1`).get(id) || null;

  const visits = db.prepare(`SELECT v.id, v.visit_code AS visitCode, v.visit_at AS visitAt, v.status, v.notes,
      u.display_name AS staffName, i.id AS invoiceId, i.invoice_number AS invoiceNumber, i.total_cents AS totalCents,
      i.discount_cents AS discountCents, i.tax_cents AS taxCents, i.balance_cents AS balanceCents, i.status AS invoiceStatus
    FROM visits v JOIN invoices i ON i.visit_id = v.id LEFT JOIN users u ON u.id = v.staff_user_id
    WHERE v.customer_id = ? ORDER BY v.visit_at DESC, v.id DESC`).all(id);

  if (visits.length) {
    const ids = visits.map((v) => v.id);
    const marks = ids.map(() => '?').join(',');
    const services = db.prepare(`SELECT visit_id AS visitId, service_id AS serviceId, service_name AS name, unit_price_cents AS unitPriceCents, quantity
      FROM visit_services WHERE visit_id IN (${marks}) ORDER BY id`).all(...ids);
    const pays = db.prepare(`SELECT p.invoice_id AS invoiceId, p.method, p.amount_cents AS amountCents
      FROM payments p WHERE p.invoice_id IN (SELECT id FROM invoices WHERE visit_id IN (${marks})) AND p.status = 'completed' ORDER BY p.id`).all(...ids);
    const customItems = db.prepare(`SELECT ii.invoice_id AS invoiceId, ii.description AS name, ii.unit_price_cents AS unitPriceCents, ii.quantity
      FROM invoice_items ii WHERE ii.item_type = 'custom' AND ii.invoice_id IN (SELECT id FROM invoices WHERE visit_id IN (${marks}))`).all(...ids);
    for (const v of visits) {
      v.services = services.filter((s) => s.visitId === v.id).concat(customItems.filter((s) => s.invoiceId === v.invoiceId));
      v.payments = pays.filter((p) => p.invoiceId === v.invoiceId);
    }
  }

  const completed = visits.filter((v) => v.status === 'completed');
  const notes = db.prepare(`SELECT n.id, n.note, n.created_at AS createdAt, u.display_name AS author
    FROM customer_notes n LEFT JOIN users u ON u.id = n.created_by WHERE n.customer_id = ? ORDER BY n.created_at DESC, n.id DESC`).all(id);

  return {
    ...c,
    stats: {
      ...stats,
      favouriteServices: favourites,
      lastServices: completed.length ? completed[0].services.map((s) => s.name) : [],
      lastPayment,
    },
    notes,
    visits,
  };
}

module.exports = function customerRoutes(api, ctx) {
  const view = requirePerm('customers.view');
  const edit = requirePerm('customers.edit');

  api.get('/customers/search', view, (req, res) => {
    res.json(searchCustomers(ctx.db(), req.query.q));
  });

  // Exact phone match, used to warn before creating a duplicate.
  api.get('/customers/by-phone', view, (req, res) => {
    const digits = normalizePhone(req.query.phone);
    if (digits.length < 7) return res.json([]);
    res.json(ctx.db().prepare(`SELECT c.id, c.customer_code AS customerCode, c.full_name AS fullName, c.phone, c.status FROM customers c WHERE c.phone_digits = ?`).all(digits));
  });

  api.get('/customers', view, (req, res) => {
    const db = ctx.db();
    const status = ['active', 'inactive'].includes(req.query.status) ? req.query.status : null;
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const sort = { name: 'c.full_name', recent: 'lastVisitAt DESC', created: 'c.id DESC', spent: 'totalSpentCents DESC' }[req.query.sort] || 'c.full_name';
    const where = status ? 'WHERE c.status = ?' : '';
    const args = status ? [status] : [];
    const rows = db.prepare(`SELECT ${SUMMARY_SELECT} FROM customers c ${where} ORDER BY ${sort} LIMIT ? OFFSET ?`).all(...args, limit, offset);
    const total = db.prepare(`SELECT COUNT(*) c FROM customers c ${where}`).get(...args).c;
    res.json({ rows, total });
  });

  api.post('/customers', edit, (req, res) => {
    const db = ctx.db();
    const input = readCustomerInput(req.body);
    const dupes = db.prepare('SELECT id, customer_code AS customerCode, full_name AS fullName, phone FROM customers WHERE phone_digits = ?').all(input.phoneDigits);
    if (dupes.length && !req.body.confirmDuplicate) {
      throw new HttpError(409, 'A customer with this phone number already exists', { duplicates: dupes });
    }
    const now = nowIso();
    const today = businessDate(new Date(), ctx.settings.timezone());
    const created = db.transaction(() => {
      const code = nextCustomerCode(db);
      const id = db.prepare(`INSERT INTO customers (customer_code, full_name, name_search, phone, phone_digits, email, date_of_birth, address,
          preferred_services, referral_source, first_visit_date, status, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        code, input.fullName, input.fullName.toLowerCase(), input.phone, input.phoneDigits, input.email, input.dateOfBirth, input.address,
        input.preferredServices, input.referralSource, input.firstVisitDate || today, input.status, req.user.id, now, now
      ).lastInsertRowid;
      if (input.notes) {
        db.prepare('INSERT INTO customer_notes (customer_id, note, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, input.notes, req.user.id, now, now);
      }
      audit(db, req, 'customer.created', 'customer', id, { customerCode: code, duplicatePhoneConfirmed: dupes.length > 0 });
      return { id, customerCode: code };
    })();
    res.status(201).json(created);
  });

  api.get('/customers/:id', view, (req, res) => {
    const p = customerProfile(ctx.db(), intParam(req.params.id));
    if (!p) throw new HttpError(404, 'Customer not found');
    res.json(p);
  });

  api.put('/customers/:id', edit, (req, res) => {
    const db = ctx.db();
    const id = intParam(req.params.id);
    const before = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
    if (!before) throw new HttpError(404, 'Customer not found');
    const input = readCustomerInput({ ...req.body, firstVisitDate: req.body.firstVisitDate ?? before.first_visit_date });
    if (input.status !== before.status && input.status === 'inactive' && !can(req.user, 'customers.deactivate')) {
      throw new HttpError(403, 'Only the owner can mark a customer inactive');
    }
    if (input.phoneDigits !== before.phone_digits) {
      const dupes = db.prepare('SELECT id, customer_code AS customerCode, full_name AS fullName, phone FROM customers WHERE phone_digits = ? AND id != ?').all(input.phoneDigits, id);
      if (dupes.length && !req.body.confirmDuplicate) throw new HttpError(409, 'Another customer already has this phone number', { duplicates: dupes });
    }
    db.prepare(`UPDATE customers SET full_name = ?, name_search = ?, phone = ?, phone_digits = ?, email = ?, date_of_birth = ?, address = ?,
        preferred_services = ?, referral_source = ?, first_visit_date = ?, status = ?, updated_at = ? WHERE id = ?`).run(
      input.fullName, input.fullName.toLowerCase(), input.phone, input.phoneDigits, input.email, input.dateOfBirth, input.address,
      input.preferredServices, input.referralSource, input.firstVisitDate, input.status, nowIso(), id
    );
    const fields = { full_name: input.fullName, phone: input.phone, email: input.email, date_of_birth: input.dateOfBirth, address: input.address,
      preferred_services: input.preferredServices, referral_source: input.referralSource, first_visit_date: input.firstVisitDate, status: input.status };
    const changed = Object.keys(fields).filter((k) => (before[k] ?? null) !== (fields[k] ?? null));
    audit(db, req, 'customer.updated', 'customer', id, { changed, ...(changed.includes('status') ? { status: input.status } : {}) });
    res.json({ ok: true });
  });

  api.post('/customers/:id/notes', edit, (req, res) => {
    const db = ctx.db();
    const id = intParam(req.params.id);
    if (!db.prepare('SELECT 1 FROM customers WHERE id = ?').get(id)) throw new HttpError(404, 'Customer not found');
    const note = str(req.body.note, { required: true, max: 2000, label: 'Note' });
    const now = nowIso();
    const nid = db.prepare('INSERT INTO customer_notes (customer_id, note, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, note, req.user.id, now, now).lastInsertRowid;
    audit(db, req, 'customer.note_added', 'customer', id, { noteId: nid });
    res.status(201).json({ id: nid });
  });
};

module.exports.searchCustomers = searchCustomers;
module.exports.customerProfile = customerProfile;

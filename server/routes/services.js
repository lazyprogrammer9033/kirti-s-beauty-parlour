'use strict';

const { requirePerm, HttpError, intParam, str } = require('../lib/http');
const { toCents } = require('../lib/money');
const { audit } = require('../lib/audit');
const { nowIso } = require('../lib/time');

function catalogue(db, includeInactive) {
  const cats = db.prepare(`SELECT id, name, sort_order AS sortOrder, active FROM service_categories
    ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY sort_order, name`).all();
  const svcs = db.prepare(`SELECT id, category_id AS categoryId, name, description, price_cents AS priceCents, duration_minutes AS durationMinutes,
      taxable, active, sort_order AS sortOrder FROM services ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY sort_order, name`).all();
  return cats.map((c) => ({ ...c, services: svcs.filter((s) => s.categoryId === c.id) }));
}

function readService(body) {
  let priceCents;
  try {
    priceCents = toCents(body.price ?? body.priceCents / 100);
  } catch {
    throw new HttpError(400, 'Please enter a valid price');
  }
  if (priceCents < 0 || priceCents > 10000000) throw new HttpError(400, 'Please enter a valid price');
  const duration = body.durationMinutes === '' || body.durationMinutes == null ? null : Number(body.durationMinutes);
  if (duration != null && (!Number.isInteger(duration) || duration < 0 || duration > 1440)) throw new HttpError(400, 'Invalid duration');
  return {
    name: str(body.name, { required: true, max: 100, label: 'Service name' }),
    categoryId: intParam(body.categoryId, 'category'),
    description: str(body.description, { max: 500 }),
    priceCents,
    durationMinutes: duration,
    taxable: body.taxable === false || body.taxable === 0 || body.taxable === '0' ? 0 : 1,
    active: body.active === false || body.active === 0 || body.active === '0' ? 0 : 1,
  };
}

module.exports = function serviceRoutes(api, ctx) {
  const view = requirePerm('services.view');
  const manage = requirePerm('services.manage');

  api.get('/services', view, (req, res) => {
    res.json(catalogue(ctx.db(), req.query.all === '1'));
  });

  api.post('/service-categories', manage, (req, res) => {
    const db = ctx.db();
    const name = str(req.body.name, { required: true, max: 60, label: 'Category name' });
    if (db.prepare('SELECT 1 FROM service_categories WHERE name = ?').get(name)) throw new HttpError(409, 'That category already exists');
    const now = nowIso();
    const order = db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 m FROM service_categories').get().m;
    const id = db.prepare('INSERT INTO service_categories (name, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?)').run(name, order, now, now).lastInsertRowid;
    audit(db, req, 'category.created', 'service_category', id, { name });
    res.status(201).json({ id });
  });

  api.put('/service-categories/:id', manage, (req, res) => {
    const db = ctx.db();
    const id = intParam(req.params.id);
    const before = db.prepare('SELECT * FROM service_categories WHERE id = ?').get(id);
    if (!before) throw new HttpError(404, 'Category not found');
    const name = req.body.name != null ? str(req.body.name, { required: true, max: 60, label: 'Category name' }) : before.name;
    const active = req.body.active != null ? (req.body.active ? 1 : 0) : before.active;
    const clash = db.prepare('SELECT 1 FROM service_categories WHERE name = ? AND id != ?').get(name, id);
    if (clash) throw new HttpError(409, 'That category already exists');
    db.prepare('UPDATE service_categories SET name = ?, active = ?, updated_at = ? WHERE id = ?').run(name, active, nowIso(), id);
    audit(db, req, 'category.updated', 'service_category', id, { name, active: !!active });
    res.json({ ok: true });
  });

  api.post('/services', manage, (req, res) => {
    const db = ctx.db();
    const s = readService(req.body);
    if (!db.prepare('SELECT 1 FROM service_categories WHERE id = ?').get(s.categoryId)) throw new HttpError(400, 'Category not found');
    const now = nowIso();
    const order = db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 m FROM services WHERE category_id = ?').get(s.categoryId).m;
    const id = db.prepare(`INSERT INTO services (category_id, name, description, price_cents, duration_minutes, taxable, active, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(s.categoryId, s.name, s.description, s.priceCents, s.durationMinutes, s.taxable, s.active, order, now, now).lastInsertRowid;
    audit(db, req, 'service.created', 'service', id, { name: s.name, priceCents: s.priceCents });
    res.status(201).json({ id });
  });

  api.put('/services/:id', manage, (req, res) => {
    const db = ctx.db();
    const id = intParam(req.params.id);
    const before = db.prepare('SELECT * FROM services WHERE id = ?').get(id);
    if (!before) throw new HttpError(404, 'Service not found');
    const s = readService({ ...{ name: before.name, categoryId: before.category_id, priceCents: before.price_cents, taxable: before.taxable, active: before.active,
      durationMinutes: before.duration_minutes, description: before.description }, ...req.body });
    db.prepare(`UPDATE services SET category_id = ?, name = ?, description = ?, price_cents = ?, duration_minutes = ?, taxable = ?, active = ?, updated_at = ? WHERE id = ?`)
      .run(s.categoryId, s.name, s.description, s.priceCents, s.durationMinutes, s.taxable, s.active, nowIso(), id);
    if (s.priceCents !== before.price_cents) {
      audit(db, req, 'service.price_changed', 'service', id, { name: s.name, fromCents: before.price_cents, toCents: s.priceCents });
    }
    audit(db, req, 'service.updated', 'service', id, { name: s.name, active: !!s.active, taxable: !!s.taxable });
    res.json({ ok: true });
  });
};

module.exports.catalogue = catalogue;

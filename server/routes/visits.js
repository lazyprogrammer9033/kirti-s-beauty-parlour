'use strict';

const { requirePerm, HttpError, intParam, str } = require('../lib/http');
const { calculateInvoice, toCents } = require('../lib/money');
const { nextVisitCode, nextInvoiceNumber } = require('../lib/codes');
const { audit } = require('../lib/audit');
const { nowIso, businessDate } = require('../lib/time');

const PAYMENT_METHODS = ['cash', 'debit', 'credit', 'etransfer', 'other'];

function readDiscount(d, user, settings) {
  if (!d || !d.type) return null;
  let discount;
  if (d.type === 'percent') {
    const pct = Number(d.percent);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) throw new HttpError(400, 'Discount percent must be between 0 and 100');
    discount = { type: 'percent', value: Math.round(pct * 100) };
  } else if (d.type === 'amount') {
    let cents;
    try {
      cents = d.amountCents != null ? Number(d.amountCents) : toCents(d.amount);
    } catch {
      throw new HttpError(400, 'Please enter a valid discount amount');
    }
    if (!Number.isInteger(cents) || cents < 0) throw new HttpError(400, 'Please enter a valid discount amount');
    discount = { type: 'amount', value: cents };
  } else {
    throw new HttpError(400, 'Invalid discount type');
  }
  if (discount.value > 0 && user.role !== 'owner' && settings.get('staff_can_discount') !== '1') {
    throw new HttpError(403, 'Only the owner can give discounts');
  }
  return discount.value > 0 ? discount : null;
}

// Resolves requested items against the live catalogue. Service prices always
// come from the database, never from the browser.
function buildQuote(db, settings, body, user) {
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) throw new HttpError(400, 'Please select at least one service');
  if (items.length > 50) throw new HttpError(400, 'Too many items');
  const lines = items.map((it) => {
    const quantity = it.quantity == null ? 1 : Number(it.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) throw new HttpError(400, 'Quantity must be between 1 and 99');
    const staffUserId = it.staffUserId ? intParam(it.staffUserId, 'staff') : null;
    if (it.type === 'custom') {
      if (user.role !== 'owner' && settings.get('staff_can_custom_charge') !== '1') {
        throw new HttpError(403, 'Only the owner can add custom charges');
      }
      let price;
      try {
        price = it.priceCents != null ? Number(it.priceCents) : toCents(it.price);
      } catch {
        throw new HttpError(400, 'Please enter a valid price for the custom charge');
      }
      if (!Number.isInteger(price) || price < 0 || price > 10000000) throw new HttpError(400, 'Please enter a valid price for the custom charge');
      return {
        itemType: 'custom',
        serviceId: null,
        description: str(it.description, { required: true, max: 120, label: 'Custom charge description' }),
        categoryName: null,
        unitPriceCents: price,
        quantity,
        taxable: it.taxable === false ? 0 : 1,
        staffUserId,
      };
    }
    const sid = intParam(it.serviceId, 'service');
    const svc = db.prepare(`SELECT s.id, s.name, s.price_cents, s.taxable, s.active, c.name AS category
      FROM services s JOIN service_categories c ON c.id = s.category_id WHERE s.id = ?`).get(sid);
    if (!svc) throw new HttpError(400, 'Service not found');
    if (!svc.active) throw new HttpError(400, `${svc.name} is no longer offered`);
    return {
      itemType: 'service',
      serviceId: svc.id,
      description: svc.name,
      categoryName: svc.category,
      unitPriceCents: svc.price_cents,
      quantity,
      taxable: svc.taxable,
      staffUserId,
    };
  });
  const tax = settings.tax();
  const discount = readDiscount(body.discount, user, settings);
  let calc;
  try {
    calc = calculateInvoice({ items: lines, discount, taxRateBp: tax.rateBp, pricesIncludeTax: tax.pricesIncludeTax });
  } catch (e) {
    throw new HttpError(400, e.message);
  }
  return { calc, discount, tax };
}

function readPayments(list, totalCents) {
  const payments = (Array.isArray(list) ? list : []).filter((p) => p && Number(p.amountCents) > 0);
  if (payments.length > 5) throw new HttpError(400, 'Too many payments');
  let sum = 0;
  const out = payments.map((p) => {
    if (!PAYMENT_METHODS.includes(p.method)) throw new HttpError(400, 'Please choose a payment method');
    const amount = Number(p.amountCents);
    if (!Number.isInteger(amount) || amount <= 0) throw new HttpError(400, 'Invalid payment amount');
    sum += amount;
    return { method: p.method, amountCents: amount, reference: str(p.reference, { max: 100 }) };
  });
  if (sum > totalCents) throw new HttpError(400, 'Payments are more than the total. Enter the amount applied to the bill (give change separately).');
  return { payments: out, paidCents: sum };
}

const invoiceStatus = (total, paid) => (paid >= total ? 'paid' : paid > 0 ? 'partial' : 'unpaid');

module.exports = function visitRoutes(api, ctx) {
  const create = requirePerm('visits.create');

  api.post('/visits/quote', create, (req, res) => {
    const { calc, tax } = buildQuote(ctx.db(), ctx.settings, req.body, req.user);
    res.json({ ...calc, taxName: tax.name, taxRateBp: tax.rateBp, pricesIncludeTax: tax.pricesIncludeTax });
  });

  // Check-in + bill in one atomic step: visit, visit services, invoice, items, payments.
  api.post('/visits', create, (req, res) => {
    const db = ctx.db();
    const customerId = intParam(req.body.customerId, 'customer');
    const customer = db.prepare('SELECT id, customer_code, full_name, status FROM customers WHERE id = ?').get(customerId);
    if (!customer) throw new HttpError(404, 'Customer not found');
    const { calc, discount, tax } = buildQuote(db, ctx.settings, req.body, req.user);
    const { payments, paidCents } = readPayments(req.body.payments, calc.totalCents);
    const notes = str(req.body.notes, { max: 2000 });
    const staffUserId = req.body.staffUserId ? intParam(req.body.staffUserId, 'staff') : req.user.id;
    if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(staffUserId)) throw new HttpError(400, 'Staff member not found');
    if (paidCents < calc.totalCents && !req.body.allowBalance) {
      throw new HttpError(400, 'The bill is not fully paid. Confirm to leave a balance owing.', { needsBalanceConfirm: true });
    }

    const now = new Date();
    const nowStr = now.toISOString();
    const bdate = businessDate(now, ctx.settings.timezone());

    const result = db.transaction(() => {
      const prior = db.prepare("SELECT COUNT(*) c FROM visits WHERE customer_id = ? AND status = 'completed'").get(customerId).c;
      const visitCode = nextVisitCode(db);
      const visitId = db.prepare(`INSERT INTO visits (visit_code, customer_id, staff_user_id, visit_at, business_date, is_first_visit, status, notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?)`).run(visitCode, customerId, staffUserId, nowStr, bdate, prior === 0 ? 1 : 0, notes, nowStr, nowStr).lastInsertRowid;

      const invoiceNumber = nextInvoiceNumber(db, bdate.slice(0, 4));
      const balance = calc.totalCents - paidCents;
      const invoiceId = db.prepare(`INSERT INTO invoices (invoice_number, visit_id, customer_id, issued_at, business_date, currency, subtotal_cents,
          discount_type, discount_value, discount_cents, tax_name, tax_rate_bp, prices_include_tax, tax_cents, total_cents, paid_cents, balance_cents,
          status, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'CAD', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        invoiceNumber, visitId, customerId, nowStr, bdate, calc.subtotalCents, discount ? discount.type : null, discount ? discount.value : null,
        calc.discountCents, tax.name, tax.rateBp, tax.pricesIncludeTax ? 1 : 0, calc.taxCents, calc.totalCents, paidCents, balance,
        invoiceStatus(calc.totalCents, paidCents), req.user.id, nowStr, nowStr
      ).lastInsertRowid;

      const insVs = db.prepare(`INSERT INTO visit_services (visit_id, service_id, staff_user_id, service_name, category_name, unit_price_cents, quantity, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const insItem = db.prepare(`INSERT INTO invoice_items (invoice_id, visit_service_id, service_id, item_type, description, category_name, quantity, unit_price_cents,
          line_subtotal_cents, discount_cents, taxable, tax_cents, line_total_cents, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const l of calc.lines) {
        let vsId = null;
        if (l.itemType === 'service') {
          vsId = insVs.run(visitId, l.serviceId, l.staffUserId || staffUserId, l.description, l.categoryName, l.unitPriceCents, l.quantity, nowStr, nowStr).lastInsertRowid;
        }
        insItem.run(invoiceId, vsId, l.serviceId, l.itemType, l.description, l.categoryName, l.quantity, l.unitPriceCents, l.lineSubtotalCents,
          l.discountCents, l.taxable, l.taxCents, l.lineTotalCents, nowStr, nowStr);
      }

      const insPay = db.prepare(`INSERT INTO payments (invoice_id, customer_id, method, amount_cents, reference, received_at, business_date, received_by, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?)`);
      for (const p of payments) {
        const pid = insPay.run(invoiceId, customerId, p.method, p.amountCents, p.reference, nowStr, bdate, req.user.id, nowStr, nowStr).lastInsertRowid;
        audit(db, req, 'payment.recorded', 'payment', pid, { invoiceNumber, method: p.method, amountCents: p.amountCents });
      }
      audit(db, req, 'visit.created', 'visit', visitId, { visitCode, customerCode: customer.customer_code });
      audit(db, req, 'invoice.created', 'invoice', invoiceId, { invoiceNumber, totalCents: calc.totalCents, discountCents: calc.discountCents, taxCents: calc.taxCents });
      return { visitId, visitCode, invoiceId, invoiceNumber, totalCents: calc.totalCents, balanceCents: balance };
    })();

    res.status(201).json(result);
  });
};

module.exports.PAYMENT_METHODS = PAYMENT_METHODS;
module.exports.invoiceStatus = invoiceStatus;

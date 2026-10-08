'use strict';

const { requirePerm, HttpError, intParam, str } = require('../lib/http');
const { receiptPdf, METHOD_LABELS } = require('../lib/pdf');
const { formatCad } = require('../lib/money');
const { audit } = require('../lib/audit');
const { nowIso, businessDate, isValidYmd } = require('../lib/time');
const { PAYMENT_METHODS, invoiceStatus } = require('./visits');

function getInvoice(db, ref) {
  const where = /^\d+$/.test(String(ref)) ? 'i.id = ?' : 'i.invoice_number = ?';
  const inv = db.prepare(`SELECT i.id, i.invoice_number AS invoiceNumber, i.visit_id AS visitId, i.customer_id AS customerId, i.issued_at AS issuedAt,
      i.business_date AS businessDate, i.currency, i.subtotal_cents AS subtotalCents, i.discount_type AS discountType, i.discount_value AS discountValue,
      i.discount_cents AS discountCents, i.tax_name AS taxName, i.tax_rate_bp AS taxRateBp, i.prices_include_tax AS pricesIncludeTax,
      i.tax_cents AS taxCents, i.total_cents AS totalCents, i.paid_cents AS paidCents, i.balance_cents AS balanceCents, i.status,
      i.void_reason AS voidReason, i.voided_at AS voidedAt, vu.display_name AS voidedBy,
      v.visit_code AS visitCode, v.notes AS visitNotes, v.visit_at AS visitAt, su.display_name AS staffName, cu.display_name AS createdBy
    FROM invoices i JOIN visits v ON v.id = i.visit_id
    LEFT JOIN users su ON su.id = v.staff_user_id LEFT JOIN users cu ON cu.id = i.created_by LEFT JOIN users vu ON vu.id = i.voided_by
    WHERE ${where}`).get(ref);
  if (!inv) return null;
  inv.customer = db.prepare(`SELECT id, customer_code AS customerCode, full_name AS fullName, phone, email FROM customers WHERE id = ?`).get(inv.customerId);
  inv.items = db.prepare(`SELECT id, item_type AS itemType, service_id AS serviceId, description, category_name AS categoryName, quantity,
      unit_price_cents AS unitPriceCents, line_subtotal_cents AS lineSubtotalCents, discount_cents AS discountCents, taxable,
      tax_cents AS taxCents, line_total_cents AS lineTotalCents FROM invoice_items WHERE invoice_id = ? ORDER BY id`).all(inv.id);
  inv.payments = db.prepare(`SELECT p.id, p.method, p.amount_cents AS amountCents, p.reference, p.received_at AS receivedAt, p.status, u.display_name AS receivedBy
    FROM payments p LEFT JOIN users u ON u.id = p.received_by WHERE p.invoice_id = ? ORDER BY p.id`).all(inv.id);
  return inv;
}

function receiptText(inv, biz) {
  const lines = [
    `${biz.business_name}`,
    `Receipt ${inv.invoiceNumber}`,
    '',
    `Hi ${inv.customer.fullName.split(' ')[0]},`,
    '',
    `Thank you for your visit. Your receipt for ${formatCad(inv.totalCents)} is attached.`,
    '',
    ...inv.items.map((i) => `${i.description}${i.quantity > 1 ? ' x' + i.quantity : ''}  ${formatCad(i.lineSubtotalCents)}`),
    inv.discountCents ? `Discount  -${formatCad(inv.discountCents)}` : null,
    `${inv.taxName}  ${formatCad(inv.taxCents)}`,
    `Total  ${formatCad(inv.totalCents)} CAD`,
    ...inv.payments.filter((p) => p.status === 'completed').map((p) => `Paid (${METHOD_LABELS[p.method]})  ${formatCad(p.amountCents)}`),
    inv.balanceCents > 0 ? `Balance owing  ${formatCad(inv.balanceCents)}` : null,
    '',
    biz.receipt_footer || '',
    '',
    [biz.business_address, biz.business_phone, biz.business_website].filter(Boolean).join(' · '),
  ];
  return lines.filter((l) => l !== null).join('\n');
}

module.exports = function invoiceRoutes(api, ctx) {
  const view = requirePerm('invoices.view');
  const pay = requirePerm('payments.record');
  const voidPerm = requirePerm('invoices.void');

  api.get('/invoices', view, (req, res) => {
    const db = ctx.db();
    const cond = [];
    const args = [];
    if (isValidYmd(req.query.from)) cond.push('i.business_date >= ?') && args.push(req.query.from);
    if (isValidYmd(req.query.to)) cond.push('i.business_date <= ?') && args.push(req.query.to);
    if (req.query.status === 'outstanding') cond.push("i.status IN ('unpaid','partial')");
    else if (['paid', 'partial', 'unpaid', 'void'].includes(req.query.status)) cond.push('i.status = ?') && args.push(req.query.status);
    if (req.query.q) {
      const q = String(req.query.q).trim();
      cond.push('(i.invoice_number LIKE ? OR c.name_search LIKE ? OR c.phone_digits LIKE ?)');
      args.push('%' + q.toUpperCase() + '%', '%' + q.toLowerCase() + '%', '%' + q.replace(/\D/g, '') + '%');
    }
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const rows = db.prepare(`SELECT i.id, i.invoice_number AS invoiceNumber, i.issued_at AS issuedAt, i.total_cents AS totalCents, i.balance_cents AS balanceCents,
        i.status, c.id AS customerId, c.full_name AS customerName, c.phone,
        (SELECT GROUP_CONCAT(DISTINCT p.method) FROM payments p WHERE p.invoice_id = i.id AND p.status = 'completed') AS methods
      FROM invoices i JOIN customers c ON c.id = i.customer_id
      ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''} ORDER BY i.issued_at DESC, i.id DESC LIMIT ?`).all(...args, limit);
    res.json(rows);
  });

  api.get('/invoices/:ref', view, (req, res) => {
    const inv = getInvoice(ctx.db(), req.params.ref);
    if (!inv) throw new HttpError(404, 'Invoice not found');
    res.json(inv);
  });

  api.get('/invoices/:ref/pdf', view, async (req, res) => {
    const inv = getInvoice(ctx.db(), req.params.ref);
    if (!inv) throw new HttpError(404, 'Invoice not found');
    const pdf = await receiptPdf(inv, ctx.settings.all());
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${inv.invoiceNumber}.pdf"`);
    res.send(pdf);
  });

  api.post('/invoices/:ref/email', view, async (req, res) => {
    const db = ctx.db();
    const inv = getInvoice(db, req.params.ref);
    if (!inv) throw new HttpError(404, 'Invoice not found');
    const to = str(req.body.to, { max: 160 }) || inv.customer.email;
    if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new HttpError(400, 'This customer has no valid email address');
    const biz = ctx.settings.all();
    const pdf = await receiptPdf(inv, biz);
    try {
      await ctx.mailer.send({
        to,
        subject: `Your receipt from ${biz.business_name} (${inv.invoiceNumber})`,
        text: receiptText(inv, biz),
        attachments: [{ filename: inv.invoiceNumber + '.pdf', content: pdf, contentType: 'application/pdf' }],
      });
    } catch (e) {
      if (e.expose) throw e;
      throw new HttpError(502, 'The email could not be sent: ' + e.message);
    }
    audit(db, req, 'invoice.emailed', 'invoice', inv.id, { invoiceNumber: inv.invoiceNumber, to });
    res.json({ ok: true, to });
  });

  api.post('/invoices/:ref/drive', view, async (req, res) => {
    const inv = getInvoice(ctx.db(), req.params.ref);
    if (!inv) throw new HttpError(404, 'Invoice not found');
    const pdf = await receiptPdf(inv, ctx.settings.all());
    const file = await ctx.drive.upload('receipts', `${inv.invoiceNumber} - ${inv.customer.fullName}.pdf`, 'application/pdf', pdf);
    audit(ctx.db(), req, 'invoice.saved_to_drive', 'invoice', inv.id, { invoiceNumber: inv.invoiceNumber });
    res.json({ ok: true, fileId: file.id });
  });

  // Record a later payment against a balance owing.
  api.post('/invoices/:ref/payments', pay, (req, res) => {
    const db = ctx.db();
    const inv = getInvoice(db, req.params.ref);
    if (!inv) throw new HttpError(404, 'Invoice not found');
    if (inv.status === 'void') throw new HttpError(400, 'This invoice has been voided');
    const method = req.body.method;
    if (!PAYMENT_METHODS.includes(method)) throw new HttpError(400, 'Please choose a payment method');
    const amount = Number(req.body.amountCents);
    if (!Number.isInteger(amount) || amount <= 0) throw new HttpError(400, 'Invalid amount');
    const now = new Date();
    const bdate = businessDate(now, ctx.settings.timezone());
    db.transaction(() => {
      const fresh = db.prepare('SELECT total_cents, paid_cents, balance_cents FROM invoices WHERE id = ?').get(inv.id);
      if (amount > fresh.balance_cents) throw new HttpError(400, `The balance owing is only ${formatCad(fresh.balance_cents)}`);
      const pid = db.prepare(`INSERT INTO payments (invoice_id, customer_id, method, amount_cents, reference, received_at, business_date, received_by, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?)`).run(inv.id, inv.customerId, method, amount, str(req.body.reference, { max: 100 }), now.toISOString(), bdate, req.user.id, now.toISOString(), now.toISOString()).lastInsertRowid;
      const paid = fresh.paid_cents + amount;
      db.prepare('UPDATE invoices SET paid_cents = ?, balance_cents = ?, status = ?, updated_at = ? WHERE id = ?')
        .run(paid, fresh.total_cents - paid, invoiceStatus(fresh.total_cents, paid), now.toISOString(), inv.id);
      audit(db, req, 'payment.recorded', 'payment', pid, { invoiceNumber: inv.invoiceNumber, method, amountCents: amount });
    })();
    res.json(getInvoice(db, inv.id));
  });

  // Financial records are never deleted; voiding keeps them for the audit trail.
  api.post('/invoices/:ref/void', voidPerm, (req, res) => {
    const db = ctx.db();
    const inv = getInvoice(db, req.params.ref);
    if (!inv) throw new HttpError(404, 'Invoice not found');
    if (inv.status === 'void') throw new HttpError(400, 'This invoice is already void');
    const reason = str(req.body.reason, { required: true, max: 300, label: 'Reason' });
    const now = nowIso();
    db.transaction(() => {
      db.prepare("UPDATE invoices SET status = 'void', void_reason = ?, voided_at = ?, voided_by = ?, balance_cents = 0, updated_at = ? WHERE id = ?")
        .run(reason, now, req.user.id, now, inv.id);
      db.prepare("UPDATE visits SET status = 'void', updated_at = ? WHERE id = ?").run(now, inv.visitId);
      db.prepare("UPDATE payments SET status = 'void', updated_at = ? WHERE invoice_id = ? AND status = 'completed'").run(now, inv.id);
      audit(db, req, 'invoice.voided', 'invoice', inv.id, { invoiceNumber: inv.invoiceNumber, reason, totalCents: inv.totalCents, paidCents: inv.paidCents });
    })();
    res.json(getInvoice(db, inv.id));
  });

  api.put('/invoices/:ref/notes', pay, (req, res) => {
    const db = ctx.db();
    const inv = getInvoice(db, req.params.ref);
    if (!inv) throw new HttpError(404, 'Invoice not found');
    const notes = str(req.body.notes, { max: 2000 });
    db.prepare('UPDATE visits SET notes = ?, updated_at = ? WHERE id = ?').run(notes, nowIso(), inv.visitId);
    audit(db, req, 'visit.notes_updated', 'visit', inv.visitId, { invoiceNumber: inv.invoiceNumber, previous: inv.visitNotes });
    res.json({ ok: true });
  });
};

module.exports.getInvoice = getInvoice;

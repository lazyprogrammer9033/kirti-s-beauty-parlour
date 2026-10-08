'use strict';

const ExcelJS = require('exceljs');
const { requirePerm, HttpError, toCsv } = require('../lib/http');
const { audit } = require('../lib/audit');
const { businessDate } = require('../lib/time');

const money = (v) => (v == null ? '' : (v / 100).toFixed(2));

// Each export is a flat table the owner can open in Excel/Numbers.
const DATASETS = {
  customers: {
    sql: `SELECT customer_code, full_name, phone, email, date_of_birth, address, preferred_services, referral_source, first_visit_date, status, created_at, updated_at
      FROM customers ORDER BY id`,
    columns: ['customer_code', 'full_name', 'phone', 'email', 'date_of_birth', 'address', 'preferred_services', 'referral_source', 'first_visit_date', 'status', 'created_at', 'updated_at'],
  },
  customer_notes: {
    sql: `SELECT c.customer_code, n.note, u.display_name AS added_by, n.created_at FROM customer_notes n JOIN customers c ON c.id = n.customer_id
      LEFT JOIN users u ON u.id = n.created_by ORDER BY n.id`,
    columns: ['customer_code', 'note', 'added_by', 'created_at'],
  },
  visits: {
    sql: `SELECT v.visit_code, c.customer_code, c.full_name AS customer_name, v.visit_at, v.business_date, u.display_name AS staff, v.status, v.notes,
        i.invoice_number, (SELECT GROUP_CONCAT(service_name || CASE WHEN quantity > 1 THEN ' x' || quantity ELSE '' END, '; ') FROM visit_services WHERE visit_id = v.id) AS services
      FROM visits v JOIN customers c ON c.id = v.customer_id LEFT JOIN users u ON u.id = v.staff_user_id LEFT JOIN invoices i ON i.visit_id = v.id ORDER BY v.id`,
    columns: ['visit_code', 'customer_code', 'customer_name', 'visit_at', 'business_date', 'staff', 'status', 'services', 'notes', 'invoice_number'],
  },
  invoices: {
    sql: `SELECT i.invoice_number, v.visit_code, c.customer_code, c.full_name AS customer_name, i.issued_at, i.business_date, i.currency, i.subtotal_cents,
        i.discount_cents, i.tax_name, i.tax_rate_bp, i.tax_cents, i.total_cents, i.paid_cents, i.balance_cents, i.status, i.void_reason
      FROM invoices i JOIN visits v ON v.id = i.visit_id JOIN customers c ON c.id = i.customer_id ORDER BY i.id`,
    columns: ['invoice_number', 'visit_code', 'customer_code', 'customer_name', 'issued_at', 'business_date', 'currency', 'subtotal', 'discount', 'tax_name', 'tax_rate_percent', 'tax', 'total', 'paid', 'balance', 'status', 'void_reason'],
  },
  invoice_items: {
    sql: `SELECT i.invoice_number, ii.item_type, ii.description, ii.category_name, ii.quantity, ii.unit_price_cents, ii.line_subtotal_cents, ii.discount_cents,
        ii.taxable, ii.tax_cents, ii.line_total_cents FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id ORDER BY ii.id`,
    columns: ['invoice_number', 'item_type', 'description', 'category_name', 'quantity', 'unit_price', 'line_subtotal', 'discount', 'taxable', 'tax', 'line_total'],
  },
  payments: {
    sql: `SELECT i.invoice_number, c.customer_code, p.method, p.amount_cents, p.reference, p.received_at, p.business_date, u.display_name AS received_by, p.status
      FROM payments p JOIN invoices i ON i.id = p.invoice_id JOIN customers c ON c.id = p.customer_id LEFT JOIN users u ON u.id = p.received_by ORDER BY p.id`,
    columns: ['invoice_number', 'customer_code', 'method', 'amount', 'reference', 'received_at', 'business_date', 'received_by', 'status'],
  },
  services: {
    sql: `SELECT c.name AS category, s.name, s.description, s.price_cents, s.duration_minutes, s.taxable, s.active, s.created_at, s.updated_at
      FROM services s JOIN service_categories c ON c.id = s.category_id ORDER BY c.sort_order, s.sort_order`,
    columns: ['category', 'name', 'description', 'price', 'duration_minutes', 'taxable', 'active', 'created_at', 'updated_at'],
  },
};

// Converts *_cents columns to dollars and renames them to the exported column names.
function rowsFor(db, name) {
  const ds = DATASETS[name];
  return db.prepare(ds.sql).all().map((r) => {
    const out = {};
    for (const [k, v] of Object.entries(r)) {
      if (k.endsWith('_cents')) out[k.slice(0, -6)] = money(v);
      else if (k === 'tax_rate_bp') out.tax_rate_percent = (v / 100).toFixed(2);
      else out[k] = v;
    }
    return out;
  });
}

async function workbook(db) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Salon Manager';
  wb.created = new Date();
  for (const name of Object.keys(DATASETS)) {
    const ws = wb.addWorksheet(name);
    const cols = DATASETS[name].columns;
    ws.columns = cols.map((c) => ({ header: c, key: c, width: Math.min(Math.max(c.length + 2, 12), 40) }));
    ws.getRow(1).font = { bold: true };
    for (const r of rowsFor(db, name)) ws.addRow(r);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = function exportRoutes(api, ctx) {
  const owner = requirePerm('data.export');
  const stamp = () => businessDate(new Date(), ctx.settings.timezone());

  api.get('/export/all.xlsx', owner, async (req, res) => {
    const buf = await workbook(ctx.db());
    audit(ctx.db(), req, 'data.exported', 'export', 'all', { format: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="salon-data-${stamp()}.xlsx"`);
    res.send(buf);
  });

  api.post('/export/drive', owner, async (req, res) => {
    const buf = await workbook(ctx.db());
    const file = await ctx.drive.upload('exports', `Salon data export ${stamp()}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buf);
    audit(ctx.db(), req, 'data.exported', 'export', 'all', { format: 'xlsx', destination: 'google_drive' });
    res.json({ ok: true, fileId: file.id });
  });

  api.get('/export/:name.csv', owner, (req, res) => {
    const ds = DATASETS[req.params.name];
    if (!ds) throw new HttpError(404, 'Unknown export');
    const csv = toCsv(ds.columns.map((c) => ({ key: c, label: c })), rowsFor(ctx.db(), req.params.name));
    audit(ctx.db(), req, 'data.exported', 'export', req.params.name, { format: 'csv' });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.name}-${stamp()}.csv"`);
    res.send(csv);
  });
};

module.exports.DATASETS = DATASETS;
module.exports.rowsFor = rowsFor;

'use strict';

const { addDays } = require('./time');
const { METHOD_LABELS } = require('./pdf');

// Each report returns { title, subtitle, summary: [{label, value, type}], columns: [{key, label, type}], rows, chart? }.
// Types: money (cents), int, pct (0..1), text.

const VALID = "i.status != 'void'";

function salesReport(db, { from, to, group = 'day' }) {
  const period = {
    day: 'i.business_date',
    week: "date(i.business_date, '-' || ((CAST(strftime('%w', i.business_date) AS INTEGER) + 6) % 7) || ' days')",
    month: "substr(i.business_date, 1, 7)",
    year: "substr(i.business_date, 1, 4)",
  }[group] || 'i.business_date';
  const rows = db.prepare(`SELECT ${period} AS period, COUNT(*) AS invoices, SUM(i.subtotal_cents) AS subtotal, SUM(i.discount_cents) AS discount,
      SUM(i.tax_cents) AS tax, SUM(i.total_cents) AS total, SUM(i.paid_cents) AS paid, SUM(i.balance_cents) AS outstanding
    FROM invoices i WHERE ${VALID} AND i.business_date BETWEEN ? AND ? GROUP BY period ORDER BY period`).all(from, to);
  const t = rows.reduce((a, r) => ({ invoices: a.invoices + r.invoices, total: a.total + r.total, tax: a.tax + r.tax, discount: a.discount + r.discount, outstanding: a.outstanding + r.outstanding }),
    { invoices: 0, total: 0, tax: 0, discount: 0, outstanding: 0 });
  const voided = db.prepare("SELECT COUNT(*) c FROM invoices WHERE status = 'void' AND business_date BETWEEN ? AND ?").get(from, to).c;
  const label = { day: 'Date', week: 'Week of', month: 'Month', year: 'Year' }[group] || 'Date';
  return {
    title: 'Sales Report',
    summary: [
      { label: 'Total sales', value: t.total, type: 'money' },
      { label: 'Invoices', value: t.invoices, type: 'int' },
      { label: 'Average sale', value: t.invoices ? Math.round(t.total / t.invoices) : 0, type: 'money' },
      { label: 'Tax collected', value: t.tax, type: 'money' },
      { label: 'Discounts given', value: t.discount, type: 'money' },
      { label: 'Outstanding', value: t.outstanding, type: 'money' },
      { label: 'Voided invoices', value: voided, type: 'int' },
    ],
    columns: [
      { key: 'period', label, type: 'text' },
      { key: 'invoices', label: 'Invoices', type: 'int' },
      { key: 'subtotal', label: 'Subtotal', type: 'money' },
      { key: 'discount', label: 'Discounts', type: 'money' },
      { key: 'tax', label: 'Tax', type: 'money' },
      { key: 'total', label: 'Total', type: 'money' },
      { key: 'outstanding', label: 'Outstanding', type: 'money' },
    ],
    rows,
    chart: { labelKey: 'period', valueKey: 'total', type: 'money' },
  };
}

function customerReport(db, { from, to }) {
  const total = db.prepare('SELECT COUNT(*) c FROM customers').get().c;
  const active = db.prepare("SELECT COUNT(*) c FROM customers WHERE status = 'active'").get().c;
  const inRange = db.prepare(`SELECT COUNT(DISTINCT customer_id) AS visitors,
      COUNT(DISTINCT CASE WHEN is_first_visit = 1 THEN customer_id END) AS newCustomers
    FROM visits WHERE status = 'completed' AND business_date BETWEEN ? AND ?`).get(from, to);
  const registered = db.prepare('SELECT COUNT(*) c FROM customers WHERE substr(created_at, 1, 10) BETWEEN ? AND ?').get(from, to).c;
  const lapsedSince = addDays(to, -90);
  const lapsed = db.prepare(`SELECT COUNT(*) c FROM customers c WHERE c.status = 'active' AND EXISTS (SELECT 1 FROM visits v WHERE v.customer_id = c.id AND v.status = 'completed')
    AND NOT EXISTS (SELECT 1 FROM visits v WHERE v.customer_id = c.id AND v.status = 'completed' AND v.business_date > ?)`).get(lapsedSince).c;

  const buckets = [
    ['1 visit', 1, 1],
    ['2–3 visits', 2, 3],
    ['4–6 visits', 4, 6],
    ['7–12 visits', 7, 12],
    ['13+ visits', 13, 1e9],
  ];
  const counts = db.prepare(`SELECT customer_id, COUNT(*) n FROM visits WHERE status = 'completed' AND business_date BETWEEN ? AND ? GROUP BY customer_id`).all(from, to);
  const rows = buckets.map(([label, lo, hi]) => {
    const n = counts.filter((c) => c.n >= lo && c.n <= hi).length;
    return { bucket: label, customers: n, share: counts.length ? n / counts.length : 0 };
  });
  return {
    title: 'Customer Report',
    summary: [
      { label: 'Total customers', value: total, type: 'int' },
      { label: 'Active customers', value: active, type: 'int' },
      { label: 'Inactive customers', value: total - active, type: 'int' },
      { label: 'Customers who visited', value: inRange.visitors, type: 'int' },
      { label: 'New customers (first visit)', value: inRange.newCustomers, type: 'int' },
      { label: 'Returning customers', value: inRange.visitors - inRange.newCustomers, type: 'int' },
      { label: 'Registered in period', value: registered, type: 'int' },
      { label: 'Not seen in 90+ days', value: lapsed, type: 'int' },
    ],
    columns: [
      { key: 'bucket', label: 'Visit frequency', type: 'text' },
      { key: 'customers', label: 'Customers', type: 'int' },
      { key: 'share', label: 'Share', type: 'pct' },
    ],
    rows,
    chart: { labelKey: 'bucket', valueKey: 'customers', type: 'int' },
  };
}

function serviceReport(db, { from, to }) {
  const rows = db.prepare(`SELECT ii.description AS service, COALESCE(ii.category_name, 'Custom') AS category, SUM(ii.quantity) AS count,
      SUM(ii.line_subtotal_cents - ii.discount_cents) AS revenue
    FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
    WHERE ${VALID} AND i.business_date BETWEEN ? AND ? GROUP BY ii.description, ii.category_name ORDER BY revenue DESC`).all(from, to);
  const totalRev = rows.reduce((s, r) => s + r.revenue, 0);
  rows.forEach((r) => (r.share = totalRev ? r.revenue / totalRev : 0));
  return {
    title: 'Service Report',
    summary: [
      { label: 'Services performed', value: rows.reduce((s, r) => s + r.count, 0), type: 'int' },
      { label: 'Service revenue (before tax)', value: totalRev, type: 'money' },
      { label: 'Most popular', value: rows.slice().sort((a, b) => b.count - a.count)[0]?.service || '—', type: 'text' },
    ],
    columns: [
      { key: 'service', label: 'Service', type: 'text' },
      { key: 'category', label: 'Category', type: 'text' },
      { key: 'count', label: 'Times performed', type: 'int' },
      { key: 'revenue', label: 'Revenue', type: 'money' },
      { key: 'share', label: 'Share of revenue', type: 'pct' },
    ],
    rows,
    chart: { labelKey: 'service', valueKey: 'revenue', type: 'money' },
  };
}

function paymentReport(db, { from, to }) {
  const data = db.prepare(`SELECT method, COUNT(*) AS count, SUM(amount_cents) AS amount FROM payments
    WHERE status = 'completed' AND business_date BETWEEN ? AND ? GROUP BY method`).all(from, to);
  const total = data.reduce((s, r) => s + r.amount, 0);
  const rows = Object.keys(METHOD_LABELS).map((m) => {
    const r = data.find((d) => d.method === m) || { count: 0, amount: 0 };
    return { method: METHOD_LABELS[m], count: r.count, amount: r.amount, share: total ? r.amount / total : 0 };
  });
  return {
    title: 'Payment Report',
    summary: [
      { label: 'Payments received', value: total, type: 'money' },
      { label: 'Number of payments', value: data.reduce((s, r) => s + r.count, 0), type: 'int' },
    ],
    columns: [
      { key: 'method', label: 'Method', type: 'text' },
      { key: 'count', label: 'Payments', type: 'int' },
      { key: 'amount', label: 'Amount', type: 'money' },
      { key: 'share', label: 'Share', type: 'pct' },
    ],
    rows,
    chart: { labelKey: 'method', valueKey: 'amount', type: 'money' },
  };
}

function staffReport(db, { from, to }) {
  const rows = db.prepare(`SELECT COALESCE(u.display_name, 'Unassigned') AS staff,
      COUNT(DISTINCT v.id) AS visits, SUM(vs.quantity) AS services,
      SUM(ii.line_subtotal_cents - ii.discount_cents) AS revenue
    FROM visit_services vs JOIN visits v ON v.id = vs.visit_id JOIN invoice_items ii ON ii.visit_service_id = vs.id
    LEFT JOIN users u ON u.id = vs.staff_user_id
    WHERE v.status = 'completed' AND v.business_date BETWEEN ? AND ? GROUP BY vs.staff_user_id ORDER BY revenue DESC`).all(from, to);
  return {
    title: 'Staff Report',
    summary: [{ label: 'Staff members with sales', value: rows.length, type: 'int' }],
    columns: [
      { key: 'staff', label: 'Staff member', type: 'text' },
      { key: 'visits', label: 'Visits', type: 'int' },
      { key: 'services', label: 'Services performed', type: 'int' },
      { key: 'revenue', label: 'Service revenue', type: 'money' },
    ],
    rows,
    chart: { labelKey: 'staff', valueKey: 'revenue', type: 'money' },
  };
}

function spendingReport(db, { from, to }) {
  const rows = db.prepare(`SELECT c.customer_code AS customerCode, c.full_name AS customer, c.phone, COUNT(*) AS visits,
      SUM(i.total_cents) AS spent, CAST(ROUND(AVG(i.total_cents)) AS INTEGER) AS average, MAX(i.business_date) AS lastVisit
    FROM invoices i JOIN customers c ON c.id = i.customer_id
    WHERE ${VALID} AND i.business_date BETWEEN ? AND ? GROUP BY c.id ORDER BY spent DESC LIMIT 100`).all(from, to);
  const ltv = db.prepare(`SELECT COUNT(*) AS customers, COALESCE(AVG(t), 0) AS avgLifetime FROM
    (SELECT SUM(total_cents) t FROM invoices WHERE status != 'void' GROUP BY customer_id)`).get();
  const period = db.prepare(`SELECT COUNT(DISTINCT customer_id) AS customers, COALESCE(SUM(total_cents), 0) AS total
    FROM invoices i WHERE ${VALID} AND business_date BETWEEN ? AND ?`).get(from, to);
  return {
    title: 'Customer Spending',
    summary: [
      { label: 'Average spend per customer (period)', value: period.customers ? Math.round(period.total / period.customers) : 0, type: 'money' },
      { label: 'Customer lifetime value (all time average)', value: Math.round(ltv.avgLifetime), type: 'money' },
      { label: 'Paying customers (all time)', value: ltv.customers, type: 'int' },
    ],
    columns: [
      { key: 'customerCode', label: 'Customer ID', type: 'text' },
      { key: 'customer', label: 'Customer', type: 'text' },
      { key: 'phone', label: 'Phone', type: 'text' },
      { key: 'visits', label: 'Visits', type: 'int' },
      { key: 'spent', label: 'Total spent', type: 'money' },
      { key: 'average', label: 'Average', type: 'money' },
      { key: 'lastVisit', label: 'Last visit', type: 'text' },
    ],
    rows,
    chart: { labelKey: 'customer', valueKey: 'spent', type: 'money', limit: 10 },
  };
}

const REPORTS = {
  sales: salesReport,
  customers: customerReport,
  services: serviceReport,
  payments: paymentReport,
  staff: staffReport,
  spending: spendingReport,
};

module.exports = { REPORTS };

'use strict';

const { can } = require('../lib/auth');
const { businessDate, startOfWeek, addDays } = require('../lib/time');

module.exports = function dashboardRoutes(api, ctx) {
  api.get('/dashboard', (req, res) => {
    const db = ctx.db();
    const today = businessDate(new Date(), ctx.settings.timezone());
    const sales = (from, to) =>
      db.prepare("SELECT COALESCE(SUM(total_cents), 0) total, COUNT(*) n FROM invoices WHERE status != 'void' AND business_date BETWEEN ? AND ?").get(from, to);
    const visitStats = (from, to) =>
      db.prepare(`SELECT COUNT(*) AS visits, COUNT(DISTINCT customer_id) AS customers,
          COUNT(DISTINCT CASE WHEN is_first_visit = 1 THEN customer_id END) AS newCustomers
        FROM visits WHERE status = 'completed' AND business_date BETWEEN ? AND ?`).get(from, to);

    const t = visitStats(today, today);
    const todayVisits = db.prepare(`SELECT v.id, v.visit_at AS visitAt, c.id AS customerId, c.full_name AS customerName, i.id AS invoiceId,
        i.invoice_number AS invoiceNumber, i.total_cents AS totalCents, i.status,
        (SELECT GROUP_CONCAT(service_name, ', ') FROM visit_services WHERE visit_id = v.id) AS services
      FROM visits v JOIN customers c ON c.id = v.customer_id JOIN invoices i ON i.visit_id = v.id
      WHERE v.business_date = ? ORDER BY v.visit_at DESC LIMIT 50`).all(today);

    const out = {
      today,
      todayStats: { visits: t.visits, customers: t.customers, newCustomers: t.newCustomers, returningCustomers: t.customers - t.newCustomers },
      todayVisits,
      financials: false,
    };

    if (can(req.user, 'reports.view')) {
      const monthStart = today.slice(0, 8) + '01';
      const yearStart = today.slice(0, 5) + '01-01';
      const m = visitStats(monthStart, today);
      const outstanding = db.prepare("SELECT COALESCE(SUM(balance_cents), 0) total, COUNT(*) n FROM invoices WHERE status IN ('unpaid','partial')").get();
      const daily = db.prepare(`SELECT business_date AS date, SUM(total_cents) AS total FROM invoices
        WHERE status != 'void' AND business_date BETWEEN ? AND ? GROUP BY business_date`).all(addDays(today, -29), today);
      const series = [];
      for (let i = 29; i >= 0; i--) {
        const d = addDays(today, -i);
        series.push({ date: d, total: daily.find((x) => x.date === d)?.total || 0 });
      }
      Object.assign(out, {
        financials: true,
        todayStats: { ...out.todayStats, salesCents: sales(today, today).total },
        outstanding: { cents: outstanding.total, invoices: outstanding.n },
        weekSalesCents: sales(startOfWeek(today), today).total,
        monthSalesCents: sales(monthStart, today).total,
        yearSalesCents: sales(yearStart, today).total,
        month: { visits: m.visits, newCustomers: m.newCustomers, returningCustomers: m.customers - m.newCustomers },
        dailySales: series,
        topServices: db.prepare(`SELECT ii.description AS name, SUM(ii.quantity) AS count, SUM(ii.line_subtotal_cents - ii.discount_cents) AS revenueCents
          FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id WHERE i.status != 'void' AND i.business_date >= ?
          GROUP BY ii.description ORDER BY count DESC, revenueCents DESC LIMIT 5`).all(addDays(today, -89)),
        topCustomers: db.prepare(`SELECT c.id, c.full_name AS name, COUNT(*) AS visits, SUM(i.total_cents) AS spentCents
          FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.status != 'void' GROUP BY c.id ORDER BY spentCents DESC LIMIT 5`).all(),
        totalCustomers: db.prepare('SELECT COUNT(*) c FROM customers').get().c,
      });
    }
    res.json(out);
  });
};

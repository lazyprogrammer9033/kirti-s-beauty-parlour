'use strict';

const { requirePerm, HttpError, toCsv } = require('../lib/http');
const { REPORTS } = require('../lib/reports');
const { reportPdf, formatValue } = require('../lib/pdf');
const { businessDate, isValidYmd, addDays } = require('../lib/time');
const { audit } = require('../lib/audit');

function runReport(ctx, type, query) {
  const fn = REPORTS[type];
  if (!fn) throw new HttpError(404, 'Unknown report');
  const today = businessDate(new Date(), ctx.settings.timezone());
  const from = isValidYmd(query.from) ? query.from : addDays(today, -29);
  const to = isValidYmd(query.to) ? query.to : today;
  if (from > to) throw new HttpError(400, 'The start date must be before the end date');
  const report = fn(ctx.db(), { from, to, group: query.group });
  report.from = from;
  report.to = to;
  report.subtitle = `${from} to ${to}`;
  return report;
}

module.exports = function reportRoutes(api, ctx) {
  const view = requirePerm('reports.view');

  api.get('/reports/:type', view, async (req, res) => {
    const report = runReport(ctx, req.params.type, req.query);
    const base = `${req.params.type}-report_${report.from}_to_${report.to}`;
    if (req.query.format === 'csv') {
      const cols = report.columns.map((c) => ({ ...c, format: (v) => (c.type === 'money' ? (v == null ? '' : (v / 100).toFixed(2)) : c.type === 'pct' ? formatValue(v, 'pct') : v) }));
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${base}.csv"`);
      return res.send(toCsv(cols, report.rows));
    }
    if (req.query.format === 'pdf') {
      const pdf = await reportPdf(report, ctx.settings.all());
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${base}.pdf"`);
      return res.send(pdf);
    }
    res.json(report);
  });

  api.post('/reports/:type/drive', view, async (req, res) => {
    const report = runReport(ctx, req.params.type, req.body || {});
    const pdf = await reportPdf(report, ctx.settings.all());
    const file = await ctx.drive.upload('reports', `${report.title} ${report.from} to ${report.to}.pdf`, 'application/pdf', pdf);
    audit(ctx.db(), req, 'report.saved_to_drive', 'report', req.params.type, { from: report.from, to: report.to });
    res.json({ ok: true, fileId: file.id });
  });
};

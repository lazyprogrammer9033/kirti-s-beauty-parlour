'use strict';

const { defaultLogo } = require('./brand');

const PDFDocument = require('pdfkit');
const { formatCad } = require('./money');

const PLUM = '#4a2c40';
const ROSE = '#b76e79';
const MUTED = '#7a6a72';
const LINE = '#eadde2';

const METHOD_LABELS = { cash: 'Cash', debit: 'Debit', credit: 'Credit Card', etransfer: 'E-transfer', other: 'Other' };

function toBuffer(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

function logoBuffer(dataUrl) {
  const m = /^data:image\/(png|jpe?g);base64,(.+)$/.exec(dataUrl || '');
  return m ? Buffer.from(m[2], 'base64') : null;
}

function fmtDate(iso, tz) {
  return new Date(iso).toLocaleString('en-CA', { timeZone: tz, dateStyle: 'long', timeStyle: 'short' });
}

function receiptPdf(inv, biz) {
  const doc = new PDFDocument({ size: 'LETTER', margin: 54, info: { Title: `Receipt ${inv.invoiceNumber}`, Author: biz.business_name } });
  const left = 54;
  const right = doc.page.width - 54;
  const width = right - left;

  const logo = logoBuffer(biz.business_logo) || logoBuffer(defaultLogo());
  let y = 54;
  if (logo) {
    try {
      doc.image(logo, left, y, { fit: [70, 70] });
    } catch {
      /* unsupported image: skip */
    }
  }
  const tx = logo ? left + 84 : left;
  doc.fillColor(PLUM).font('Helvetica-Bold').fontSize(20).text(biz.business_name || 'Beauty Parlour', tx, y, { width: right - tx - 160 });
  doc.font('Helvetica').fontSize(9.5).fillColor(MUTED);
  const contact = [biz.business_address, biz.business_phone, biz.business_email, biz.business_website].filter(Boolean).join('\n');
  if (contact) doc.text(contact, tx, doc.y + 4, { width: right - tx - 160 });
  if (biz.receipt_show_tax_number === '1' && biz.tax_number) doc.text(`${inv.taxName} #: ${biz.tax_number}`);

  doc.font('Helvetica-Bold').fontSize(11).fillColor(ROSE).text(inv.status === 'void' ? 'VOID RECEIPT' : 'RECEIPT', right - 160, y, { width: 160, align: 'right' });
  doc.font('Helvetica').fontSize(9.5).fillColor(PLUM)
    .text(inv.invoiceNumber, right - 160, y + 18, { width: 160, align: 'right' })
    .fillColor(MUTED)
    .text(fmtDate(inv.issuedAt, biz.timezone), right - 200, y + 32, { width: 200, align: 'right' });

  y = Math.max(doc.y, logo ? y + 80 : y) + 20;
  doc.moveTo(left, y).lineTo(right, y).strokeColor(LINE).lineWidth(1).stroke();
  y += 14;
  doc.fontSize(9).fillColor(MUTED).text('BILLED TO', left, y);
  doc.fontSize(11).fillColor(PLUM).font('Helvetica-Bold').text(inv.customer.fullName, left, y + 12);
  doc.font('Helvetica').fontSize(9.5).fillColor(MUTED).text(`${inv.customer.customerCode}  ·  ${inv.customer.phone}`, left, y + 27);
  if (inv.staffName) doc.text(`Served by ${inv.staffName}`, right - 200, y + 12, { width: 200, align: 'right' });

  y += 56;
  const cols = [
    { label: 'Service', x: left, w: width * 0.52, align: 'left' },
    { label: 'Qty', x: left + width * 0.52, w: width * 0.1, align: 'right' },
    { label: 'Price', x: left + width * 0.62, w: width * 0.18, align: 'right' },
    { label: 'Amount', x: left + width * 0.8, w: width * 0.2, align: 'right' },
  ];
  doc.rect(left, y, width, 22).fill('#f8f1f3');
  doc.fillColor(PLUM).font('Helvetica-Bold').fontSize(9);
  cols.forEach((c) => doc.text(c.label, c.x + (c.align === 'left' ? 8 : 0), y + 7, { width: c.w - 8, align: c.align }));
  y += 28;
  doc.font('Helvetica').fontSize(10);
  for (const it of inv.items) {
    const vals = [it.description + (it.taxable ? '' : ' *'), String(it.quantity), formatCad(it.unitPriceCents), formatCad(it.lineSubtotalCents)];
    doc.fillColor(PLUM);
    cols.forEach((c, i) => doc.text(vals[i], c.x + (c.align === 'left' ? 8 : 0), y, { width: c.w - 8, align: c.align }));
    y += 20;
    if (y > doc.page.height - 200) {
      doc.addPage();
      y = 54;
    }
  }
  doc.moveTo(left, y).lineTo(right, y).strokeColor(LINE).stroke();
  y += 10;

  const totals = [['Subtotal', formatCad(inv.subtotalCents)]];
  if (inv.discountCents) totals.push([`Discount${inv.discountType === 'percent' ? ` (${inv.discountValue / 100}%)` : ''}`, '-' + formatCad(inv.discountCents)]);
  totals.push([`${inv.taxName} (${inv.taxRateBp / 100}%)${inv.pricesIncludeTax ? ' included' : ''}`, formatCad(inv.taxCents)]);
  const tx2 = left + width * 0.5;
  const tw = width * 0.5;
  doc.fontSize(10);
  for (const [k, v] of totals) {
    doc.fillColor(MUTED).text(k, tx2, y, { width: tw * 0.6 });
    doc.fillColor(PLUM).text(v, tx2 + tw * 0.6, y, { width: tw * 0.4 - 8, align: 'right' });
    y += 18;
  }
  doc.rect(tx2, y, tw, 28).fill('#f8f1f3');
  doc.font('Helvetica-Bold').fontSize(12).fillColor(PLUM).text('Total (CAD)', tx2 + 8, y + 8, { width: tw * 0.6 });
  doc.text(formatCad(inv.totalCents), tx2 + tw * 0.6, y + 8, { width: tw * 0.4 - 8, align: 'right' });
  y += 40;
  doc.font('Helvetica').fontSize(10);
  for (const p of inv.payments.filter((x) => x.status === 'completed')) {
    doc.fillColor(MUTED).text(`Paid · ${METHOD_LABELS[p.method] || p.method}`, tx2, y, { width: tw * 0.6 });
    doc.fillColor(PLUM).text(formatCad(p.amountCents), tx2 + tw * 0.6, y, { width: tw * 0.4 - 8, align: 'right' });
    y += 18;
  }
  if (inv.balanceCents > 0) {
    doc.font('Helvetica-Bold').fillColor(ROSE).text('Balance owing', tx2, y, { width: tw * 0.6 });
    doc.text(formatCad(inv.balanceCents), tx2 + tw * 0.6, y, { width: tw * 0.4 - 8, align: 'right' });
    y += 18;
  }
  if (inv.items.some((i) => !i.taxable)) {
    doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text('* not taxable', left, y);
  }
  if (inv.status === 'void') {
    y += 16;
    doc.font('Helvetica-Bold').fontSize(10).fillColor(ROSE).text(`This receipt was voided${inv.voidReason ? ': ' + inv.voidReason : ''}.`, left, y, { width });
  }
  if (biz.receipt_footer) {
    doc.font('Helvetica-Oblique').fontSize(11).fillColor(ROSE).text(biz.receipt_footer, left, Math.max(y + 40, doc.y + 30), { width, align: 'center' });
  }
  return toBuffer(doc);
}

// Renders a report ({ title, subtitle, summary, columns, rows }) as a table.
function reportPdf(report, biz) {
  const doc = new PDFDocument({ size: 'LETTER', layout: report.columns.length > 5 ? 'landscape' : 'portrait', margin: 40, info: { Title: report.title } });
  const left = 40;
  const right = doc.page.width - 40;
  const width = right - left;
  doc.fillColor(PLUM).font('Helvetica-Bold').fontSize(16).text(biz.business_name || 'Beauty Parlour', left, 40);
  doc.fontSize(13).fillColor(ROSE).text(report.title);
  doc.font('Helvetica').fontSize(9.5).fillColor(MUTED).text(report.subtitle || '');
  doc.text(`Generated ${new Date().toLocaleString('en-CA', { timeZone: biz.timezone })}`);
  doc.moveDown(0.8);

  if (report.summary && report.summary.length) {
    doc.fontSize(10);
    for (const s of report.summary) {
      doc.fillColor(MUTED).text(s.label + ': ', { continued: true }).fillColor(PLUM).font('Helvetica-Bold').text(formatValue(s.value, s.type)).font('Helvetica');
    }
    doc.moveDown(0.8);
  }

  const n = report.columns.length;
  const colW = width / n;
  const drawHeader = () => {
    const y = doc.y;
    doc.rect(left, y, width, 20).fill('#f8f1f3');
    doc.fillColor(PLUM).font('Helvetica-Bold').fontSize(8.5);
    report.columns.forEach((c, i) => doc.text(c.label, left + i * colW + 4, y + 6, { width: colW - 8, align: isNumeric(c.type) ? 'right' : 'left' }));
    doc.font('Helvetica').fontSize(8.5);
    doc.y = y + 24;
  };
  drawHeader();
  for (const r of report.rows) {
    if (doc.y > doc.page.height - 60) {
      doc.addPage();
      doc.y = 40;
      drawHeader();
    }
    const y = doc.y;
    report.columns.forEach((c, i) => {
      doc.fillColor(PLUM).text(formatValue(r[c.key], c.type), left + i * colW + 4, y, { width: colW - 8, align: isNumeric(c.type) ? 'right' : 'left', lineBreak: false, ellipsis: true });
    });
    doc.y = y + 15;
    doc.moveTo(left, doc.y - 2).lineTo(right, doc.y - 2).strokeColor(LINE).lineWidth(0.5).stroke();
  }
  if (!report.rows.length) doc.fillColor(MUTED).text('No data for this period.', left, doc.y + 6);
  return toBuffer(doc);
}

const isNumeric = (t) => ['money', 'int', 'pct'].includes(t);

function formatValue(v, type) {
  if (v == null || v === '') return '';
  if (type === 'money') return formatCad(Number(v));
  if (type === 'pct') return (Number(v) * 100).toFixed(1) + '%';
  if (type === 'int') return Number(v).toLocaleString('en-CA');
  return String(v);
}

module.exports = { receiptPdf, reportPdf, formatValue, METHOD_LABELS };

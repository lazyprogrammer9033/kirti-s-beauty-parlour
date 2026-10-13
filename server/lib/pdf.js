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
  const headW = right - tx - 160;
  const name = biz.business_name || 'Beauty Parlour';
  const contact = [biz.business_address, biz.business_phone, biz.business_email, biz.business_website].filter(Boolean).join('\n');
  // Centre the name (and contact lines) against the 70pt logo.
  const nameH = doc.font('Helvetica-Bold').fontSize(20).heightOfString(name, { width: headW });
  const contactH = contact ? doc.font('Helvetica').fontSize(9.5).heightOfString(contact, { width: headW }) + 4 : 0;
  const ty = logo ? y + Math.max(0, (70 - nameH - contactH) / 2) : y;
  doc.fillColor(PLUM).font('Helvetica-Bold').fontSize(20).text(name, tx, ty, { width: headW });
  doc.font('Helvetica').fontSize(9.5).fillColor(MUTED);
  if (contact) doc.text(contact, tx, doc.y + 4, { width: headW });
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

// Renders a report ({ title, heading?, subject?, subtitle, summary, columns, rows, totals? })
// in the same style as the invoice: plum header with the logo, summary tiles,
// a striped table and a footer with page numbers.
function reportPdf(report, biz) {
  const landscape = report.columns.length > 5;
  const doc = new PDFDocument({ size: 'LETTER', layout: landscape ? 'landscape' : 'portrait', margin: 0, bufferPages: true, info: { Title: report.title, Author: biz.business_name } });
  const W = doc.page.width;
  const H = doc.page.height;
  const left = 44;
  const right = W - 44;
  const width = right - left;
  const name = biz.business_name || 'Beauty Parlour';
  const pad = 8;

  // Header band: logo, salon name and contact; report heading on the right.
  const bandH = 104;
  doc.rect(0, 0, W, bandH).fill(PLUM);
  const logo = logoBuffer(biz.business_logo) || logoBuffer(defaultLogo());
  const logoSize = 56;
  const ly = (bandH - logoSize) / 2;
  let hasLogo = false;
  if (logo) {
    try {
      doc.roundedRect(left, ly, logoSize, logoSize, 12).fill('#ffffff');
      doc.image(logo, left + 4, ly + 4, { fit: [logoSize - 8, logoSize - 8] });
      hasLogo = true;
    } catch {
      /* unsupported image: skip */
    }
  }
  const tx = hasLogo ? left + logoSize + 14 : left;
  const headRightW = Math.min(300, width * 0.42);
  const headW = right - tx - headRightW - 12;
  const contact = [[biz.business_phone, biz.business_email].filter(Boolean).join('  ·  '), biz.business_website].filter(Boolean).join('\n');
  const nameH = doc.font('Helvetica-Bold').fontSize(19).heightOfString(name, { width: headW });
  const contactH = contact ? doc.font('Helvetica').fontSize(8.5).heightOfString(contact, { width: headW }) + 4 : 0;
  const ty = (bandH - nameH - contactH) / 2;
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(19).text(name, tx, ty, { width: headW });
  if (contact) doc.font('Helvetica').fontSize(8.5).fillColor('#f1d3dc').text(contact, tx, doc.y + 4, { width: headW, lineGap: 1 });

  const heading = (report.heading || report.title).toUpperCase();
  const hx = right - headRightW;
  const headingH = doc.font('Helvetica-Bold').fontSize(18).heightOfString(heading, { width: headRightW, characterSpacing: 1.5 });
  const subLines = [report.subject, report.subtitle].filter(Boolean);
  const subH = subLines.length ? doc.font('Helvetica').fontSize(10).heightOfString(subLines.join('\n'), { width: headRightW }) + 4 : 0;
  const hy = (bandH - headingH - subH) / 2;
  doc.font('Helvetica-Bold').fontSize(18).fillColor('#ffffff').text(heading, hx, hy, { width: headRightW, align: 'right', characterSpacing: 1.5 });
  if (subLines.length) {
    let sy = doc.y + 4;
    if (report.subject) {
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#ffffff').text(report.subject, hx, sy, { width: headRightW, align: 'right' });
      sy = doc.y + 1;
    }
    if (report.subtitle) doc.font('Helvetica').fontSize(9.5).fillColor('#f1d3dc').text(report.subtitle, hx, sy, { width: headRightW, align: 'right' });
  }

  let y = bandH + 22;

  // Summary tiles, up to four per row.
  const summary = report.summary || [];
  if (summary.length) {
    const perRow = Math.min(4, summary.length);
    const gap = 12;
    const tileW = (width - gap * (perRow - 1)) / perRow;
    const tileH = 52;
    summary.forEach((s, i) => {
      const col = i % perRow;
      const row = Math.floor(i / perRow);
      const x = left + col * (tileW + gap);
      const ty2 = y + row * (tileH + gap);
      doc.roundedRect(x, ty2, tileW, tileH, 8).fill('#fbf6f8');
      doc.roundedRect(x, ty2, 3, tileH, 1.5).fill(ROSE);
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(ROSE).text(s.label.toUpperCase(), x + 14, ty2 + 11, { width: tileW - 24, characterSpacing: 0.8, lineBreak: false, ellipsis: true });
      doc.font('Helvetica-Bold').fontSize(15).fillColor(PLUM).text(formatValue(s.value, s.type) || '—', x + 14, ty2 + 26, { width: tileW - 24, lineBreak: false, ellipsis: true });
    });
    y += Math.ceil(summary.length / perRow) * (tileH + gap) + 10;
  }

  // Table: text columns get more room than numbers.
  const weight = (c) => (c.type === 'text' ? 2 : c.type === 'int' ? 0.8 : 1.2);
  const total = report.columns.reduce((sum, c) => sum + weight(c), 0);
  let cx = left;
  const cols = report.columns.map((c) => {
    const w = (width * weight(c)) / total;
    const col = { ...c, x: cx, w, align: isNumeric(c.type) ? 'right' : 'left' };
    cx += w;
    return col;
  });
  const footerTop = H - 40;
  const drawHeader = () => {
    doc.rect(left, y, width, 24).fill(PLUM);
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8);
    cols.forEach((c) => doc.text(c.label.toUpperCase(), c.x + pad, y + 8.5, { width: c.w - pad * 2, align: c.align, characterSpacing: 0.6, lineBreak: false, ellipsis: true }));
    y += 24;
  };
  drawHeader();
  const rowH = 22;
  report.rows.forEach((r, i) => {
    if (y + rowH > footerTop - 10) {
      doc.addPage({ size: 'LETTER', layout: landscape ? 'landscape' : 'portrait', margin: 0 });
      y = 44;
      drawHeader();
    }
    if (i % 2 === 1) doc.rect(left, y, width, rowH).fill('#fbf6f8');
    doc.fillColor(PLUM).font('Helvetica').fontSize(9);
    cols.forEach((c) => doc.text(formatValue(r[c.key], c.type), c.x + pad, y + 7, { width: c.w - pad * 2, align: c.align, lineBreak: false, ellipsis: true }));
    y += rowH;
  });
  if (!report.rows.length) {
    doc.font('Helvetica').fontSize(10).fillColor(MUTED).text('No data for this period.', left + pad, y + 12);
    y += 34;
  } else if (report.totals) {
    if (y + 26 > footerTop - 10) {
      doc.addPage({ size: 'LETTER', layout: landscape ? 'landscape' : 'portrait', margin: 0 });
      y = 44;
    }
    doc.moveTo(left, y).lineTo(right, y).strokeColor(PLUM).lineWidth(1).stroke();
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(PLUM);
    cols.forEach((c, i) => {
      const v = i === 0 ? 'Total' : report.totals[c.key] != null ? formatValue(report.totals[c.key], c.type) : '';
      doc.text(v, c.x + pad, y + 8, { width: c.w - pad * 2, align: c.align, lineBreak: false });
    });
    y += 26;
  } else {
    doc.moveTo(left, y).lineTo(right, y).strokeColor(LINE).lineWidth(1).stroke();
  }

  // Footer on every page.
  const generated = `Generated ${new Date().toLocaleString('en-CA', { timeZone: biz.timezone, dateStyle: 'long', timeStyle: 'short' })}`;
  const range = doc.bufferedPageRange();
  for (let p = range.start; p < range.start + range.count; p++) {
    doc.switchToPage(p);
    doc.moveTo(left, footerTop).lineTo(right, footerTop).strokeColor(LINE).lineWidth(0.75).stroke();
    doc.font('Helvetica').fontSize(8).fillColor(MUTED);
    doc.text(`${name}  ·  ${generated}`, left, footerTop + 10, { width: width * 0.7, lineBreak: false });
    doc.text(`Page ${p - range.start + 1} of ${range.count}`, left + width * 0.7, footerTop + 10, { width: width * 0.3, align: 'right', lineBreak: false });
  }
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

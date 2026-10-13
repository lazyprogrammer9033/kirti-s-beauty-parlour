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
  const isVoid = inv.status === 'void';
  const doc = new PDFDocument({ size: 'LETTER', margin: 0, info: { Title: `Invoice ${inv.invoiceNumber}`, Author: biz.business_name } });
  const W = doc.page.width;
  const H = doc.page.height;
  const left = 54;
  const right = W - 54;
  const width = right - left;
  const name = biz.business_name || 'Beauty Parlour';
  const tz = biz.timezone;
  const paid = inv.payments.filter((x) => x.status === 'completed');

  // Header band: logo, salon name and contact on plum; document title on the right.
  const bandH = 128;
  doc.rect(0, 0, W, bandH).fill(PLUM);
  const logo = logoBuffer(biz.business_logo) || logoBuffer(defaultLogo());
  const logoSize = 64;
  const ly = (bandH - logoSize) / 2;
  if (logo) {
    try {
      doc.roundedRect(left, ly, logoSize, logoSize, 14).fill('#ffffff');
      doc.image(logo, left + 4, ly + 4, { fit: [logoSize - 8, logoSize - 8] });
    } catch {
      /* unsupported image: skip */
    }
  }
  const tx = logo ? left + logoSize + 16 : left;
  const headW = right - tx - 170;
  const contact = [biz.business_address, [biz.business_phone, biz.business_email].filter(Boolean).join('  ·  '), biz.business_website].filter(Boolean).join('\n');
  const nameH = doc.font('Helvetica-Bold').fontSize(22).heightOfString(name, { width: headW });
  const contactH = contact ? doc.font('Helvetica').fontSize(9).heightOfString(contact, { width: headW }) + 5 : 0;
  const ty = (bandH - nameH - contactH) / 2;
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(22).text(name, tx, ty, { width: headW });
  if (contact) doc.font('Helvetica').fontSize(9).fillColor('#f1d3dc').text(contact, tx, doc.y + 5, { width: headW, lineGap: 1 });

  doc.font('Helvetica-Bold').fontSize(24).fillColor('#ffffff').text(isVoid ? 'VOID' : 'INVOICE', right - 170, bandH / 2 - 26, { width: 170, align: 'right', characterSpacing: 2 });
  doc.font('Helvetica').fontSize(10).fillColor('#f1d3dc').text(inv.invoiceNumber, right - 170, bandH / 2 + 4, { width: 170, align: 'right' });

  // Bill to / invoice details.
  let y = bandH + 30;
  const colW = width / 2 - 10;
  const label = (t, x, yy) => doc.font('Helvetica-Bold').fontSize(8).fillColor(ROSE).text(t, x, yy, { characterSpacing: 1.2 });
  label('BILL TO', left, y);
  doc.font('Helvetica-Bold').fontSize(13).fillColor(PLUM).text(inv.customer.fullName, left, y + 14, { width: colW });
  doc.font('Helvetica').fontSize(9.5).fillColor(MUTED).text([inv.customer.phone, inv.customer.email, `Customer ID ${inv.customer.customerCode}`].filter(Boolean).join('\n'), left, doc.y + 3, { width: colW, lineGap: 1.5 });
  const billBottom = doc.y;

  const dx = left + width / 2 + 10;
  label('INVOICE DETAILS', dx, y);
  const details = [
    ['Invoice no.', inv.invoiceNumber],
    ['Date', fmtDate(inv.issuedAt, tz)],
    inv.staffName ? ['Served by', inv.staffName] : null,
    biz.receipt_show_tax_number === '1' && biz.tax_number ? [`${inv.taxName} no.`, biz.tax_number] : null,
  ].filter(Boolean);
  let dy = y + 15;
  for (const [k, v] of details) {
    doc.font('Helvetica').fontSize(9.5).fillColor(MUTED).text(k, dx, dy, { width: 80 });
    doc.fillColor(PLUM).text(v, dx + 80, dy, { width: colW - 80, align: 'right' });
    dy += 15;
  }
  // Status pill.
  const status = isVoid ? ['VOID', ROSE, '#fbe6e8'] : inv.balanceCents > 0 ? ['BALANCE DUE', '#b9434f', '#fbe6e8'] : ['PAID', '#3f8a68', '#e5f3ec'];
  const pillW = doc.font('Helvetica-Bold').fontSize(9).widthOfString(status[0]) + 22;
  doc.roundedRect(dx + colW - pillW, dy + 2, pillW, 18, 9).fill(status[2]);
  doc.fillColor(status[1]).text(status[0], dx + colW - pillW, dy + 7, { width: pillW, align: 'center', characterSpacing: 1 });
  y = Math.max(billBottom, dy + 22) + 24;

  // Items.
  const cols = [
    { label: 'SERVICE', x: left, w: width * 0.5, align: 'left' },
    { label: 'QTY', x: left + width * 0.5, w: width * 0.12, align: 'right' },
    { label: 'UNIT PRICE', x: left + width * 0.62, w: width * 0.19, align: 'right' },
    { label: 'AMOUNT', x: left + width * 0.81, w: width * 0.19, align: 'right' },
  ];
  const pad = 10;
  doc.rect(left, y, width, 26).fill(PLUM);
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8.5);
  cols.forEach((c) => doc.text(c.label, c.x + pad, y + 9, { width: c.w - pad * 2, align: c.align, characterSpacing: 0.8 }));
  y += 26;
  inv.items.forEach((it, i) => {
    const vals = [it.description + (it.taxable ? '' : ' *'), String(it.quantity), formatCad(it.unitPriceCents), formatCad(it.lineSubtotalCents)];
    const rowH = Math.max(26, doc.font('Helvetica').fontSize(10).heightOfString(vals[0], { width: cols[0].w - pad * 2 }) + 14);
    if (y + rowH > H - 220) {
      doc.addPage({ margin: 0 });
      y = 54;
    }
    if (i % 2 === 1) doc.rect(left, y, width, rowH).fill('#fbf6f8');
    doc.fillColor(PLUM).font('Helvetica').fontSize(10);
    cols.forEach((c, j) => doc.text(vals[j], c.x + pad, y + 8, { width: c.w - pad * 2, align: c.align }));
    y += rowH;
  });
  doc.moveTo(left, y).lineTo(right, y).strokeColor(LINE).lineWidth(1).stroke();
  y += 14;

  // Totals (right) and payments (left).
  const tx2 = left + width * 0.55;
  const tw = width * 0.45;
  const totalRow = (k, v, opts = {}) => {
    doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(opts.size || 10).fillColor(opts.color || MUTED).text(k, tx2 + pad, y, { width: tw * 0.6 });
    doc.fillColor(opts.valueColor || PLUM).text(v, tx2 + tw * 0.6, y, { width: tw * 0.4 - pad, align: 'right' });
    y += opts.gap || 18;
  };
  const totalsTop = y;
  totalRow('Subtotal', formatCad(inv.subtotalCents));
  if (inv.discountCents) totalRow(`Discount${inv.discountType === 'percent' ? ` (${inv.discountValue / 100}%)` : ''}`, '-' + formatCad(inv.discountCents));
  totalRow(`${inv.taxName} (${inv.taxRateBp / 100}%)${inv.pricesIncludeTax ? ' included' : ''}`, formatCad(inv.taxCents));
  y += 4;
  doc.roundedRect(tx2, y, tw, 34, 6).fill(PLUM);
  doc.font('Helvetica-Bold').fontSize(12.5).fillColor('#ffffff').text('Total (CAD)', tx2 + pad, y + 11, { width: tw * 0.6 });
  doc.text(formatCad(inv.totalCents), tx2 + tw * 0.6, y + 11, { width: tw * 0.4 - pad, align: 'right' });
  y += 44;
  if (inv.balanceCents > 0) totalRow('Balance owing', formatCad(inv.balanceCents), { bold: true, color: '#b9434f', valueColor: '#b9434f' });

  let py = totalsTop;
  doc.font('Helvetica-Bold').fontSize(8).fillColor(ROSE).text('PAYMENT', left, py, { characterSpacing: 1.2 });
  py += 14;
  if (!paid.length) doc.font('Helvetica').fontSize(9.5).fillColor(MUTED).text('No payment recorded yet.', left, py);
  for (const p of paid) {
    doc.font('Helvetica').fontSize(9.5).fillColor(PLUM).text(`${METHOD_LABELS[p.method] || p.method}`, left, py, { width: 110 });
    doc.fillColor(MUTED).text(formatCad(p.amountCents), left + 110, py, { width: 80 });
    py += 15;
  }
  if (inv.items.some((i) => !i.taxable)) doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text('* not taxable', left, py + 6);
  y = Math.max(y, py + 20);

  if (isVoid) {
    y += 6;
    doc.font('Helvetica-Bold').fontSize(10).fillColor(ROSE).text(`This invoice was voided${inv.voidReason ? ': ' + inv.voidReason : ''}.`, left, y, { width });
    y = doc.y + 6;
  }

  // Thank-you and book-again footer, pinned near the bottom of the page.
  const fy = Math.max(y + 30, H - 150);
  if (biz.receipt_footer) {
    doc.font('Helvetica-Oblique').fontSize(12).fillColor(ROSE).text(biz.receipt_footer, left, fy, { width, align: 'center', lineGap: 2 });
  }
  if (biz.receipt_booking_link) {
    const link = /^https?:\/\//.test(biz.receipt_booking_link) ? biz.receipt_booking_link : 'https://' + biz.receipt_booking_link;
    const label2 = `Book your next visit: ${biz.receipt_booking_link.replace(/^https?:\/\//, '')}`;
    const lw = doc.font('Helvetica-Bold').fontSize(10).widthOfString(label2) + 32;
    const by = doc.y + 12;
    doc.roundedRect((W - lw) / 2, by, lw, 26, 13).fill('#f6e5ea');
    doc.fillColor(PLUM).text(label2, (W - lw) / 2, by + 8, { width: lw, align: 'center', link });
  }
  doc.rect(0, H - 28, W, 28).fill('#f8f1f3');
  doc.font('Helvetica').fontSize(8).fillColor(MUTED).text([name, biz.business_phone, biz.business_email].filter(Boolean).join('  ·  '), left, H - 18, { width, align: 'center', lineBreak: false });
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

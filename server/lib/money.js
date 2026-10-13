'use strict';

// All amounts are integer cents. Rates are basis points (1300 = 13%).

function toCents(value) {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  const s = String(value ?? '').trim().replace(/[$,\s]/g, '');
  if (!/^-?\d+(\.\d{0,2})?$/.test(s)) throw new Error('Invalid amount: ' + value);
  const neg = s.startsWith('-');
  const [whole, frac = ''] = s.replace('-', '').split('.');
  const cents = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
  return neg ? -cents : cents;
}

function formatCad(cents) {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toLocaleString('en-CA');
  return `${neg ? '-' : ''}$${dollars}.${String(abs % 100).padStart(2, '0')}`;
}

// Rounds a non-negative rational a/b to the nearest integer, halves up.
function roundDiv(a, b) {
  return Math.floor((2 * a + b) / (2 * b));
}

// Splits `amount` across `weights` proportionally so the parts sum exactly to amount.
function allocate(amount, weights) {
  const total = weights.reduce((s, w) => s + w, 0);
  if (total === 0 || amount === 0) return weights.map(() => 0);
  const raw = weights.map((w) => (amount * w) / total);
  const parts = raw.map(Math.floor);
  let remainder = amount - parts.reduce((s, p) => s + p, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; remainder > 0; k = (k + 1) % order.length, remainder--) parts[order[k][1]] += 1;
  return parts;
}

/**
 * Calculates an invoice.
 * items: [{ unitPriceCents, quantity, taxable }]
 * discount: { type: 'amount'|'percent', value } — value in cents, or basis points for percent
 * Tax is calculated once on the taxable total (after discount) and then spread across lines,
 * so the printed tax always equals rate x taxable amount.
 */
function calculateInvoice({ items, discount, taxRateBp, pricesIncludeTax }) {
  if (!Array.isArray(items) || items.length === 0) throw new Error('At least one item is required');
  if (!Number.isInteger(taxRateBp) || taxRateBp < 0 || taxRateBp > 5000) throw new Error('Invalid tax rate');
  const lines = items.map((it) => {
    const unit = it.unitPriceCents;
    const qty = it.quantity;
    if (!Number.isInteger(unit) || unit < 0) throw new Error('Invalid price');
    if (!Number.isInteger(qty) || qty < 1 || qty > 99) throw new Error('Invalid quantity');
    return { ...it, lineSubtotalCents: unit * qty, taxable: it.taxable ? 1 : 0 };
  });
  const subtotal = lines.reduce((s, l) => s + l.lineSubtotalCents, 0);

  let discountCents = 0;
  if (discount && discount.value) {
    if (discount.type === 'percent') {
      if (!Number.isInteger(discount.value) || discount.value < 0 || discount.value > 10000) throw new Error('Invalid discount percent');
      discountCents = roundDiv(subtotal * discount.value, 10000);
    } else if (discount.type === 'amount') {
      if (!Number.isInteger(discount.value) || discount.value < 0) throw new Error('Invalid discount amount');
      discountCents = discount.value;
    } else {
      throw new Error('Invalid discount type');
    }
    if (discountCents > subtotal) throw new Error('Discount cannot be more than the subtotal');
  }

  const discountParts = allocate(discountCents, lines.map((l) => l.lineSubtotalCents));
  lines.forEach((l, i) => {
    l.discountCents = discountParts[i];
    l.netCents = l.lineSubtotalCents - l.discountCents;
  });

  const taxableNet = lines.filter((l) => l.taxable).reduce((s, l) => s + l.netCents, 0);
  const taxCents = pricesIncludeTax
    ? taxableNet - roundDiv(taxableNet * 10000, 10000 + taxRateBp)
    : roundDiv(taxableNet * taxRateBp, 10000);
  const taxParts = allocate(taxCents, lines.map((l) => (l.taxable ? l.netCents : 0)));
  lines.forEach((l, i) => {
    l.taxCents = taxParts[i];
    l.lineTotalCents = pricesIncludeTax ? l.netCents : l.netCents + l.taxCents;
  });

  const totalCents = subtotal - discountCents + (pricesIncludeTax ? 0 : taxCents);
  return { lines, subtotalCents: subtotal, discountCents, taxableCents: taxableNet, taxCents, totalCents };
}

module.exports = { toCents, formatCad, calculateInvoice, allocate, roundDiv };

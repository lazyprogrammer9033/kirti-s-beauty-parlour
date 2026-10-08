'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { calculateInvoice, toCents, allocate, formatCad } = require('../server/lib/money');

test('toCents parses dollars exactly', () => {
  assert.equal(toCents('107.35'), 10735);
  assert.equal(toCents('$1,200.5'), 120050);
  assert.equal(toCents('0.1'), 10);
  assert.throws(() => toCents('12.345'));
  assert.throws(() => toCents('abc'));
});

test('allocate always sums exactly', () => {
  const parts = allocate(100, [1, 1, 1]);
  assert.equal(parts.reduce((a, b) => a + b, 0), 100);
  assert.deepEqual(parts, [34, 33, 33]);
});

test('worked example from the requirements', () => {
  const r = calculateInvoice({
    items: [{ unitPriceCents: 4500, quantity: 1, taxable: 1 }, { unitPriceCents: 6000, quantity: 1, taxable: 1 }],
    discount: { type: 'amount', value: 1000 },
    taxRateBp: 1300,
    pricesIncludeTax: false,
  });
  assert.deepEqual([r.subtotalCents, r.discountCents, r.taxCents, r.totalCents], [10500, 1000, 1235, 10735]);
  assert.equal(formatCad(r.totalCents), '$107.35');
});

test('lines always add up to the invoice totals', () => {
  for (let i = 0; i < 500; i++) {
    const items = Array.from({ length: 1 + (i % 5) }, (_, k) => ({ unitPriceCents: 199 + ((i * 37 + k * 101) % 9000), quantity: 1 + (k % 3), taxable: (i + k) % 4 ? 1 : 0 }));
    const r = calculateInvoice({ items, discount: { type: 'percent', value: (i * 7) % 3000 }, taxRateBp: [500, 1300, 1500, 0][i % 4], pricesIncludeTax: i % 2 === 0 });
    assert.equal(r.lines.reduce((s, l) => s + l.discountCents, 0), r.discountCents);
    assert.equal(r.lines.reduce((s, l) => s + l.taxCents, 0), r.taxCents);
    assert.equal(r.lines.reduce((s, l) => s + l.lineTotalCents, 0), r.totalCents);
  }
});

test('discount cannot exceed subtotal; 100% discount gives a zero bill', () => {
  const items = [{ unitPriceCents: 1000, quantity: 1, taxable: 1 }];
  assert.throws(() => calculateInvoice({ items, discount: { type: 'amount', value: 1001 }, taxRateBp: 1300 }));
  const r = calculateInvoice({ items, discount: { type: 'percent', value: 10000 }, taxRateBp: 1300 });
  assert.equal(r.totalCents, 0);
});

'use strict';

// Sequential, permanent identifiers (CUS-000001, VIS-000001, INV-2026-000001).
// Must be called inside the same transaction that inserts the record.
function nextCounter(db, name) {
  db.prepare('INSERT INTO counters (name, value) VALUES (?, 0) ON CONFLICT(name) DO NOTHING').run(name);
  db.prepare('UPDATE counters SET value = value + 1 WHERE name = ?').run(name);
  return db.prepare('SELECT value FROM counters WHERE name = ?').get(name).value;
}

const pad = (n) => String(n).padStart(6, '0');

const nextCustomerCode = (db) => 'CUS-' + pad(nextCounter(db, 'customer'));
const nextVisitCode = (db) => 'VIS-' + pad(nextCounter(db, 'visit'));
const nextInvoiceNumber = (db, year) => `INV-${year}-` + pad(nextCounter(db, 'invoice:' + year));

module.exports = { nextCounter, nextCustomerCode, nextVisitCode, nextInvoiceNumber };

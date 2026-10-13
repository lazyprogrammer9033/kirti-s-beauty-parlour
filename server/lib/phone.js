'use strict';

// Digits-only phone used for lookups. North American numbers lose a leading
// country code 1 so "+1 (416) 555-1234" and "416-555-1234" match.
function normalizePhone(input) {
  let d = String(input || '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  return d;
}

function formatPhone(input) {
  const d = normalizePhone(input);
  if (d.length === 10) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  return String(input || '').trim();
}

module.exports = { normalizePhone, formatPhone };

'use strict';

function nowIso() {
  return new Date().toISOString();
}

// Local calendar date (YYYY-MM-DD) of an instant in the salon's time zone.
function businessDate(date, timeZone) {
  const d = date instanceof Date ? date : new Date(date);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function localHour(date, timeZone) {
  const h = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hour12: false }).format(date);
  return Number(h) % 24;
}

function addDays(ymd, n) {
  const d = new Date(ymd + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Monday of the week containing ymd.
function startOfWeek(ymd) {
  const d = new Date(ymd + 'T12:00:00Z');
  const dow = (d.getUTCDay() + 6) % 7;
  return addDays(ymd, -dow);
}

function isValidYmd(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));
}

module.exports = { nowIso, businessDate, localHour, addDays, startOfWeek, isValidYmd };

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

// Milliseconds the zone is ahead of UTC at a given instant.
function zoneOffset(ts, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ts));
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - Math.floor(ts / 1000) * 1000;
}

// The instant a wall-clock time (YYYY-MM-DD, HH:MM) happens in the salon's time zone.
function zonedToUtc(ymd, hm, timeZone) {
  const [y, mo, d] = ymd.split('-').map(Number);
  const [hh, mm] = hm.split(':').map(Number);
  const wall = Date.UTC(y, mo - 1, d, hh, mm);
  let ts = wall - zoneOffset(wall, timeZone);
  const second = zoneOffset(ts, timeZone);
  if (wall - second !== ts) ts = wall - second;
  return new Date(ts);
}

// Local HH:MM of an instant in the salon's time zone.
function localTime(date, timeZone) {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date instanceof Date ? date : new Date(date));
}

const isValidHm = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

module.exports = { nowIso, businessDate, localHour, addDays, startOfWeek, isValidYmd, zonedToUtc, localTime, isValidHm };

'use strict';

const crypto = require('crypto');
const { zonedToUtc, addDays, businessDate } = require('./time');

// Per-appointment links for customers: /a/<id>-<expiry>-<signature>. The
// signature uses the key that lives next to the database, so links can't be
// guessed or altered, and each one expires a week after the appointment.
const LINK_DAYS_AFTER = 7;

function linkKey(ctx) {
  return crypto.createHmac('sha256', ctx.settings.key).update('customer-links-v1').digest();
}

function sign(ctx, payload) {
  return crypto.createHmac('sha256', linkKey(ctx)).update(payload).digest('base64url').slice(0, 22);
}

function makeToken(ctx, a) {
  const exp = Math.floor(new Date(a.endAt || a.startAt).getTime() / 1000) + LINK_DAYS_AFTER * 86400;
  const payload = `${a.id}-${exp.toString(36)}`;
  return `${payload}-${sign(ctx, payload)}`;
}

// Returns the appointment id, or null when the link is forged or expired.
function readToken(ctx, token) {
  const m = /^(\d{1,9})-([0-9a-z]{1,10})-([\w-]{22})$/.exec(String(token || ''));
  if (!m) return null;
  const payload = `${m[1]}-${m[2]}`;
  const expected = Buffer.from(sign(ctx, payload));
  const given = Buffer.from(m[3]);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  if (parseInt(m[2], 36) * 1000 < Date.now()) return null;
  return Number(m[1]);
}

function publicBase(ctx) {
  return (ctx.settings.get('public_base_url') || '').replace(/\/+$/, '');
}

// The link for one action, or null when customer links are not switched on.
function customerLink(ctx, a, action = '') {
  const base = publicBase(ctx);
  if (!base || ctx.settings.get('appt_customer_links') !== '1' || !a.id) return null;
  return `${base}/a/${makeToken(ctx, a)}${action ? '/' + action : ''}`;
}

function openDays(ctx) {
  return new Set(String(ctx.settings.get('appt_open_days') ?? '0,1,2,3,4,5,6').split(',').filter(Boolean).map(Number));
}

// Free start times on one salon day for a booking of `minutes`, skipping the
// customer's own appointment and anything too soon to book.
function freeSlots(ctx, ymd, minutes, ignoreId) {
  const s = ctx.settings;
  const tz = s.timezone();
  const dow = new Date(ymd + 'T12:00:00Z').getUTCDay();
  if (!openDays(ctx).has(dow)) return [];
  const open = s.get('appt_open_time') || '10:00';
  const close = s.get('appt_close_time') || '19:00';
  const earliest = Date.now() + Number(s.get('appt_change_cutoff_hours') ?? 2) * 3600000;
  const dayStart = zonedToUtc(ymd, '00:00', tz).toISOString();
  const dayEnd = zonedToUtc(addDays(ymd, 1), '00:00', tz).toISOString();
  const busy = ctx.db().prepare(`SELECT start_at, end_at FROM appointments WHERE status IN ('booked','confirmed') AND id != ? AND start_at < ? AND end_at > ?`)
    .all(ignoreId || 0, dayEnd, dayStart).map((r) => [Date.parse(r.start_at), Date.parse(r.end_at)]);
  const toMin = (hm) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3));
  const out = [];
  for (let m = toMin(open); m + minutes <= toMin(close); m += 15) {
    const hm = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    const start = zonedToUtc(ymd, hm, tz).getTime();
    const end = start + minutes * 60000;
    if (start < earliest) continue;
    if (busy.some(([bs, be]) => bs < end && be > start)) continue;
    out.push(hm);
  }
  return out;
}

// The next `count` days the salon is open, from today.
function upcomingOpenDays(ctx, count = 14) {
  const days = [];
  const tz = ctx.settings.timezone();
  let d = businessDate(new Date(), tz);
  const open = openDays(ctx);
  for (let i = 0; i < 60 && days.length < count; i++, d = addDays(d, 1)) {
    if (open.has(new Date(d + 'T12:00:00Z').getUTCDay())) days.push(d);
  }
  return days;
}

// Can the customer still change this booking themselves?
function changeable(ctx, a) {
  if (!['booked', 'confirmed'].includes(a.status)) return false;
  const cutoff = Number(ctx.settings.get('appt_change_cutoff_hours') ?? 2) * 3600000;
  return Date.parse(a.startAt) - cutoff > Date.now();
}

module.exports = { makeToken, readToken, customerLink, freeSlots, upcomingOpenDays, changeable, publicBase };

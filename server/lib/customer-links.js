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

// Customers can book and move appointments up to a year ahead.
const BOOKING_DAYS = 365;

function lastBookableDay(ctx) {
  return addDays(businessDate(new Date(), ctx.settings.timezone()), BOOKING_DAYS);
}

// Is this salon day within the online booking window (today to a year out)?
function bookableDay(ctx, ymd) {
  const today = businessDate(new Date(), ctx.settings.timezone());
  return ymd >= today && ymd <= lastBookableDay(ctx);
}

// Times the owner has blocked that overlap [startIso, endIso).
function blocksBetween(db, startIso, endIso) {
  return db.prepare('SELECT id, start_at AS startAt, end_at AS endAt, reason FROM appointment_blocks WHERE start_at < ? AND end_at > ? ORDER BY start_at')
    .all(endIso, startIso);
}

// Free start times on one salon day for a booking of `minutes`, skipping the
// customer's own appointment, blocked times and anything too soon to book.
function freeSlots(ctx, ymd, minutes, ignoreId) {
  const s = ctx.settings;
  const tz = s.timezone();
  const dow = new Date(ymd + 'T12:00:00Z').getUTCDay();
  if (!openDays(ctx).has(dow) || !bookableDay(ctx, ymd)) return [];
  const open = s.get('appt_open_time') || '10:00';
  const close = s.get('appt_close_time') || '19:00';
  const earliest = Date.now() + Number(s.get('appt_change_cutoff_hours') ?? 2) * 3600000;
  const dayStart = zonedToUtc(ymd, '00:00', tz).toISOString();
  const dayEnd = zonedToUtc(addDays(ymd, 1), '00:00', tz).toISOString();
  const db = ctx.db();
  const busy = db.prepare(`SELECT start_at, end_at FROM appointments WHERE status IN ('booked','confirmed') AND id != ? AND start_at < ? AND end_at > ?`)
    .all(ignoreId || 0, dayEnd, dayStart).map((r) => [Date.parse(r.start_at), Date.parse(r.end_at)])
    .concat(blocksBetween(db, dayStart, dayEnd).map((b) => [Date.parse(b.startAt), Date.parse(b.endAt)]));
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

// Has the owner blocked the whole of this day's opening hours?
function dayBlocked(ctx, ymd) {
  const tz = ctx.settings.timezone();
  const open = zonedToUtc(ymd, ctx.settings.get('appt_open_time') || '10:00', tz).toISOString();
  const close = zonedToUtc(ymd, ctx.settings.get('appt_close_time') || '19:00', tz).toISOString();
  return !!ctx.db().prepare('SELECT 1 FROM appointment_blocks WHERE start_at <= ? AND end_at >= ?').get(open, close);
}

// One month of the booking calendar: every day with how many times are free.
// state: past | closed | full | open (closed covers days outside the window).
function monthDays(ctx, ym, minutes, ignoreId) {
  const today = businessDate(new Date(), ctx.settings.timezone());
  const last = lastBookableDay(ctx);
  const open = openDays(ctx);
  const out = [];
  for (let d = ym + '-01'; d.slice(0, 7) === ym; d = addDays(d, 1)) {
    let state;
    let free = 0;
    if (d < today) state = 'past';
    else if (d > last || !open.has(new Date(d + 'T12:00:00Z').getUTCDay())) state = 'closed';
    else {
      free = freeSlots(ctx, d, minutes, ignoreId).length;
      state = free ? 'open' : dayBlocked(ctx, d) ? 'closed' : 'full';
    }
    out.push({ date: d, free, state });
  }
  return out;
}

// The first day with a free time, searching the whole booking window.
function firstFreeDay(ctx, minutes, ignoreId) {
  const last = lastBookableDay(ctx);
  for (let d = businessDate(new Date(), ctx.settings.timezone()); d <= last; d = addDays(d, 1)) {
    if (freeSlots(ctx, d, minutes, ignoreId).length) return d;
  }
  return null;
}

// Can the customer still change this booking themselves?
function changeable(ctx, a) {
  if (!['booked', 'confirmed'].includes(a.status)) return false;
  const cutoff = Number(ctx.settings.get('appt_change_cutoff_hours') ?? 2) * 3600000;
  return Date.parse(a.startAt) - cutoff > Date.now();
}

module.exports = { makeToken, readToken, customerLink, freeSlots, monthDays, firstFreeDay, bookableDay, lastBookableDay, blocksBetween, changeable, publicBase, BOOKING_DAYS };

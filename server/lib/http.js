'use strict';

const { can } = require('./auth');

class HttpError extends Error {
  constructor(status, message, data) {
    super(message);
    this.status = status;
    this.expose = true;
    this.data = data;
  }
}

const requirePerm = (permission) => (req, res, next) =>
  can(req.user, permission) ? next() : next(new HttpError(403, 'You do not have permission to do this. Please ask the owner.'));

function intParam(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `Invalid ${name || 'id'}`);
  return n;
}

function str(value, { max = 500, required = false, label = 'value' } = {}) {
  const s = value == null ? '' : String(value).trim();
  if (required && !s) throw new HttpError(400, `${label} is required`);
  if (s.length > max) throw new HttpError(400, `${label} is too long`);
  return s || null;
}

function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  // Neutralise spreadsheet formula injection.
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? "'" + s : s;
  return /[",\n\r]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
}

function toCsv(columns, rows) {
  const head = columns.map((c) => csvEscape(c.label)).join(',');
  const body = rows.map((r) => columns.map((c) => csvEscape(c.format ? c.format(r[c.key], r) : r[c.key])).join(','));
  return '﻿' + [head, ...body].join('\r\n') + '\r\n';
}

// A random id the iPad attaches to records saved offline (see offline.js).
function readClientRef(v) {
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || !/^[\w-]{8,64}$/.test(v)) throw new HttpError(400, 'Invalid client reference');
  return v;
}

module.exports = { HttpError, requirePerm, intParam, str, toCsv, csvEscape, readClientRef };

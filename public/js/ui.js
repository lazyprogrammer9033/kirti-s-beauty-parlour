// Small DOM toolkit. Every piece of text goes through textContent, so customer
// data can never be interpreted as HTML.

export function h(tag, attrs, ...children) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs);
    attrs = null;
  }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = [el.className, v].filter(Boolean).join(' ');
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'readOnly') el[k] = !!v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

// ---------- Icons (stroke icons drawn on a 24px grid) ----------
const ICONS = {
  dashboard: 'M3 13h8V3H3zM13 21h8V11h-8zM3 21h8v-6H3zM13 3v6h8V3z',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  userPlus: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM19 8v6M22 11h-6',
  sparkles: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9zM5 2l.6 1.4L7 4l-1.4.6L5 6l-.6-1.4L3 4l1.4-.6z',
  receipt: 'M4 2v20l3-2 3 2 2-2 2 2 3-2 3 2V2l-3 2-3-2-2 2-2-2-3 2zM8 8h8M8 12h8M8 16h5',
  calendar: 'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z',
  scissors: 'M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM20 4L8.12 15.88M14.47 14.48L20 20M8.12 8.12L12 12',
  chart: 'M3 3v18h18M7 16v-5M12 16V8M17 16v-8',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  x: 'M18 6L6 18M6 6l12 12',
  check: 'M20 6L9 17l-5-5',
  chevronRight: 'M9 18l6-6-6-6',
  chevronLeft: 'M15 18l-6-6 6-6',
  phone: 'M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z',
  mail: 'M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2zM22 6l-10 7L2 6',
  printer: 'M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v8H6z',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
  upload: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12',
  cloud: 'M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z',
  dollar: 'M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6',
  edit: 'M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z',
  note: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M16 13H8M16 17H8M10 9H8',
  clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  alert: 'M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4M12 17h.01',
  repeat: 'M17 1l4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3',
  trash: 'M3 6h18M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2',
  heart: 'M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78z',
  delete: 'M21 4H8l-7 8 7 8h13a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zM18 9l-6 6M12 9l6 6',
  menu: 'M3 12h18M3 6h18M3 18h18',
  tag: 'M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82zM7 7h.01',
};

export function icon(name, size = 22) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[name] || ICONS.sparkles);
  svg.append(path);
  return svg;
}

// ---------- Formatting ----------
export const money = (cents) => {
  const n = Number(cents || 0);
  const abs = Math.abs(n);
  return (n < 0 ? '-' : '') + '$' + Math.floor(abs / 100).toLocaleString('en-CA') + '.' + String(abs % 100).padStart(2, '0');
};
export const moneyShort = (cents) => {
  const d = Number(cents || 0) / 100;
  if (Math.abs(d) >= 10000) return '$' + (d / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return '$' + Math.round(d).toLocaleString('en-CA');
};

let tz = 'America/Toronto';
export const setTimeZone = (z) => (tz = z || tz);
export const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString('en-CA', { timeZone: tz, year: 'numeric', month: 'long', day: 'numeric' }) : '—');
export const fmtDateShort = (iso) => (iso ? new Date(iso).toLocaleDateString('en-CA', { timeZone: tz, month: 'short', day: 'numeric', year: 'numeric' }) : '—');
export const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString('en-CA', { timeZone: tz, hour: 'numeric', minute: '2-digit' }) : '');
export const fmtDateTime = (iso) => (iso ? `${fmtDateShort(iso)}, ${fmtTime(iso)}` : '—');
export const fmtYmd = (ymd) => (ymd ? new Date(ymd + 'T12:00:00Z').toLocaleDateString('en-CA', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' }) : '—');
export const todayYmd = () => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

export const METHODS = [
  ['cash', 'Cash'],
  ['debit', 'Debit'],
  ['credit', 'Credit Card'],
  ['etransfer', 'E-transfer'],
  ['other', 'Other'],
];
export const methodLabel = (m) => (METHODS.find((x) => x[0] === m) || [m, m])[1];

export function parseMoney(str) {
  const s = String(str ?? '').replace(/[$,\s]/g, '');
  if (!/^\d*(\.\d{0,2})?$/.test(s) || s === '' || s === '.') return null;
  const [w, f = ''] = s.split('.');
  return Number(w || 0) * 100 + Number((f + '00').slice(0, 2));
}

export function initials(name) {
  return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('');
}

export function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

// ---------- Feedback ----------
export function toast(message, kind = 'ok') {
  let box = document.getElementById('toasts');
  if (!box) {
    box = h('div', { id: 'toasts' });
    document.body.append(box);
  }
  const t = h('div.toast.' + kind, { role: 'status' }, icon(kind === 'error' ? 'alert' : 'check', 18), h('span', message));
  box.append(t);
  setTimeout(() => t.classList.add('out'), 3200);
  setTimeout(() => t.remove(), 3600);
}

export function modal({ title, body, actions = [], wide = false, onClose }) {
  const close = () => {
    overlay.classList.add('out');
    setTimeout(() => overlay.remove(), 160);
    document.removeEventListener('keydown', onKey);
    onClose && onClose();
  };
  const onKey = (e) => e.key === 'Escape' && close();
  document.addEventListener('keydown', onKey);
  const dialog = h('div.modal' + (wide ? '.wide' : ''), { role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div.modal-head', h('h2', title), h('button.icon-btn', { type: 'button', 'aria-label': 'Close', onclick: close }, icon('x'))),
    h('div.modal-body', body),
    actions.length ? h('div.modal-actions', actions) : null);
  const overlay = h('div.overlay', { onmousedown: (e) => e.target === overlay && close() }, dialog);
  document.body.append(overlay);
  const first = dialog.querySelector('input:not([type=hidden]),select,textarea');
  if (first && !matchMedia('(pointer: coarse)').matches) setTimeout(() => first.focus(), 50);
  return { close, dialog };
}

export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false, typeWord }) {
  return new Promise((resolve) => {
    let done = false;
    const input = typeWord ? h('input.input', { placeholder: `Type ${typeWord}`, autocapitalize: 'characters', autocomplete: 'off' }) : null;
    const btn = h('button.btn' + (danger ? '.danger' : '.primary'), { type: 'button', disabled: !!typeWord }, confirmLabel);
    if (input) input.addEventListener('input', () => (btn.disabled = input.value.trim().toUpperCase() !== typeWord));
    const m = modal({
      title,
      body: h('div.stack', h('p', message), input ? h('label.field', h('span', `To confirm, type ${typeWord}`), input) : null),
      actions: [h('button.btn.ghost', { type: 'button', onclick: () => m.close() }, 'Cancel'), btn],
      onClose: () => !done && resolve(false),
    });
    btn.addEventListener('click', () => {
      done = true;
      m.close();
      resolve(typeWord ? typeWord : true);
    });
  });
}

export function field(label, control, hint) {
  return h('label.field', h('span.label', label), control, hint ? h('span.hint', hint) : null);
}

export function emptyState(iconName, title, text, action) {
  return h('div.empty', icon(iconName, 34), h('h3', title), text ? h('p', text) : null, action || null);
}

export function spinner() {
  return h('div.loading', h('span.dot'), h('span.dot'), h('span.dot'));
}

export function avatar(name, cls = '') {
  return h('div.avatar' + (cls ? '.' + cls : ''), initials(name));
}

// Bar chart drawn as inline SVG (no external chart library needed).
export function barChart(data, { valueKey = 'value', labelKey = 'label', format = (v) => v, height = 180, labelEvery = 1 } = {}) {
  const NS = 'http://www.w3.org/2000/svg';
  const width = Math.max(data.length * 28, 280);
  const max = Math.max(1, ...data.map((d) => d[valueKey]));
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height + 28}`);
    svg.classList.add('bar-chart');
  const bw = width / data.length;
  data.forEach((d, i) => {
    const v = d[valueKey];
    const bh = Math.max(v > 0 ? 3 : 0, (v / max) * (height - 10));
    const rect = document.createElementNS(NS, 'rect');
    rect.setAttribute('x', i * bw + bw * 0.18);
    rect.setAttribute('y', height - bh);
    rect.setAttribute('width', bw * 0.64);
    rect.setAttribute('height', bh);
    rect.setAttribute('rx', Math.min(6, bw * 0.2));
    rect.classList.add('bar');
    const title = document.createElementNS(NS, 'title');
    title.textContent = `${d[labelKey]}: ${format(v)}`;
    rect.append(title);
    svg.append(rect);
    if (i % labelEvery === 0) {
      const t = document.createElementNS(NS, 'text');
      t.setAttribute('x', i * bw + bw / 2);
      t.setAttribute('y', height + 18);
      t.setAttribute('text-anchor', 'middle');
      t.textContent = String(d[labelKey]).slice(0, 10);
      svg.append(t);
    }
  });
  return h('div.chart-wrap', svg);
}

// Horizontal bars for "top N" lists; readable on small screens.
export function hbarList(items, { label, value, format, sub }) {
  const max = Math.max(1, ...items.map(value));
  return h('div.hbars', items.map((it) =>
    h('div.hbar',
      h('div.hbar-top', h('span.hbar-label', label(it)), h('span.hbar-value', format(value(it)))),
      h('div.hbar-track', h('div.hbar-fill', { style: { width: Math.max(2, (value(it) / max) * 100) + '%' } })),
      sub ? h('div.hbar-sub', sub(it)) : null)));
}

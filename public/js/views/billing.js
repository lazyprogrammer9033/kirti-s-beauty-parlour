import { h, clear, icon, money, fmtDateTime, methodLabel, debounce, spinner, emptyState, todayYmd } from '../ui.js';
import { api } from '../api.js';
import { pageHeader, statusBadge } from './shared.js';

export async function render(view, { query }) {
  let range = query.get('range') || 'today';
  const list = h('div');
  const totalEl = h('div.billing-total');
  const input = h('input.input.search-input', { type: 'search', placeholder: 'Invoice number, customer name or phone', autocomplete: 'off', 'aria-label': 'Search bills' });
  const ranges = [['today', 'Today'], ['outstanding', 'Unpaid'], ['week', 'Last 7 days'], ['all', 'All']];
  const chips = h('div.chips', ranges.map(([v, l]) => h('button.chip' + (v === range ? '.on' : ''), { type: 'button', onclick: (e) => { range = v; chips.querySelectorAll('.chip').forEach((c) => c.classList.remove('on')); e.currentTarget.classList.add('on'); load(); } }, l)));

  async function load() {
    clear(list, spinner());
    const today = todayYmd();
    const p = new URLSearchParams();
    if (range === 'today') p.set('from', today), p.set('to', today);
    if (range === 'week') {
      const d = new Date(today + 'T12:00:00Z');
      d.setUTCDate(d.getUTCDate() - 6);
      p.set('from', d.toISOString().slice(0, 10));
    }
    if (range === 'outstanding') p.set('status', 'outstanding');
    if (input.value.trim()) p.set('q', input.value.trim());
    const rows = await api.get('/invoices?' + p);
    const valid = rows.filter((r) => r.status !== 'void');
    clear(totalEl,
      h('div', h('span.muted', range === 'outstanding' ? 'Total owing' : 'Total sales'), h('strong', money(range === 'outstanding' ? valid.reduce((s, r) => s + r.balanceCents, 0) : valid.reduce((s, r) => s + r.totalCents, 0)))),
      h('div', h('span.muted', 'Bills'), h('strong', String(valid.length))));
    clear(list, rows.length
      ? h('div.table-card.card', h('table.table',
          h('thead', h('tr', h('th', 'Invoice'), h('th', 'Customer'), h('th.hide-sm', 'Date'), h('th.hide-sm', 'Paid by'), h('th', 'Status'), h('th.num', 'Total'))),
          h('tbody', rows.map((r) => h('tr.clickable', { onclick: () => (location.hash = '#/invoice/' + r.id) },
            h('td', h('a', { href: '#/invoice/' + r.id }, r.invoiceNumber)),
            h('td', h('div', r.customerName), h('div.muted.small', r.phone)),
            h('td.hide-sm', fmtDateTime(r.issuedAt)),
            h('td.hide-sm', (r.methods || '').split(',').filter(Boolean).map(methodLabel).join(' + ') || '—'),
            h('td', statusBadge(r.status), r.balanceCents > 0 ? h('div.small.owing', money(r.balanceCents) + ' owing') : null),
            h('td.num', h('strong', money(r.totalCents))))))))
      : emptyState('receipt', 'No bills here', range === 'today' ? 'Bills created today will appear here.' : 'Try a different filter.', h('a.btn.primary', { href: '#/visit' }, icon('plus', 18), 'Create Bill')));
  }

  input.addEventListener('input', debounce(load, 200));
  clear(view,
    pageHeader('Billing', 'Receipts, payments and balances.', h('a.btn.primary', { href: '#/visit?step=bill' }, icon('plus', 18), 'Create Bill')),
    h('div.toolbar', chips, h('div.search-box.grow', icon('search', 20), input)),
    totalEl,
    list);
  await load();
}

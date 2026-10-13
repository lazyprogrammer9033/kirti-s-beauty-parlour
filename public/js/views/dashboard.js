import { h, clear, icon, money, moneyShort, fmtTime, barChart, hbarList, debounce, spinner, emptyState, fmtYmd, todayYmd } from '../ui.js';
import { api } from '../api.js';
import { session } from '../app.js';
import { customerCard, customerFormModal, statusBadge } from './shared.js';

function greeting() {
  const hr = new Date().getHours();
  return hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening';
}

function stat(label, value, sub, iconName, tone = '') {
  return h('div.stat-card' + (tone ? '.' + tone : ''),
    h('div.stat-icon', icon(iconName, 20)),
    h('div.stat-label', label),
    h('div.stat-value', value),
    sub ? h('div.stat-sub', sub) : null);
}

// Search box that shows matching customers with quick actions as you type.
export function quickSearch({ autofocus = false } = {}) {
  const results = h('div.search-results');
  const input = h('input.input.search-input', {
    type: 'search',
    placeholder: 'Phone number, name, email or customer ID',
    autocomplete: 'off',
    autocapitalize: 'none',
    spellcheck: 'false',
    'aria-label': 'Search customers',
  });
  let seq = 0;
  const run = debounce(async () => {
    const q = input.value.trim();
    const mine = ++seq;
    if (q.length < 2) return clear(results);
    const rows = await api.get('/customers/search?q=' + encodeURIComponent(q)).catch(() => []);
    if (mine !== seq) return;
    const digits = q.replace(/\D/g, '');
    clear(results,
      rows.length
        ? rows.slice(0, 6).map((c) => customerCard(c))
        : h('div.no-match',
            h('div', h('strong', 'No customer found'), h('p.muted', `Nothing matches “${q}”.`)),
            h('button.btn.primary', {
              type: 'button',
              onclick: async () => {
                const res = await customerFormModal({ phone: digits.length >= 7 ? q : '' });
                if (res) location.hash = '#/visit?customer=' + res.id;
              },
            }, icon('userPlus', 18), 'Create New Customer')));
  }, 160);
  input.addEventListener('input', run);
  if (autofocus && !matchMedia('(pointer: coarse)').matches) setTimeout(() => input.focus(), 50);
  return { el: h('div.quick-search', h('div.search-box', icon('search', 22), input), results), input };
}

export async function render(view) {
  const search = quickSearch({ autofocus: true });
  const firstName = session.user.displayName.split(' ')[0];
  const actions = h('div.quick-actions',
    h('button.quick-action', { type: 'button', onclick: async () => { const r = await customerFormModal(); if (r) location.hash = '#/customer/' + r.id; } }, h('span.qa-icon', icon('userPlus', 26)), h('span', 'New Customer')),
    h('a.quick-action.primary', { href: '#/visit' }, h('span.qa-icon', icon('sparkles', 26)), h('span', 'New Visit')),
    h('a.quick-action', { href: '#/visit?step=bill' }, h('span.qa-icon', icon('receipt', 26)), h('span', 'Create Bill')),
    h('button.quick-action', { type: 'button', onclick: () => { search.input.focus(); search.input.scrollIntoView({ block: 'center', behavior: 'smooth' }); } }, h('span.qa-icon', icon('search', 26)), h('span', 'Search Customer')),
    h('a.quick-action', { href: '#/billing?range=today' }, h('span.qa-icon', icon('dollar', 26)), h('span', "Today's Sales")));

  const body = h('div.stack-lg', spinner());
  clear(view,
    h('div.hero',
      h('div', h('p.eyebrow', fmtYmd(todayYmd())), h('h1.display', `${greeting()}, ${firstName}`)),
      search.el),
    actions,
    body);

  const d = await api.get('/dashboard');
  const t = d.todayStats;
  const blocks = [];
  if (d.financials) {
    blocks.push(h('section',
      h('h2.section-title', 'Today'),
      h('div.stat-grid.six',
        stat("Today's sales", money(t.salesCents), `${t.visits} visit${t.visits === 1 ? '' : 's'}`, 'dollar', 'rose'),
        stat('Customers', String(t.customers), `${t.newCustomers} new · ${t.returningCustomers} returning`, 'users'),
        stat('Visits', String(t.visits), null, 'sparkles'),
        stat('New customers', String(t.newCustomers), null, 'userPlus'),
        stat('Returning customers', String(t.returningCustomers), null, 'repeat'),
        stat('Outstanding payments', money(d.outstanding.cents), `${d.outstanding.invoices} unpaid bill${d.outstanding.invoices === 1 ? '' : 's'}`, 'alert', d.outstanding.cents ? 'warn' : ''))));
    blocks.push(h('section',
      h('h2.section-title', 'Performance'),
      h('div.stat-grid.six',
        stat('This week', money(d.weekSalesCents), null, 'chart'),
        stat('This month', money(d.monthSalesCents), null, 'chart'),
        stat('This year', money(d.yearSalesCents), null, 'chart'),
        stat('Visits this month', String(d.month.visits), null, 'calendar'),
        stat('New this month', String(d.month.newCustomers), null, 'userPlus'),
        stat('Returning this month', String(d.month.returningCustomers), null, 'repeat'))));
    blocks.push(h('div.grid-dash',
      h('section.card',
        h('div.card-head', h('h3', 'Sales — last 30 days'), h('a.link', { href: '#/reports/sales' }, 'Reports ', icon('chevronRight', 16))),
        barChart(d.dailySales.map((x) => ({ label: x.date.slice(8), value: x.total })), { format: money, labelEvery: 3 })),
      h('section.card',
        h('div.card-head', h('h3', 'Top services'), h('span.muted.small', 'Last 90 days')),
        d.topServices.length
          ? hbarList(d.topServices, { label: (s) => s.name, value: (s) => s.count, format: (v) => `${v}×`, sub: (s) => money(s.revenueCents) })
          : emptyState('scissors', 'No services yet', 'Completed visits will appear here.')),
      h('section.card',
        h('div.card-head', h('h3', 'Top customers'), h('span.muted.small', 'All time')),
        d.topCustomers.length
          ? h('div.list', d.topCustomers.map((c, i) => h('a.list-row', { href: '#/customer/' + c.id }, h('span.rank', String(i + 1)), h('span.grow', c.name), h('span.muted.small', `${c.visits} visits`), h('strong', moneyShort(c.spentCents)))))
          : emptyState('heart', 'No customers yet', 'Your best customers will appear here.'))));
  } else {
    blocks.push(h('div.stat-grid',
      stat('Visits today', String(t.visits), null, 'sparkles', 'rose'),
      stat('Customers today', String(t.customers), null, 'users'),
      stat('New customers', String(t.newCustomers), null, 'userPlus'),
      stat('Returning', String(t.returningCustomers), null, 'repeat')));
  }
  blocks.push(h('section.card',
    h('div.card-head', h('h3', "Today's visits"), h('a.link', { href: '#/billing?range=today' }, 'All bills ', icon('chevronRight', 16))),
    d.todayVisits.length
      ? h('div.list', d.todayVisits.map((v) =>
          h('a.list-row', { href: '#/invoice/' + v.invoiceId },
            h('span.time', fmtTime(v.visitAt)),
            h('span.grow', h('strong', v.customerName), h('span.muted.small.block', v.services || '')),
            statusBadge(v.status),
            h('strong', money(v.totalCents)))))
      : emptyState('sparkles', 'No visits yet today', 'Start with “New Visit” when a customer arrives.')));
  clear(body, blocks);
}

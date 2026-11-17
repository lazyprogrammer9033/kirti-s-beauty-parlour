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
  const action = (tag, attrs, iconName, label, sub) =>
    h(tag + '.quick-action', attrs, h('span.qa-icon', icon(iconName, 22)), h('span.qa-text', h('span.qa-label', label), h('span.qa-sub', sub)));
  const actions = h('div.quick-actions',
    action('a', { href: '#/visit', class: 'primary' }, 'sparkles', 'New Visit', 'Check in and bill'),
    action('button', { type: 'button', onclick: async () => { const r = await customerFormModal(); if (r) location.hash = '#/customer/' + r.id; } }, 'userPlus', 'New Customer', 'Add to your list'),
    action('a', { href: '#/visit?step=bill' }, 'receipt', 'Create Bill', 'Charge for services'),
    action('button', { type: 'button', onclick: () => { search.input.focus(); search.input.scrollIntoView({ block: 'center', behavior: 'smooth' }); } }, 'search', 'Search Customer', 'Phone, name or ID'),
    action('a', { href: '#/billing?range=today' }, 'dollar', "Today's Sales", 'Bills and payments'));

  const summary = h('p.hero-summary', ' ');
  const body = h('div.stack-lg', spinner());
  clear(view,
    h('section.hero',
      h('div.hero-text', h('p.eyebrow', fmtYmd(todayYmd())), h('h1.display', `${greeting()}, ${firstName}`), summary),
      h('div.hero-search', search.el)),
    actions,
    body);

  const today = todayYmd();
  const [d, appts] = await Promise.all([api.get('/dashboard'), session.can('appointments.view') ? api.get(`/appointments?from=${today}&to=${today}`).catch(() => []) : []]);
  const t = d.todayStats;
  const upcoming = appts.filter((a) => ['booked', 'confirmed'].includes(a.status));
  summary.textContent = upcoming.length
    ? `${upcoming.length} appointment${upcoming.length === 1 ? '' : 's'} today · next is ${upcoming[0].customerName} at ${fmtTime(upcoming[0].startAt)}`
    : t.visits ? `${t.visits} visit${t.visits === 1 ? '' : 's'} so far today` : 'No appointments booked for today yet';

  // Left column: what is happening today. Right column: today at a glance.
  const left = [];
  if (session.can('appointments.view')) {
    left.push(h('section.card',
      h('div.card-head', h('h3', "Today's appointments"), h('a.link', { href: '#/appointments' }, 'Calendar ', icon('chevronRight', 16))),
      upcoming.length
        ? h('div.timeline-list', upcoming.map((a) =>
            h('a.tl-item', { href: `#/visit?appointment=${a.id}` },
              h('span.tl-when', fmtTime(a.startAt)),
              h('span.tl-dot'),
              h('span.grow', h('strong', a.customerName), h('span.muted.small.block', a.services.map((x) => x.name).join(', '))),
              h('span.btn.soft.sm', 'Start visit'))))
        : emptyState('calendar', 'Nothing booked', 'Walk-ins can start with “New Visit”.')));
  }
  left.push(h('section.card',
    h('div.card-head', h('h3', "Today's visits"), h('a.link', { href: '#/billing?range=today' }, 'All bills ', icon('chevronRight', 16))),
    d.todayVisits.length
      ? h('div.list', d.todayVisits.map((v) =>
          h('a.list-row', { href: '#/invoice/' + v.invoiceId },
            h('span.time', fmtTime(v.visitAt)),
            h('span.grow', h('strong', v.customerName), h('span.muted.small.block', v.services || '')),
            statusBadge(v.status),
            h('strong.num', money(v.totalCents)))))
      : emptyState('sparkles', 'No visits yet today', 'Start with “New Visit” when a customer arrives.')));

  const glanceRow = (iconName, label, value, tone = '') => h('div.glance-row' + (tone ? '.' + tone : ''), h('span.glance-icon', icon(iconName, 18)), h('span.grow', label), h('strong', value));
  const right = d.financials
    ? h('section.card.today-card',
        h('p.today-label', "Today's sales"),
        h('p.today-value', money(t.salesCents)),
        h('p.today-sub', `${t.visits} visit${t.visits === 1 ? '' : 's'} · ${t.customers} customer${t.customers === 1 ? '' : 's'}`),
        h('div.glance',
          glanceRow('userPlus', 'New customers', String(t.newCustomers)),
          glanceRow('repeat', 'Returning customers', String(t.returningCustomers)),
          glanceRow('alert', `Unpaid bills (${d.outstanding.invoices})`, money(d.outstanding.cents), d.outstanding.cents ? 'warn' : '')))
    : h('section.card.today-card',
        h('p.today-label', 'Visits today'),
        h('p.today-value', String(t.visits)),
        h('div.glance',
          glanceRow('users', 'Customers today', String(t.customers)),
          glanceRow('userPlus', 'New customers', String(t.newCustomers)),
          glanceRow('repeat', 'Returning', String(t.returningCustomers))));

  const blocks = [h('div.dash-split', h('div.stack-lg', left), h('div', right))];
  if (d.financials) {
    const kpi = (label, value) => h('div.kpi', h('span.kpi-label', label), h('span.kpi-value', value));
    blocks.push(h('section',
      h('h2.section-title', 'Performance'),
      h('div.kpi-strip',
        kpi('This week', money(d.weekSalesCents)),
        kpi('This month', money(d.monthSalesCents)),
        kpi('This year', money(d.yearSalesCents)),
        kpi('Visits this month', String(d.month.visits)),
        kpi('New this month', String(d.month.newCustomers)),
        kpi('Returning this month', String(d.month.returningCustomers)))));
    if (d.staffSales?.length) {
      const visits = (n) => (n ? `${n} visit${n === 1 ? '' : 's'}` : '');
      blocks.push(h('section.card.table-card',
        h('div.card-head.pad-head', h('h3', 'Sales by staff'), h('a.link', { href: '#/reports/staff' }, 'Staff report ', icon('chevronRight', 16))),
        h('div.table-scroll', h('table.table',
          h('thead', h('tr', h('th', 'Staff member'), h('th.num', 'Today'), h('th.num.hide-sm', 'This week'), h('th.num', 'This month'))),
          h('tbody', d.staffSales.map((s) => h('tr',
            h('td', h('strong', s.name)),
            h('td.num', money(s.todayCents), h('div.muted.small', visits(s.todayVisits))),
            h('td.num.hide-sm', money(s.weekCents)),
            h('td.num', money(s.monthCents), h('div.muted.small', visits(s.monthVisits))))))))));
    }
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
  }
  clear(body, blocks);
}

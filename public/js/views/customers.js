import { h, clear, icon, debounce, spinner, emptyState } from '../ui.js';
import { api } from '../api.js';
import { customerCard, customerFormModal, pageHeader } from './shared.js';

export async function render(view) {
  const list = h('div.customer-list');
  const more = h('div.center');
  const input = h('input.input.search-input', { type: 'search', placeholder: 'Search by phone, name, email or customer ID', autocomplete: 'off', autocapitalize: 'none', 'aria-label': 'Search customers' });
  let status = 'active';
  let sort = 'recent';
  let offset = 0;
  const count = h('span.muted');

  const chips = h('div.chips',
    [['active', 'Active'], ['inactive', 'Inactive'], ['', 'All']].map(([v, l]) =>
      h('button.chip' + (v === status ? '.on' : ''), { type: 'button', onclick: (e) => { status = v; chips.querySelectorAll('.chip').forEach((c) => c.classList.remove('on')); e.currentTarget.classList.add('on'); load(true); } }, l)));
  const sortSel = h('select.input.sm', { 'aria-label': 'Sort', onchange: (e) => { sort = e.target.value; load(true); } },
    [['recent', 'Recent visit'], ['name', 'Name A–Z'], ['spent', 'Top spending'], ['created', 'Newest']].map(([v, l]) => h('option', { value: v, selected: v === sort }, l)));

  async function load(reset) {
    if (reset) offset = 0;
    const q = input.value.trim();
    if (reset) clear(list, spinner());
    if (q.length >= 2) {
      const rows = await api.get('/customers/search?q=' + encodeURIComponent(q));
      clear(more);
      count.textContent = `${rows.length} match${rows.length === 1 ? '' : 'es'}`;
      return clear(list, rows.length ? rows.map((c) => customerCard(c)) : emptyState('search', 'No customer found', `Nothing matches “${q}”.`,
        h('button.btn.primary', { type: 'button', onclick: newCustomer }, icon('userPlus', 18), 'Create New Customer')));
    }
    const res = await api.get(`/customers?status=${status}&sort=${sort}&limit=40&offset=${offset}`);
    if (reset) clear(list);
    count.textContent = `${res.total} customer${res.total === 1 ? '' : 's'}`;
    if (!res.total) list.append(emptyState('users', 'No customers yet', 'Add your first customer to get started.', h('button.btn.primary', { type: 'button', onclick: newCustomer }, icon('userPlus', 18), 'New Customer')));
    list.append(...res.rows.map((c) => customerCard(c)));
    offset += res.rows.length;
    clear(more, offset < res.total ? h('button.btn.ghost', { type: 'button', onclick: () => load(false) }, 'Show more') : null);
  }

  async function newCustomer() {
    const r = await customerFormModal({ phone: /^\+?[\d\s()-]{7,}$/.test(input.value) ? input.value : '' });
    if (r) location.hash = '#/customer/' + r.id;
  }

  input.addEventListener('input', debounce(() => load(true), 180));
  clear(view,
    pageHeader('Customers', 'Find a customer by phone number in seconds.', h('button.btn.primary', { type: 'button', onclick: newCustomer }, icon('userPlus', 18), 'New Customer')),
    h('div.search-box.big', icon('search', 22), input),
    h('div.toolbar', chips, h('div.toolbar-right', count, sortSel)),
    list, more);
  if (!matchMedia('(pointer: coarse)').matches) input.focus();
  await load(true);
}

import { h, clear, icon, toast, field, setTimeZone, avatar } from './ui.js';
import { api, setUnauthorizedHandler } from './api.js';

// Shared session state for all views.
export const session = {
  user: null,
  settings: {},
  can(perm) {
    const p = this.user?.permissions || [];
    return p.includes('*') || p.includes(perm);
  },
  get isOwner() {
    return this.user?.role === 'owner';
  },
};

const NAV = [
  { path: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
  { path: 'customers', label: 'Customers', icon: 'users' },
  { path: 'visit', label: 'New Visit', icon: 'sparkles', primary: true },
  { path: 'billing', label: 'Billing', icon: 'receipt' },
  { path: 'appointments', label: 'Appointments', icon: 'calendar' },
  { path: 'services', label: 'Services', icon: 'scissors' },
  { path: 'reports', label: 'Reports', icon: 'chart', perm: 'reports.view' },
  { path: 'settings', label: 'Settings', icon: 'settings' },
];

const ROUTES = {
  dashboard: () => import('./views/dashboard.js'),
  customers: () => import('./views/customers.js'),
  customer: () => import('./views/customer.js'),
  visit: () => import('./views/visit.js'),
  billing: () => import('./views/billing.js'),
  invoice: () => import('./views/invoice.js'),
  appointments: () => import('./views/appointments.js'),
  services: () => import('./views/services.js'),
  reports: () => import('./views/reports.js'),
  settings: () => import('./views/settings.js'),
};

export function navigate(path) {
  if (location.hash === '#/' + path) route();
  else location.hash = '#/' + path;
}

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '') || 'dashboard';
  const [pathPart, queryPart] = raw.split('?');
  const parts = pathPart.split('/').filter(Boolean);
  return { name: parts[0], params: parts.slice(1), query: new URLSearchParams(queryPart || '') };
}

let main;
let navEl;
let routeToken = 0;

async function route() {
  if (!session.user) return;
  const { name, params, query } = parseHash();
  const loader = ROUTES[name];
  const token = ++routeToken;
  for (const a of navEl.querySelectorAll('a[data-path]')) {
    const active = a.dataset.path === name || (name === 'customer' && a.dataset.path === 'customers') || (name === 'invoice' && a.dataset.path === 'billing');
    a.classList.toggle('active', active);
    if (active) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  document.body.classList.remove('nav-open');
  if (!loader) return navigate('dashboard');
  const view = h('div.view');
  clear(main, view);
  main.scrollTop = 0;
  window.scrollTo(0, 0);
  try {
    const mod = await loader();
    if (token !== routeToken) return;
    await mod.render(view, { params, query });
  } catch (e) {
    if (token !== routeToken) return;
    console.error(e);
    clear(view, h('div.card.error-card', h('h2', 'Something went wrong'), h('p', e.message || String(e)), h('button.btn', { onclick: () => route() }, 'Try again')));
  }
}

function shell() {
  const user = session.user;
  navEl = h('nav.sidebar', { 'aria-label': 'Main' },
    h('div.brand', h('div.brand-mark', icon('sparkles', 20)), h('div.brand-text', h('span.brand-name', session.settings.business_name || 'Beauty Parlour'), h('span.brand-sub', 'Salon Manager'))),
    h('div.nav-links',
      NAV.filter((n) => !n.perm || session.can(n.perm)).map((n) =>
        h('a.nav-link' + (n.primary ? '.nav-primary' : ''), { href: '#/' + n.path, dataset: { path: n.path } }, icon(n.icon), h('span', n.label)))),
    h('div.nav-user',
      avatar(user.displayName, 'sm'),
      h('div.nav-user-text', h('span.nav-user-name', user.displayName), h('span.nav-user-role', user.role === 'owner' ? 'Owner' : 'Staff')),
      user.openAccess ? null : h('button.icon-btn', { type: 'button', title: 'Sign out', 'aria-label': 'Sign out', onclick: logout }, icon('logout', 20))));
  main = h('main.main', { id: 'main' });
  const topbar = h('header.topbar',
    h('button.icon-btn', { type: 'button', 'aria-label': 'Menu', onclick: () => document.body.classList.toggle('nav-open') }, icon('menu')),
    h('span.topbar-title', session.settings.business_name || 'Beauty Parlour'),
    h('a.btn.primary.sm', { href: '#/visit' }, icon('plus', 18), 'New Visit'));
  const scrim = h('div.scrim', { onclick: () => document.body.classList.remove('nav-open') });
  clear(document.getElementById('app'), h('div.layout', navEl, scrim, h('div.content', topbar, main)));
}

async function logout() {
  await api.post('/auth/logout').catch(() => {});
  session.user = null;
  location.hash = '';
  boot();
}

export async function refreshSettings() {
  session.settings = await api.get('/settings');
  setTimeZone(session.settings.timezone);
}

function authScreen({ setup, businessName }) {
  const err = h('p.form-error', { role: 'alert' });
  const fields = setup
    ? {
        businessName: h('input.input', { value: businessName || '', autocomplete: 'organization', required: true }),
        displayName: h('input.input', { autocomplete: 'name', required: true, placeholder: 'e.g. Kirti' }),
        username: h('input.input', { autocomplete: 'username', autocapitalize: 'none', required: true }),
        password: h('input.input', { type: 'password', autocomplete: 'new-password', required: true, minlength: 8 }),
      }
    : {
        username: h('input.input', { autocomplete: 'username', autocapitalize: 'none', required: true }),
        password: h('input.input', { type: 'password', autocomplete: 'current-password', required: true }),
      };
  const btn = h('button.btn.primary.lg.block', { type: 'submit' }, setup ? 'Create owner account' : 'Sign in');
  const form = h('form.auth-form', {
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      btn.disabled = true;
      try {
        const body = Object.fromEntries(Object.entries(fields).map(([k, el]) => [k, el.value]));
        await api.post(setup ? '/auth/setup' : '/auth/login', body);
        boot();
      } catch (ex) {
        err.textContent = ex.message;
        btn.disabled = false;
      }
    },
  },
  setup ? [
    field('Salon name', fields.businessName),
    field('Your name', fields.displayName),
    field('Choose a username', fields.username),
    field('Choose a password', fields.password, 'At least 8 characters. Keep it private.'),
  ] : [field('Username', fields.username), field('Password', fields.password)],
  err, btn);
  clear(document.getElementById('app'),
    h('div.auth',
      h('div.auth-art', h('div.auth-art-inner', h('div.brand-mark.lg', icon('sparkles', 34)), h('h1.display', businessName || 'Beauty Parlour'), h('p', 'Salon Manager'))),
      h('div.auth-panel',
        h('div.auth-card',
          h('h2.display', setup ? 'Welcome! Let’s set up your salon' : 'Welcome back'),
          h('p.muted', setup ? 'Create the owner account. You can add staff accounts later in Settings.' : 'Sign in to continue.'),
          form))));
  setTimeout(() => Object.values(fields)[0].focus(), 50);
}

export async function boot() {
  let status;
  try {
    status = await api.get('/auth/status');
  } catch (e) {
    clear(document.getElementById('app'), h('div.auth', h('div.auth-panel', h('div.auth-card', h('h2', 'Cannot connect'), h('p', e.message), h('button.btn.primary', { onclick: boot }, 'Try again')))));
    return;
  }
  document.title = status.businessName || 'Salon Manager';
  if (!status.user) return authScreen({ setup: status.setupRequired, businessName: status.businessName });
  session.user = status.user;
  await refreshSettings();
  shell();
  route();
}

setUnauthorizedHandler(() => {
  if (session.user) {
    session.user = null;
    toast('Please sign in again', 'error');
    boot();
  }
});
window.addEventListener('hashchange', route);
boot();

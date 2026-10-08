import { h, clear, icon, toast, field, setTimeZone, avatar, modal, money, confirmDialog, fmtDateTime } from './ui.js';
import { api, setUnauthorizedHandler } from './api.js';
import { offline, goOffline, probe, sync, isSyncing, refreshSnapshot, review } from './offline.js';

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
  if (offline.active && name !== 'visit') return offlinePage(view);
  try {
    const mod = await loader();
    if (token !== routeToken) return;
    await mod.render(view, { params, query });
  } catch (e) {
    if (token !== routeToken) return;
    if (e.status === 0 && offline.snapshot) {
      goOffline();
      if (name !== 'visit') return offlinePage(view);
    }
    console.error(e);
    clear(view, h('div.card.error-card', h('h2', 'Something went wrong'), h('p', e.message || String(e)), h('button.btn', { onclick: () => route() }, 'Try again')));
  }
}

function shell() {
  const user = session.user;
  navEl = h('nav.sidebar', { 'aria-label': 'Main' },
    h('div.brand', h('img.brand-mark', { src: '/img/icon.svg', alt: '' }), h('div.brand-text', h('span.brand-name', session.settings.business_name || 'Beauty Parlour'), h('span.brand-sub', 'Salon Manager'))),
    h('div.nav-links',
      NAV.filter((n) => !n.perm || session.can(n.perm)).map((n) =>
        h('a.nav-link' + (n.primary ? '.nav-primary' : ''), { href: '#/' + n.path, dataset: { path: n.path } }, icon(n.icon), h('span', n.label)))),
    h('div.nav-user',
      avatar(user.displayName, 'sm'),
      h('div.nav-user-text', h('span.nav-user-name', user.displayName), h('span.nav-user-role', user.role === 'owner' ? 'Owner' : 'Staff')),
      user.openAccess ? null : h('button.icon-btn', { type: 'button', title: 'Sign out', 'aria-label': 'Sign out', onclick: logout }, icon('logout', 20))));
  main = h('main.main', { id: 'main' });
  offlineBar = h('div.offline-bar', { role: 'status', hidden: true });
  const topbar = h('header.topbar',
    h('button.icon-btn', { type: 'button', 'aria-label': 'Menu', onclick: () => document.body.classList.toggle('nav-open') }, icon('menu')),
    h('span.topbar-title', session.settings.business_name || 'Beauty Parlour'),
    h('a.btn.primary.sm', { href: '#/visit' }, icon('plus', 18), 'New Visit'));
  const scrim = h('div.scrim', { onclick: () => document.body.classList.remove('nav-open') });
  clear(document.getElementById('app'), h('div.layout', navEl, scrim, h('div.content', offlineBar, topbar, main)));
  renderOfflineBar();
}

// ---------- Offline mode ----------

let offlineBar;

function renderOfflineBar() {
  if (!offlineBar) return;
  const waiting = offline.waiting;
  const review = offline.needsReview;
  const reviewBtn = waiting ? h('button.btn.sm.ghost', { type: 'button', onclick: outboxModal }, review ? 'Review' : 'See list') : null;
  let text = null;
  let tone = '';
  if (offline.active) {
    text = `Offline: the salon computer can’t be reached. New visits are saved on this iPad${waiting ? ` (${waiting} waiting to sync)` : ''}.`;
    tone = '.off';
  } else if (review) {
    text = `${review} saved item${review > 1 ? 's' : ''} from offline need${review > 1 ? '' : 's'} your attention before syncing.`;
    tone = '.attn';
  } else if (waiting) {
    text = isSyncing() ? `Syncing ${waiting} saved item${waiting > 1 ? 's' : ''}…` : `${waiting} saved item${waiting > 1 ? 's' : ''} waiting to sync.`;
  }
  offlineBar.hidden = !text;
  offlineBar.className = 'offline-bar' + tone.replace('.', ' ');
  clear(offlineBar, text ? [icon(offline.active ? 'cloud' : review ? 'alert' : 'repeat', 18), h('span.grow', text), reviewBtn] : null);
}

function offlinePage(view) {
  clear(view, h('div.card.offline-card.stack',
    h('h2', 'This page needs the salon computer'),
    h('p.muted', 'The salon computer can’t be reached right now. You can still check customers in and take payment; everything is saved on this iPad and sent across when the computer is back.'),
    h('div.row', h('a.btn.primary.lg', { href: '#/visit' }, icon('sparkles', 20), 'New Visit'),
      offline.waiting ? h('button.btn.ghost.lg', { type: 'button', onclick: outboxModal }, `${offline.waiting} waiting to sync`) : null)));
}

function outboxModal() {
  const body = h('div.stack');
  const draw = () => {
    const items = offline.outbox;
    if (!items.length) return clear(body, h('p.muted', 'Everything has been sent to the salon computer.'));
    clear(body, items.map((it) => {
      const title = it.kind === 'customer'
        ? `New customer: ${it.body.fullName} (${it.body.phone})`
        : `Visit: ${it.summary?.customerName || 'customer'} · ${money(it.body.expectedTotalCents ?? it.summary?.totalCents ?? 0)} · ${it.tempNumber}`;
      const act = (fn) => async () => {
        await fn(it);
        draw();
      };
      const actions = [];
      if (it.status === 'review') {
        if (it.duplicates?.length) {
          for (const d of it.duplicates) actions.push(h('button.btn.sm.primary', { type: 'button', onclick: act((x) => review.samePerson(x, d.id)) }, `Same person as ${d.fullName} (${d.customerCode})`));
          actions.push(h('button.btn.sm.ghost', { type: 'button', onclick: act(review.differentPerson) }, 'Different person'));
        } else if (it.newTotalCents != null) {
          actions.push(h('button.btn.sm.primary', { type: 'button', onclick: act(review.acceptNewTotal) }, `Save with new total ${money(it.newTotalCents)}`));
        } else {
          actions.push(h('button.btn.sm.primary', { type: 'button', onclick: act(review.retry) }, 'Try again'));
        }
        actions.push(h('button.btn.sm.danger', { type: 'button', onclick: async () => {
          const extra = it.kind === 'customer' ? ' Visits saved for this new customer are removed too.' : '';
          if (await confirmDialog({ title: 'Remove this saved item?', message: `It will not be sent to the salon computer.${extra}`, confirmLabel: 'Remove', danger: true })) {
            review.discard(it);
            draw();
          }
        } }, 'Remove'));
      }
      return h('div.outbox-item' + (it.status === 'review' ? '.attn' : ''),
        h('div', h('strong', title)),
        h('div.muted.small', `Saved ${fmtDateTime(it.savedAt)}${it.status === 'review' ? '' : ' · waiting to sync'}`),
        it.error ? h('div.alert.warn', icon('alert', 18), it.duplicates?.length ? `This phone number is already registered on the salon computer. Is ${it.body.fullName} the same person?` : it.error) : null,
        actions.length ? h('div.row.wrap', actions) : null);
    }));
  };
  draw();
  const stop = offline.onChange(draw);
  modal({ title: 'Saved on this iPad', body, wide: true, onClose: stop });
}

offline.onChange(() => {
  renderOfflineBar();
  if (!offline.active && main && main.querySelector('.offline-card')) route();
});
window.addEventListener('online', () => probe());
setInterval(() => {
  if (session.user && !offline.active) refreshSnapshot(session);
}, 5 * 60 * 1000);

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('Offline copy not available:', e.message));
}

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('timeout'), { status: 0 })), ms))]);

function bootOffline() {
  const snap = offline.snapshot;
  session.user = snap.user;
  session.settings = snap.settings || {};
  setTimeZone(session.settings.timezone);
  goOffline();
  shell();
  route();
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
      h('div.auth-art', h('div.auth-art-inner', h('img.brand-mark.lg', { src: '/img/icon.svg', alt: '' }), h('h1.display', businessName || 'Beauty Parlour'), h('p', 'Salon Manager'))),
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
    status = await withTimeout(api.get('/auth/status'), 6000);
  } catch (e) {
    if (e.status === 0 && offline.snapshot?.user) return bootOffline();
    clear(document.getElementById('app'), h('div.auth', h('div.auth-panel', h('div.auth-card', h('h2', 'Cannot connect'), h('p', e.message), h('button.btn.primary', { onclick: boot }, 'Try again')))));
    return;
  }
  document.title = status.businessName || 'Salon Manager';
  if (!status.user) return authScreen({ setup: status.setupRequired, businessName: status.businessName });
  session.user = status.user;
  await refreshSettings();
  shell();
  route();
  refreshSnapshot(session).then(() => sync());
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

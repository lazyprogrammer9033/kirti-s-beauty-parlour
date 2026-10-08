// Offline mode: when the salon computer can't be reached, the iPad keeps
// checking customers in. New customers and visits wait in an outbox on this
// device and are sent to the salon computer when it answers again. Final
// customer IDs and receipt numbers are always given by the salon computer.
import { api, ApiError } from './api.js';
import { calculateInvoice } from './money.js';

const KEYS = { snapshot: 'salon.offline.snapshot', outbox: 'salon.offline.outbox', device: 'salon.offline.device', ids: 'salon.offline.ids', count: 'salon.offline.count' };

function read(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

const randomId = () => (crypto.randomUUID ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join(''));

function deviceCode() {
  let d = read(KEYS.device, null);
  if (!d) {
    d = randomId().replace(/-/g, '').slice(0, 4).toUpperCase();
    write(KEYS.device, d);
  }
  return d;
}

// Temporary number shown on an offline receipt, e.g. OFF-7K2Q-0003.
function nextTempNumber() {
  const n = read(KEYS.count, 0) + 1;
  write(KEYS.count, n);
  return `OFF-${deviceCode()}-${String(n).padStart(4, '0')}`;
}

const listeners = new Set();
let probeTimer = null;
let syncing = false;

export const offline = {
  active: false,
  get outbox() {
    return read(KEYS.outbox, []);
  },
  get snapshot() {
    return read(KEYS.snapshot, null);
  },
  get waiting() {
    return this.outbox.length;
  },
  get needsReview() {
    return this.outbox.filter((i) => i.status === 'review').length;
  },
  onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

function notify() {
  for (const fn of listeners) {
    try {
      fn();
    } catch (e) {
      console.error(e);
    }
  }
}

function saveOutbox(list) {
  if (!write(KEYS.outbox, list)) throw new Error('This iPad has no room left to save offline visits.');
  notify();
}

// ---------- Going offline and back ----------

export function goOffline() {
  if (!offline.active) {
    offline.active = true;
    notify();
  }
  if (!probeTimer) probeTimer = setInterval(probe, 5000);
}

async function reachable() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    const r = await fetch('/api/health', { cache: 'no-store', signal: ctrl.signal });
    return r.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function probe() {
  if (!(await reachable())) return false;
  clearInterval(probeTimer);
  probeTimer = null;
  if (offline.active) {
    offline.active = false;
    notify();
  }
  await sync();
  return true;
}

// Online calls get a time limit so a sleeping salon computer is noticed quickly.
async function online(fn) {
  if (offline.active) throw new ApiError(0, {});
  let timer;
  const limit = new Promise((_, reject) => (timer = setTimeout(() => reject(new ApiError(0, {})), 8000)));
  try {
    return await Promise.race([fn(), limit]);
  } finally {
    clearTimeout(timer);
  }
}

// Runs the online version, or the offline one when the salon computer can't be reached.
async function either(onlineFn, offlineFn) {
  if (!offline.active) {
    try {
      return await online(onlineFn);
    } catch (e) {
      if (e.status !== 0) throw e;
      goOffline();
    }
  }
  if (!offline.snapshot) throw new Error('The salon computer can’t be reached, and this iPad has no saved copy yet. Open the app once while connected.');
  return offlineFn();
}

// Saves what offline check-in needs. Without a session, keeps the saved user and settings.
export async function refreshSnapshot(session) {
  try {
    const snap = await online(() => api.get('/offline/snapshot'));
    const prev = offline.snapshot || {};
    write(KEYS.snapshot, { ...snap, user: session?.user || prev.user, settings: session?.settings || prev.settings });
  } catch {
    /* keep the last copy */
  }
}

// ---------- Local data (snapshot + outbox) ----------

function pendingCustomers() {
  return offline.outbox.filter((i) => i.kind === 'customer').map((i) => ({
    id: i.tmpId, customerCode: 'New', fullName: i.body.fullName, phone: i.body.phone, phoneDigits: digitsOf(i.body.phone), email: i.body.email || null,
    totalVisits: 0, lastVisitAt: null, lastServices: [], balanceCents: 0, notes: i.body.notes ? [{ note: i.body.notes }] : [], pending: true,
  }));
}

const digitsOf = (p) => {
  const d = String(p || '').replace(/\D/g, '');
  return d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
};

function allCustomers() {
  return [...(offline.snapshot?.customers || []), ...pendingCustomers()];
}

function searchLocal(q) {
  const s = q.trim().toLowerCase();
  const digits = s.replace(/\D/g, '');
  const words = s.split(/\s+/).filter(Boolean);
  return allCustomers().filter((c) => {
    if (/^cus-/i.test(s)) return c.customerCode.toLowerCase().startsWith(s);
    if (digits.length >= 3 && digits.length === s.replace(/[\s()+-]/g, '').length) return c.phoneDigits.includes(digits);
    return words.every((w) => c.fullName.toLowerCase().includes(w) || (c.email || '').toLowerCase().includes(w));
  }).slice(0, 20);
}

function profileLocal(id) {
  const c = allCustomers().find((x) => String(x.id) === String(id));
  if (!c) throw new Error('Customer not found on this iPad');
  return { ...c, stats: { totalVisits: c.totalVisits, lastVisitAt: c.lastVisitAt, lastServices: c.lastServices, balanceCents: c.balanceCents } };
}

function quoteLocal(body) {
  const snap = offline.snapshot;
  const services = snap.catalogue.flatMap((c) => c.services.map((s) => ({ ...s, category: c.name })));
  const lines = body.items.map((it) => {
    if (it.type === 'custom') return { itemType: 'custom', description: it.description, unitPriceCents: it.priceCents, quantity: it.quantity, taxable: it.taxable === false ? 0 : 1 };
    const s = services.find((x) => x.id === it.serviceId);
    if (!s) throw new Error('Service not found');
    return { itemType: 'service', serviceId: s.id, description: s.name, unitPriceCents: s.priceCents, quantity: it.quantity, taxable: s.taxable };
  });
  const d = body.discount;
  const discount = !d ? null : d.type === 'percent' ? { type: 'percent', value: Math.round(Number(d.percent) * 100) } : { type: 'amount', value: Number(d.amountCents) };
  if (discount && (!Number.isInteger(discount.value) || discount.value < 0)) throw new Error('Please enter a valid discount amount');
  const calc = calculateInvoice({ items: lines, discount: discount && discount.value ? discount : null, taxRateBp: snap.tax.rateBp, pricesIncludeTax: snap.tax.pricesIncludeTax });
  return { ...calc, taxName: snap.tax.name, taxRateBp: snap.tax.rateBp, pricesIncludeTax: snap.tax.pricesIncludeTax };
}

// ---------- What the check-in screen uses ----------

export const visitData = {
  catalogue: () => either(() => api.get('/services'), () => offline.snapshot.catalogue),
  staff: () => either(() => api.get('/staff'), () => offline.snapshot.staff),
  search: (q) => either(() => api.get('/customers/search?q=' + encodeURIComponent(q)), () => searchLocal(q)),
  customer: (id) => (String(id).startsWith('tmp-') ? Promise.resolve(profileLocal(id)) : either(() => api.get('/customers/' + id), () => profileLocal(id))),
  quote: (body) => either(() => api.post('/visits/quote', body), () => quoteLocal(body)),

  // The same clientRef goes with the online attempt and any offline retry, so a
  // reply lost on the way back can never create the customer twice.
  async createCustomer(body) {
    const clientRef = randomId();
    const sent = async () => {
      const r = await api.post('/customers', { ...body, clientRef });
      refreshSnapshot();
      return r;
    };
    return either(sent, () => {
      const digits = digitsOf(body.phone);
      if (!String(body.fullName || '').trim()) throw new Error('Full name is required');
      if (digits.length < 7) throw new Error('Please enter a valid phone number');
      const dupes = allCustomers().filter((c) => c.phoneDigits === digits);
      if (dupes.length && !body.confirmDuplicate) throw new ApiError(409, { error: 'A customer with this phone number already exists', duplicates: dupes });
      const tmpId = 'tmp-' + clientRef;
      saveOutbox([...offline.outbox, { id: clientRef, kind: 'customer', tmpId, body: { ...body, confirmDuplicate: !!body.confirmDuplicate }, savedAt: new Date().toISOString(), status: 'pending' }]);
      return { id: tmpId, customerCode: 'New', offline: true };
    });
  },

  async createVisit(body, summary) {
    const clientRef = randomId();
    const sendNow = !String(body.customerId).startsWith('tmp-');
    const queue = () => {
      const q = quoteLocal(body);
      const paid = (body.payments || []).reduce((s, p) => s + p.amountCents, 0);
      const tempNumber = nextTempNumber();
      saveOutbox([...offline.outbox, {
        id: clientRef, kind: 'visit', tempNumber, savedAt: new Date().toISOString(), status: 'pending', summary,
        body: { ...body, clientRef, offlineAt: new Date().toISOString(), expectedTotalCents: q.totalCents, allowBalance: true },
      }]);
      return { offline: true, tempNumber, totalCents: q.totalCents, balanceCents: Math.max(q.totalCents - paid, 0) };
    };
    if (!sendNow) {
      // Its customer is still waiting to sync, so the visit waits too.
      const r = queue();
      if (!offline.active) sync();
      return r;
    }
    return either(async () => {
      const r = await api.post('/visits', { ...body, clientRef });
      refreshSnapshot();
      return r;
    }, queue);
  },
};

// ---------- Sync ----------

function update(id, changes) {
  saveOutbox(offline.outbox.map((i) => (i.id === id ? { ...i, ...changes } : i)));
}

function remove(id) {
  saveOutbox(offline.outbox.filter((i) => i.id !== id));
}

export async function sync() {
  if (syncing || offline.active || !offline.outbox.length) return;
  syncing = true;
  notify();
  let sent = 0;
  try {
    const ids = read(KEYS.ids, {});
    for (const item of offline.outbox) {
      if (item.status === 'review') continue;
      try {
        if (item.kind === 'customer') {
          const r = await online(() => api.post('/customers', { ...item.body, clientRef: item.id }));
          ids[item.tmpId] = r.id;
          write(KEYS.ids, ids);
          remove(item.id);
        } else {
          let customerId = item.body.customerId;
          if (String(customerId).startsWith('tmp-')) {
            if (ids[customerId]) customerId = ids[customerId];
            else if (offline.outbox.some((i) => i.tmpId === customerId)) continue; // its new customer still needs a decision
            else {
              update(item.id, { status: 'review', error: 'The new customer for this visit was removed. Remove this visit, or enter it again.' });
              continue;
            }
          }
          await online(() => api.post('/visits', { ...item.body, customerId }));
          remove(item.id);
        }
        sent += 1;
      } catch (e) {
        if (e.status === 0) {
          goOffline();
          break;
        }
        if (e.status === 401) break; // signed out: sync again after signing in
        update(item.id, { status: 'review', error: e.message, duplicates: e.data?.duplicates || null, newTotalCents: e.data?.totalCents ?? null });
      }
    }
  } finally {
    syncing = false;
    notify();
  }
  if (sent) await refreshSnapshot();
  return sent;
}

export const isSyncing = () => syncing;

// Choices offered for items that need a person to decide.
export const review = {
  samePerson(item, customerId) {
    const ids = read(KEYS.ids, {});
    ids[item.tmpId] = customerId;
    write(KEYS.ids, ids);
    remove(item.id);
    return sync();
  },
  differentPerson(item) {
    update(item.id, { status: 'pending', error: null, duplicates: null, body: { ...item.body, confirmDuplicate: true } });
    return sync();
  },
  retry(item) {
    update(item.id, { status: 'pending', error: null });
    return sync();
  },
  // Records the visit at today's prices; any payment above the new total is left off.
  acceptNewTotal(item) {
    const total = item.newTotalCents;
    let left = total;
    const payments = (item.body.payments || []).map((p) => {
      const amountCents = Math.min(p.amountCents, left);
      left -= amountCents;
      return { ...p, amountCents };
    }).filter((p) => p.amountCents > 0);
    const { expectedTotalCents, ...body } = item.body; // eslint-disable-line no-unused-vars
    update(item.id, { status: 'pending', error: null, newTotalCents: null, body: { ...body, payments } });
    return sync();
  },
  discard(item) {
    const list = offline.outbox.filter((i) => i.id !== item.id && !(item.kind === 'customer' && i.body.customerId === item.tmpId));
    saveOutbox(list);
  },
};

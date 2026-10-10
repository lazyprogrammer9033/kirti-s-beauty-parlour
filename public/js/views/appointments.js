import { h, clear, icon, toast, modal, field, avatar, debounce, todayYmd, fmtTime, fmtYmd, confirmDialog, spinner, emptyState, money } from '../ui.js';
import { api } from '../api.js';
import { session, navigate } from '../app.js';
import { pageHeader, customerFormModal } from './shared.js';

const STATUS_LABELS = { booked: 'Booked', confirmed: 'Confirmed', completed: 'Completed', cancelled: 'Cancelled', no_show: 'No-show' };
const STATUS_CLASS = { booked: 'booked', confirmed: 'active', completed: 'completed', cancelled: 'void', no_show: 'void' };

export const apptBadge = (status) => h('span.badge.' + STATUS_CLASS[status], STATUS_LABELS[status] || status);

const addDays = (ymd, n) => {
  const d = new Date(ymd + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const weekStart = (ymd) => addDays(ymd, -((new Date(ymd + 'T12:00:00Z').getUTCDay() + 6) % 7));
const dayName = (ymd, style = 'short') => new Date(ymd + 'T12:00:00Z').toLocaleDateString('en-CA', { timeZone: 'UTC', weekday: style });
const dayNum = (ymd) => Number(ymd.slice(8));

function syncNote(a) {
  if (session.settings.calendar_connected !== '1' && !a.syncStatus) return null;
  if (a.syncStatus === 'failed') return h('span.appt-sync.warn', { title: a.syncError || '' }, icon('alert', 14), 'Not in Google Calendar yet');
  if (a.syncStatus === 'pending') return h('span.appt-sync', icon('repeat', 14), 'Adding to Google Calendar');
  if (a.inCalendar) return h('span.appt-sync.ok', icon('calendar', 14), 'In Google Calendar');
  return null;
}

export async function render(view, { params, query }) {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(params[0] || '') ? params[0] : todayYmd();
  const start = weekStart(day);
  const end = addDays(start, 6);
  const go = (ymd) => navigate('appointments/' + ymd);

  const list = h('div.stack', spinner());
  const strip = h('div.week-strip');
  clear(view,
    pageHeader('Appointments', session.settings.calendar_connected === '1' ? 'Bookings are copied to your Google Calendar.' : 'Book, reschedule and cancel.',
      h('div.row',
        h('button.btn.ghost', { type: 'button', onclick: () => blockModal(day).then((b) => b && go(b.fromDate)) }, icon('clock', 18), 'Block time'),
        h('button.btn.primary', { type: 'button', onclick: () => bookingModal({ date: day }).then((a) => a && go(a.date)) }, icon('plus', 18), 'Book appointment'))),
    h('div.card.stack',
      h('div.week-nav',
        h('button.icon-btn', { type: 'button', 'aria-label': 'Previous week', onclick: () => go(addDays(day, -7)) }, icon('chevronLeft')),
        h('h3.grow.center', fmtYmd(day)),
        day === todayYmd() ? null : h('button.btn.ghost.sm', { type: 'button', onclick: () => go(todayYmd()) }, 'Today'),
        h('button.icon-btn', { type: 'button', 'aria-label': 'Next week', onclick: () => go(addDays(day, 7)) }, icon('chevronRight'))),
      strip),
    list);

  const [all, blocks] = await Promise.all([api.get(`/appointments?from=${start}&to=${end}`), api.get(`/appointment-blocks?from=${start}&to=${end}`)]);
  const active = all.filter((a) => a.status !== 'cancelled');
  const blockedOn = (d) => blocks.filter((b) => b.fromDate <= d && b.toDate >= d);
  clear(strip, Array.from({ length: 7 }, (_, i) => {
    const d = addDays(start, i);
    const n = active.filter((a) => a.date === d).length;
    return h('button.week-day' + (d === day ? '.on' : '') + (d === todayYmd() ? '.today' : ''), { type: 'button', onclick: () => go(d) },
      h('span.wd-name', dayName(d)), h('span.wd-num', String(dayNum(d))), h('span.wd-count', n ? `${n}` : blockedOn(d).some((b) => b.allDay) ? 'Closed' : ''));
  }));

  const rows = all.filter((a) => a.date === day);
  const blockCards = blockedOn(day).map((b) => h('button.appt-card.block-card', { type: 'button', onclick: () => removeBlock(b, () => render(view, { params, query })) },
    h('div.appt-time', icon('clock', 20)),
    h('div.grow',
      h('div.appt-name', b.allDay ? 'Closed all day' : `Blocked ${fmtTime(b.startAt)} to ${fmtTime(b.endAt)}`),
      h('div.muted.small', [b.reason, b.fromDate !== b.toDate ? `${fmtYmd(b.fromDate)} to ${fmtYmd(b.toDate)}` : null, 'Customers can’t book online at this time'].filter(Boolean).join(' · '))),
    icon('x', 20)));
  if (!rows.length) {
    clear(list, blockCards, h('div.card', emptyState('calendar', 'No appointments', `Nothing booked for ${dayName(day, 'long')}.`,
      h('button.btn.primary', { type: 'button', onclick: () => bookingModal({ date: day }).then((a) => a && go(a.date)) }, icon('plus', 18), 'Book appointment'))));
  } else {
    clear(list, blockCards, rows.map((a) => h('button.appt-card' + (['cancelled', 'no_show'].includes(a.status) ? '.dim' : ''), { type: 'button', onclick: () => detailsModal(a, () => render(view, { params, query })) },
      h('div.appt-time', h('strong', fmtTime(a.startAt)), h('span.muted.small', fmtTime(a.endAt))),
      h('div.grow',
        h('div.appt-name', a.customerName, apptBadge(a.status)),
        h('div.muted.small', [a.services.map((s) => s.name).join(', ') || 'No services chosen', `${a.durationMinutes || ''} min`].filter(Boolean).join(' · ')),
        a.notes ? h('div.small', a.notes) : null,
        syncNote(a)),
      icon('chevronRight', 20))));
  }
  if (query.get('book')) bookingModal({ date: day, customerId: Number(query.get('book')) }).then((a) => a && go(a.date));
}

// Close a break, a day off or a holiday so customers can't book it online.
// Bookings made in the app can still go there (after a warning).
function blockModal(day) {
  return new Promise((resolve) => {
    let saved = null;
    const fromDate = h('input.input', { type: 'date', value: day });
    const toDate = h('input.input', { type: 'date', value: day });
    const allDay = h('input', { type: 'checkbox', checked: true });
    const fromTime = h('input.input', { type: 'time', value: '13:00', step: 900 });
    const toTime = h('input.input', { type: 'time', value: '14:00', step: 900 });
    const reason = h('input.input', { maxlength: 120, placeholder: 'Lunch, holiday, day off…' });
    const times = h('div.grid-2', field('From', fromTime), field('To', toTime));
    const toField = field('Until', toDate);
    const err = h('p.error-text');
    const sync = () => {
      times.hidden = allDay.checked;
      toField.hidden = !allDay.checked;
    };
    allDay.addEventListener('change', sync);
    fromDate.addEventListener('change', () => { if (toDate.value < fromDate.value) toDate.value = fromDate.value; });
    sync();
    const btn = h('button.btn.primary', { type: 'button', onclick: async () => {
      btn.disabled = true;
      err.textContent = '';
      try {
        saved = await api.post('/appointment-blocks', allDay.checked
          ? { fromDate: fromDate.value, toDate: toDate.value || fromDate.value, allDay: true, reason: reason.value }
          : { fromDate: fromDate.value, fromTime: fromTime.value, toTime: toTime.value, reason: reason.value });
        toast(saved.allDay ? 'Closed for online booking' : 'Time blocked');
        m.close();
      } catch (e) {
        err.textContent = e.message;
        btn.disabled = false;
      }
    } }, 'Block');
    const m = modal({
      title: 'Block time',
      body: h('div.stack',
        h('p.muted.small', 'Customers won’t see these times on the online booking page. Bookings already made are not changed.'),
        h('div.grid-2', field('Date', fromDate), toField),
        h('label.check', allDay, ' All day'),
        times,
        field('Reason (only you see this)', reason),
        err),
      actions: [h('button.btn.ghost', { type: 'button', onclick: () => m.close() }, 'Cancel'), btn],
      onClose: () => resolve(saved),
    });
  });
}

async function removeBlock(b, onChange) {
  const what = b.allDay ? (b.fromDate === b.toDate ? fmtYmd(b.fromDate) : `${fmtYmd(b.fromDate)} to ${fmtYmd(b.toDate)}`) : `${fmtYmd(b.fromDate)}, ${fmtTime(b.startAt)} to ${fmtTime(b.endAt)}`;
  if (!(await confirmDialog({ title: 'Open this time again?', message: `${what}${b.reason ? ' (' + b.reason + ')' : ''} will be available for online booking again.`, confirmLabel: 'Remove block' }))) return;
  try {
    await api.del('/appointment-blocks/' + b.id);
    toast('Block removed');
    onChange();
  } catch (e) {
    toast(e.message, 'error');
  }
}

// Details + actions for one booking.
export function detailsModal(a, onChange) {
  const open = ['booked', 'confirmed'].includes(a.status);
  const canEmail = !!a.customerEmail && session.settings.email_configured === '1';
  const done = async (fn) => {
    try {
      const r = await fn();
      m.close();
      if (r?.emailError) toast(r.emailError, 'error');
      onChange && onChange(r);
    } catch (e) {
      toast(e.message, 'error');
    }
  };
  const setStatus = (status, notify) => done(async () => {
    const r = await api.post(`/appointments/${a.id}/status`, { status, notify });
    toast(`Marked ${STATUS_LABELS[status].toLowerCase()}${r.emailed ? ' and emailed the customer' : ''}`);
    return r;
  });
  const cancel = async () => {
    const notify = h('input', { type: 'checkbox', checked: canEmail });
    const ok = await new Promise((resolve) => {
      const cm = modal({
        title: 'Cancel this appointment?',
        body: h('div.stack', h('p', `${a.customerName}, ${fmtYmd(a.date)} at ${fmtTime(a.startAt)}.`),
          canEmail ? h('label.check', notify, ` Email ${a.customerEmail} to let them know`) : null),
        actions: [h('button.btn.ghost', { type: 'button', onclick: () => { cm.close(); resolve(false); } }, 'Keep it'),
          h('button.btn.danger', { type: 'button', onclick: () => { cm.close(); resolve(true); } }, 'Cancel appointment')],
      });
    });
    if (ok) setStatus('cancelled', notify.checked);
  };
  const m = modal({
    title: 'Appointment',
    body: h('div.stack',
      h('div.row', avatar(a.customerName), h('div.grow', h('strong', a.customerName), h('div.muted.small', `${a.customerPhone}${a.customerEmail ? ' · ' + a.customerEmail : ''}`)),
        h('a.btn.ghost.sm', { href: '#/customer/' + a.customerId, onclick: () => m.close() }, 'Profile')),
      h('dl.details',
        h('dt', 'When'), h('dd', `${dayName(a.date, 'long')}, ${fmtYmd(a.date)}, ${fmtTime(a.startAt)} to ${fmtTime(a.endAt)}`),
        h('dt', 'Services'), h('dd', a.services.length ? a.services.map((s) => `${s.name} (${money(s.priceCents)})`).join(', ') : '—'),
        h('dt', 'Status'), h('dd', apptBadge(a.status)),
        a.staffName ? [h('dt', 'With'), h('dd', a.staffName)] : null,
        a.notes ? [h('dt', 'Notes'), h('dd', a.notes)] : null,
        a.confirmationSentAt ? [h('dt', 'Confirmation'), h('dd', 'Emailed to the customer')] : null),
      syncNote(a),
      a.syncStatus === 'failed' && a.syncError ? h('p.small.muted', a.syncError) : null),
    actions: [
      open ? h('button.btn.danger', { type: 'button', onclick: cancel }, 'Cancel') : null,
      open ? h('button.btn.ghost', { type: 'button', onclick: () => setStatus('no_show') }, 'No-show') : null,
      a.status === 'booked' ? h('button.btn.ghost', { type: 'button', onclick: () => setStatus('confirmed') }, 'Confirmed') : null,
      open ? h('button.btn.soft', { type: 'button', onclick: () => { m.close(); bookingModal({ appointment: a }).then((r) => r && onChange && onChange(r)); } }, icon('edit', 18), 'Change') : null,
      !open && a.status !== 'completed' ? h('button.btn.ghost', { type: 'button', onclick: () => setStatus('booked') }, 'Restore booking') : null,
      a.visitId ? h('a.btn.ghost', { href: '#/customer/' + a.customerId, onclick: () => m.close() }, 'See visit') : null,
      open ? h('a.btn.primary', { href: `#/visit?appointment=${a.id}`, onclick: () => m.close() }, icon('sparkles', 18), 'Start visit') : null,
    ],
  });
}

// Pick a customer by phone or name, or add a new one.
function customerPicker(onPick) {
  const input = h('input.input', { type: 'search', placeholder: 'Phone number or name', autocomplete: 'off', 'aria-label': 'Find customer' });
  const results = h('div.lookup-results');
  let seq = 0;
  const search = debounce(async () => {
    const q = input.value.trim();
    const mine = ++seq;
    if (q.length < 2) return clear(results);
    const rows = await api.get('/customers/search?q=' + encodeURIComponent(q)).catch(() => []);
    if (mine !== seq) return;
    clear(results,
      rows.slice(0, 6).map((c) => h('button.lookup-row', { type: 'button', onclick: () => onPick(c) },
        avatar(c.fullName), h('div.grow', h('strong', c.fullName), h('div.muted.small', `${c.phone} · ${c.customerCode}`)), h('span.btn.primary.sm', 'Select'))),
      h('button.btn.ghost.block', { type: 'button', onclick: async () => {
        const digits = q.replace(/\D/g, '');
        const made = await customerFormModal(digits.length >= 7 ? { phone: q } : {});
        if (made) onPick(await api.get('/customers/' + made.id));
      } }, icon('userPlus', 18), 'New customer'));
  }, 160);
  input.addEventListener('input', search);
  return h('div.stack', input, results);
}

const TIMES = Array.from({ length: (22 - 7) * 4 }, (_, i) => {
  const m = 7 * 60 + i * 15;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
});
const timeLabel = (hm) => {
  const [hh, mm] = hm.split(':').map(Number);
  return `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`;
};
const DURATIONS = [10, 15, 20, 30, 45, 60, 75, 90, 120, 150, 180, 240];

// Book a new appointment, or change one. Resolves with the saved appointment.
export function bookingModal({ appointment, date, customerId } = {}) {
  return new Promise((resolve) => {
    const a = appointment;
    const state = {
      customer: a ? { id: a.customerId, fullName: a.customerName, phone: a.customerPhone, email: a.customerEmail } : null,
      serviceIds: new Set(a ? a.services.map((s) => s.id) : []),
      durationTouched: !!a,
      category: null,
    };
    let catalogue = [];
    const customerBox = h('div');
    const servicesBox = h('div.stack');
    const dateEl = h('input.input', { type: 'date', value: a ? a.date : date || todayYmd(), required: true });
    const nowSlot = () => {
      const t = new Date().toLocaleTimeString('en-GB', { timeZone: session.settings.timezone || 'America/Toronto', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
      return TIMES.find((x) => x >= t) || '10:00';
    };
    const initialTime = a ? a.time : dateEl.value === todayYmd() ? nowSlot() : '10:00';
    const timeEl = h('select.input', TIMES.concat(TIMES.includes(initialTime) ? [] : [initialTime]).sort().map((t) => h('option', { value: t, selected: t === initialTime }, timeLabel(t))));
    const durEl = h('select.input', { onchange: () => (state.durationTouched = true) });
    const notesEl = h('textarea.input', { rows: 2, value: a?.notes || '', placeholder: 'Optional' });
    const notify = h('input', { type: 'checkbox' });
    const notifyRow = h('label.check');
    const err = h('p.form-error', { role: 'alert' });
    const save = h('button.btn.primary.lg', { type: 'button' }, a ? 'Save changes' : 'Book');

    const services = () => catalogue.flatMap((c) => c.services);
    function setDuration(mins) {
      const opts = [...new Set(DURATIONS.concat(mins ? [mins] : []))].sort((x, y) => x - y);
      clear(durEl, opts.map((d) => h('option', { value: d, selected: d === mins }, d < 60 ? `${d} min` : `${Math.floor(d / 60)} h${d % 60 ? ' ' + (d % 60) + ' min' : ''}`)));
    }
    function autoDuration() {
      if (state.durationTouched) return;
      const sum = services().filter((s) => state.serviceIds.has(s.id)).reduce((t, s) => t + (s.durationMinutes || 0), 0);
      setDuration(sum || Number(session.settings.appt_default_minutes || 30));
    }
    function renderNotify() {
      const c = state.customer;
      const can = c?.email && session.settings.email_configured === '1';
      notify.checked = !!can && (a ? false : session.settings.appt_confirm_email !== '0');
      clear(notifyRow, can ? [notify, a ? ` Email ${c.email} if the time changes` : ` Email a confirmation to ${c.email}`] : null);
    }
    function renderCustomer() {
      if (state.customer) {
        const c = state.customer;
        clear(customerBox, h('div.row', avatar(c.fullName), h('div.grow', h('strong', c.fullName), h('div.muted.small', c.phone)),
          a ? null : h('button.btn.ghost.sm', { type: 'button', onclick: () => { state.customer = null; renderCustomer(); } }, 'Change')));
      } else {
        clear(customerBox, customerPicker(async (c) => {
          state.customer = await api.get('/customers/' + c.id).catch(() => c);
          renderCustomer();
        }));
      }
      renderNotify();
    }
    function renderServices() {
      if (!catalogue.length) return clear(servicesBox, h('p.muted.small', 'No services yet. You can still book; add services on the Services screen.'));
      const cat = catalogue.find((c) => c.id === state.category) || catalogue[0];
      clear(servicesBox,
        catalogue.length > 1 ? h('div.chips.scroll', catalogue.map((c) => h('button.chip' + (c.id === cat.id ? '.on' : ''), { type: 'button', onclick: () => { state.category = c.id; renderServices(); } }, c.name))) : null,
        h('div.chips', cat.services.map((s) => h('button.chip' + (state.serviceIds.has(s.id) ? '.on' : ''), { type: 'button', onclick: () => {
          if (state.serviceIds.has(s.id)) state.serviceIds.delete(s.id);
          else state.serviceIds.add(s.id);
          autoDuration();
          renderServices();
        } }, state.serviceIds.has(s.id) ? icon('check', 16) : null, s.name, s.durationMinutes ? h('span.muted.small', ` ${s.durationMinutes}m`) : null))),
        state.serviceIds.size ? h('p.small.muted', 'Chosen: ' + services().filter((s) => state.serviceIds.has(s.id)).map((s) => s.name).join(', ')) : null);
    }

    async function submit(confirmOverlap = false) {
      err.textContent = '';
      if (!state.customer) return (err.textContent = 'Please choose the customer.');
      save.disabled = true;
      const body = { customerId: state.customer.id, date: dateEl.value, time: timeEl.value, durationMinutes: Number(durEl.value), serviceIds: [...state.serviceIds], notes: notesEl.value, notify: notify.checked, confirmOverlap };
      try {
        const r = a ? await api.put('/appointments/' + a.id, body) : await api.post('/appointments', body);
        saved = true;
        m.close();
        const bits = [a ? 'Appointment updated' : 'Appointment booked'];
        if (r.syncStatus === 'synced') bits.push('added to Google Calendar');
        if (r.emailed) bits.push('customer emailed');
        toast(bits.join(', '));
        if (r.syncStatus === 'failed') toast('Saved, but Google Calendar could not be reached. It will try again.', 'error');
        if (r.emailError) toast(r.emailError, 'error');
        resolve(r);
      } catch (e) {
        save.disabled = false;
        if (e.status === 409 && e.data.overlaps) {
          const names = e.data.overlaps.map((o) => `${o.customerName} (${fmtTime(o.startAt)}–${fmtTime(o.endAt)})`).join(', ');
          if (await confirmDialog({ title: 'This time overlaps', message: `Already taken: ${names}. Book anyway?`, confirmLabel: 'Book anyway' })) submit(true);
          return;
        }
        err.textContent = e.message;
      }
    }
    save.addEventListener('click', () => submit(false));

    let saved = false;
    const m = modal({
      title: a ? 'Change appointment' : 'Book appointment',
      wide: true,
      body: h('div.stack',
        h('section.stack', h('h3', 'Customer'), customerBox),
        h('section.stack', h('h3', 'Services'), servicesBox),
        h('div.grid-3', field('Date', dateEl), field('Time', timeEl), field('Length', durEl)),
        field('Notes', notesEl),
        notifyRow,
        err),
      actions: [h('button.btn.ghost', { type: 'button', onclick: () => m.close() }, 'Close'), save],
      onClose: () => !saved && resolve(null),
    });

    setDuration(a ? a.durationMinutes : Number(session.settings.appt_default_minutes || 30));
    renderCustomer();
    clear(servicesBox, spinner());
    api.get('/services').then((c) => {
      catalogue = c.filter((x) => x.services.length);
      renderServices();
      if (!a) autoDuration();
    }).catch(() => clear(servicesBox, h('p.muted', 'Could not load services.')));
    if (customerId && !a) api.get('/customers/' + customerId).then((c) => { state.customer = c; renderCustomer(); }).catch(() => {});
  });
}

import { h, clear, icon, money, fmtDate, fmtDateShort, fmtTime, methodLabel, avatar, modal, field, toast, emptyState } from '../ui.js';
import { api } from '../api.js';
import { customerFormModal, statusBadge } from './shared.js';

function stat(label, value) {
  return h('div.mini-stat', h('span.mini-label', label), h('span.mini-value', value));
}

export async function render(view, { params }) {
  const id = Number(params[0]);
  const c = await api.get('/customers/' + id);
  const s = c.stats;

  const addNote = () => {
    const ta = h('textarea.input', { rows: 4, placeholder: 'e.g. Prefers shorter haircut. Sensitive skin.' });
    const m = modal({
      title: 'Add customer note',
      body: field('General note (shown on every visit)', ta),
      actions: [
        h('button.btn.ghost', { type: 'button', onclick: () => m.close() }, 'Cancel'),
        h('button.btn.primary', { type: 'button', onclick: async () => {
          if (!ta.value.trim()) return;
          try {
            await api.post(`/customers/${id}/notes`, { note: ta.value });
            m.close();
            toast('Note added');
            render(view, { params });
          } catch (e) {
            toast(e.message, 'error');
          }
        } }, 'Save note'),
      ],
    });
  };

  const header = h('div.profile-head.card',
    h('div.profile-id',
      avatar(c.fullName, 'lg'),
      h('div',
        h('h1.display', c.fullName, ' ', c.status === 'inactive' ? statusBadge('inactive') : null),
        h('div.profile-meta',
          h('span', icon('phone', 16), c.phone),
          c.email ? h('span', icon('mail', 16), c.email) : null,
          h('span.code', c.customerCode)))),
    h('div.profile-actions',
      h('button.btn.ghost', { type: 'button', onclick: async () => { if (await customerFormModal({ customer: c })) render(view, { params }); } }, icon('edit', 18), 'Edit'),
      h('a.btn.soft', { href: '#/visit?customer=' + id }, icon('sparkles', 18), 'New Visit'),
      h('a.btn.primary', { href: '#/visit?customer=' + id + '&step=bill' }, icon('receipt', 18), 'Create Bill')));

  const summary = h('div.card',
    h('div.card-head', h('h3', 'Summary')),
    h('div.mini-stats',
      stat('Total visits', String(s.totalVisits)),
      stat('Total spent', money(s.totalSpentCents)),
      stat('Average visit', money(s.averageCents)),
      stat('First visit', s.firstVisitAt ? fmtDateShort(s.firstVisitAt) : c.firstVisitDate || '—'),
      stat('Last visit', s.lastVisitAt ? fmtDateShort(s.lastVisitAt) : '—'),
      stat('Last payment', s.lastPayment ? `${money(s.lastPayment.amountCents)} · ${methodLabel(s.lastPayment.method)}` : '—')),
    s.balanceCents > 0 ? h('div.alert.warn', icon('alert', 18), `Outstanding balance: ${money(s.balanceCents)}. Open the unpaid visit below to record a payment.`) : null,
    h('div.fav',
      h('span.muted.small', 'Favourite services'),
      h('div.chips', s.favouriteServices.length ? s.favouriteServices.map((f) => h('span.chip.static', `${f.name} · ${f.count}×`)) : h('span.muted', 'None yet'))),
    s.lastServices.length ? h('div.fav', h('span.muted.small', 'Last service'), h('div', s.lastServices.join(', '))) : null);

  const details = h('div.card',
    h('div.card-head', h('h3', 'Details')),
    h('dl.details',
      [['Date of birth', c.dateOfBirth], ['Address', c.address], ['Preferred services', c.preferredServices], ['Heard about us', c.referralSource], ['Customer since', c.firstVisitDate]]
        .map(([k, v]) => [h('dt', k), h('dd', v || '—')])));

  const notes = h('div.card',
    h('div.card-head', h('h3', 'General notes'), h('button.btn.soft.sm', { type: 'button', onclick: addNote }, icon('plus', 16), 'Add note')),
    c.notes.length
      ? h('div.notes', c.notes.map((n) => h('div.note', h('p', n.note), h('span.muted.small', `${n.author || 'Staff'} · ${fmtDateShort(n.createdAt)}`))))
      : h('p.muted', 'No notes yet. Add preferences, allergies or anything staff should know.'));

  const history = h('div.card',
    h('div.card-head', h('h3', 'Visit history'), h('span.muted.small', `${c.visits.length} record${c.visits.length === 1 ? '' : 's'}`)),
    c.visits.length
      ? h('div.timeline', c.visits.map((v) =>
          h('a.visit' + (v.status === 'void' ? '.void' : ''), { href: '#/invoice/' + v.invoiceId },
            h('div.visit-date', h('strong', fmtDate(v.visitAt)), h('span.muted.small', fmtTime(v.visitAt) + (v.staffName ? ' · ' + v.staffName : ''))),
            h('div.visit-body',
              h('ul.visit-services', v.services.map((sv) => h('li', h('span', sv.name + (sv.quantity > 1 ? ` × ${sv.quantity}` : '')), h('span', money(sv.unitPriceCents * sv.quantity))))),
              v.discountCents ? h('div.visit-line.muted', h('span', 'Discount'), h('span', '-' + money(v.discountCents))) : null,
              h('div.visit-line.total', h('span', 'Total'), h('span', money(v.totalCents))),
              h('div.visit-foot',
                h('span.muted.small', v.payments.length ? 'Paid by ' + [...new Set(v.payments.map((p) => methodLabel(p.method)))].join(' + ') : 'No payment'),
                h('span.muted.small', v.invoiceNumber),
                statusBadge(v.invoiceStatus)),
              v.notes ? h('div.visit-note', icon('note', 16), h('span', h('strong', 'Visit note: '), v.notes)) : null),
            icon('chevronRight', 20))))
      : emptyState('sparkles', 'No visits yet', 'Start a visit to build this customer’s history.', h('a.btn.primary', { href: '#/visit?customer=' + id }, 'New Visit')));

  clear(view,
    h('a.back', { href: '#/customers' }, icon('chevronLeft', 18), 'Customers'),
    header,
    h('div.profile-grid', h('div.stack', summary, notes, details), history));
}

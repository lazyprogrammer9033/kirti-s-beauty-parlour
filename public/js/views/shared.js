import { h, icon, money, fmtDateShort, avatar, modal, field, toast, todayYmd, confirmDialog } from '../ui.js';
import { api } from '../api.js';
import { session } from '../app.js';

export function pageHeader(title, subtitle, ...actions) {
  return h('div.page-head', h('div', h('h1.display', title), subtitle ? h('p.muted', subtitle) : null), actions.length ? h('div.page-actions', actions) : null);
}

export function statusBadge(status) {
  const labels = { paid: 'Paid', partial: 'Part paid', unpaid: 'Unpaid', void: 'Void', active: 'Active', inactive: 'Inactive', completed: 'Completed' };
  return h('span.badge.' + status, labels[status] || status);
}

// A customer search result with the three quick actions.
export function customerCard(c, { compact = false, onSelect } = {}) {
  return h('div.customer-card' + (c.status === 'inactive' ? '.inactive' : ''),
    h('a.customer-card-main', { href: '#/customer/' + c.id },
      avatar(c.fullName),
      h('div.customer-card-text',
        h('div.customer-card-name', c.fullName, c.status === 'inactive' ? statusBadge('inactive') : null),
        h('div.customer-card-meta', h('span', c.phone), h('span.dot-sep', '·'), h('span', c.customerCode)),
        h('div.customer-card-stats',
          h('span', h('strong', String(c.totalVisits || 0)), ' visits'),
          h('span', 'Last: ', h('strong', c.lastVisitAt ? fmtDateShort(c.lastVisitAt) : 'never')),
          h('span', 'Spent: ', h('strong', money(c.totalSpentCents))),
          c.balanceCents > 0 ? h('span.owing', 'Owes ' + money(c.balanceCents)) : null))),
    h('div.customer-card-actions',
      onSelect
        ? h('button.btn.primary', { type: 'button', onclick: () => onSelect(c) }, icon('check', 18), 'Select')
        : [
            compact ? null : h('a.btn.ghost', { href: '#/customer/' + c.id }, 'View Profile'),
            h('a.btn.soft', { href: '#/visit?customer=' + c.id }, icon('sparkles', 18), 'New Visit'),
            h('a.btn.primary', { href: '#/visit?customer=' + c.id + '&step=bill' }, icon('receipt', 18), 'Create Bill'),
          ]));
}

const REFERRALS = ['Walk-in', 'Friend / family', 'Instagram', 'Facebook', 'Google', 'Flyer', 'Other'];

// Customer form (new or edit) in a modal. Resolves with { id } when saved.
export function customerFormModal({ customer, phone } = {}) {
  return new Promise((resolve) => {
    const c = customer || {};
    const els = {
      fullName: h('input.input', { value: c.fullName || '', autocomplete: 'off', autocapitalize: 'words', required: true }),
      phone: h('input.input', { type: 'tel', inputmode: 'tel', value: c.phone || phone || '', autocomplete: 'off', required: true }),
      email: h('input.input', { type: 'email', inputmode: 'email', value: c.email || '', autocapitalize: 'none', autocomplete: 'off' }),
      dateOfBirth: h('input.input', { type: 'date', value: c.dateOfBirth || '' }),
      address: h('input.input', { value: c.address || '', autocomplete: 'off' }),
      preferredServices: h('input.input', { value: c.preferredServices || '', placeholder: 'e.g. Facial, Eyebrows' }),
      referralSource: h('select.input', h('option', { value: '' }, '—'), REFERRALS.map((r) => h('option', { value: r, selected: c.referralSource === r }, r))),
      firstVisitDate: h('input.input', { type: 'date', value: c.firstVisitDate || todayYmd() }),
      status: h('select.input', h('option', { value: 'active', selected: c.status !== 'inactive' }, 'Active'), h('option', { value: 'inactive', selected: c.status === 'inactive' }, 'Inactive')),
      notes: customer ? null : h('textarea.input', { rows: 2, placeholder: 'e.g. Sensitive skin, prefers evening appointments' }),
    };
    const err = h('p.form-error', { role: 'alert' });
    const more = h('details.more', { open: !!customer },
      h('summary', 'More details (optional)'),
      h('div.grid-2',
        field('Date of birth', els.dateOfBirth),
        field('How did they hear about us?', els.referralSource),
        field('Address', els.address),
        field('Preferred services', els.preferredServices),
        field('First visit date', els.firstVisitDate),
        customer && session.isOwner ? field('Status', els.status) : null));
    const save = h('button.btn.primary.lg', { type: 'submit', form: 'customer-form' }, customer ? 'Save changes' : 'Create customer');
    let saved = false;
    const submit = async (confirmDuplicate = false) => {
      err.textContent = '';
      save.disabled = true;
      const body = Object.fromEntries(Object.entries(els).filter(([, el]) => el).map(([k, el]) => [k, el.value]));
      body.confirmDuplicate = confirmDuplicate;
      try {
        const res = customer ? await api.put('/customers/' + customer.id, body) : await api.post('/customers', body);
        saved = true;
        m.close();
        toast(customer ? 'Customer updated' : `Customer created (${res.customerCode})`);
        resolve(customer ? { id: customer.id } : res);
      } catch (e) {
        save.disabled = false;
        if (e.status === 409 && e.data.duplicates) {
          const d = e.data.duplicates;
          const go = await confirmDialog({
            title: 'Phone number already registered',
            message: `${d.map((x) => `${x.fullName} (${x.customerCode})`).join(', ')} already uses this phone number. Use the existing customer instead, unless this really is a different person (for example, family members sharing a phone).`,
            confirmLabel: 'Create anyway',
          });
          if (go) submit(true);
          else if (!customer) {
            saved = true;
            m.close();
            location.hash = '#/customer/' + d[0].id;
            resolve(null);
          }
          return;
        }
        err.textContent = e.message;
      }
    };
    const form = h('form.stack', { id: 'customer-form', onsubmit: (e) => (e.preventDefault(), submit(false)) },
      h('div.grid-2', field('Full name *', els.fullName), field('Phone number *', els.phone)),
      field('Email', els.email, 'Optional. Used to email receipts.'),
      els.notes ? field('Notes', els.notes) : null,
      more, err);
    const m = modal({
      title: customer ? 'Edit customer' : 'New customer',
      body: form,
      wide: true,
      actions: [h('button.btn.ghost', { type: 'button', onclick: () => m.close() }, 'Cancel'), save],
      onClose: () => !saved && resolve(null),
    });
  });
}

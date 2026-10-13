import { h, clear, icon, money, fmtDateShort, debounce, avatar, toast, field, parseMoney, METHODS, spinner, modal } from '../ui.js';
import { api, download } from '../api.js';
import { session } from '../app.js';
import { offline, visitData } from '../offline.js';
import { customerFormModal } from './shared.js';

// The check-in + billing flow: find customer -> pick services -> take payment.
export async function render(view, { query }) {
  const [catalogue, staff] = await Promise.all([visitData.catalogue(), visitData.staff()]);
  const allowDiscount = session.isOwner || session.settings.staff_can_discount === '1';
  const allowCustom = session.isOwner || session.settings.staff_can_custom_charge === '1';
  const touch = matchMedia('(pointer: coarse)').matches;

  const state = {
    customer: null,
    items: [],
    discountType: 'amount',
    discountValue: '',
    notes: '',
    staffUserId: session.user.id,
    method: 'cash',
    split: false,
    payments: [{ method: 'cash', amount: '' }, { method: 'debit', amount: '' }],
    cashReceived: '',
    payLater: false,
    quote: null,
    quoteError: '',
    category: catalogue[0]?.id ?? null,
    busy: false,
  };
  let keySeq = 0;

  const customerSection = h('section.card.step');
  const servicesSection = h('section.card.step');
  const bill = h('aside.bill.card');
  const mobileBar = h('div.mobile-total');

  clear(view,
    h('div.checkout-head', h('h1.display', 'New Visit'), h('p.muted', 'Phone number → services → payment.')),
    h('div.checkout', h('div.checkout-main', customerSection, servicesSection), bill),
    mobileBar);

  // ---------- Step 1: customer ----------
  function renderCustomer() {
    if (state.customer) {
      const c = state.customer;
      const s = c.stats;
      clear(customerSection,
        h('div.step-head', h('span.step-num.done', icon('check', 16)), h('h2', 'Customer'), h('button.btn.ghost.sm', { type: 'button', onclick: () => { state.customer = null; renderAll(); } }, 'Change')),
        h('div.selected-customer',
          avatar(c.fullName, 'lg'),
          h('div.grow',
            h('div.sc-name', c.fullName),
            h('div.muted', c.pending ? `${c.phone} · new customer, saved on this iPad` : `${c.phone} · ${c.customerCode}`),
            h('div.sc-stats',
              h('span', h('strong', String(s.totalVisits)), ' visits'),
              h('span', 'Last visit ', h('strong', s.lastVisitAt ? fmtDateShort(s.lastVisitAt) : 'first visit today')),
              s.lastServices.length ? h('span', 'Last: ', h('strong', s.lastServices.join(', '))) : null)),
          offline.active || c.pending ? null : h('a.btn.ghost.sm', { href: '#/customer/' + c.id }, 'Profile')),
        s.balanceCents > 0 ? h('div.alert.warn', icon('alert', 18), `This customer owes ${money(s.balanceCents)} from a previous visit.`) : null,
        c.notes.length ? h('div.alert.note', icon('note', 18), h('div', c.notes.slice(0, 3).map((n) => h('div', n.note)))) : null);
      return;
    }
    const input = h('input.input.phone-input', {
      type: 'tel',
      inputmode: touch ? 'none' : 'tel',
      placeholder: 'Phone number',
      autocomplete: 'off',
      'aria-label': 'Customer phone number',
    });
    const results = h('div.lookup-results');
    let mode = 'phone';
    let seq = 0;
    const search = debounce(async () => {
      const q = input.value.trim();
      const digits = q.replace(/\D/g, '');
      const mine = ++seq;
      if ((mode === 'phone' && digits.length < 3) || (mode === 'name' && q.length < 2)) return clear(results, h('p.muted.center', mode === 'phone' ? 'Type the customer’s phone number' : 'Type the customer’s name'));
      const rows = await visitData.search(q).catch(() => []);
      if (mine !== seq) return;
      const list = rows.slice(0, 6).map((c) =>
        h('button.lookup-row', { type: 'button', onclick: () => selectCustomer(c.id) },
          avatar(c.fullName),
          h('div.grow', h('strong', c.fullName), h('div.muted.small', c.pending ? `${c.phone} · new, waiting to sync` : `${c.phone} · ${c.totalVisits} visits · Last ${c.lastVisitAt ? fmtDateShort(c.lastVisitAt) : '—'}`)),
          h('span.btn.primary.sm', 'Select')));
      const exactPhone = mode === 'phone' && digits.length >= 10;
      clear(results,
        list,
        !rows.length || exactPhone
          ? (rows.length && exactPhone && rows.some((r) => r.phone.replace(/\D/g, '').endsWith(digits.slice(-10))) ? null : newCustomerInline(mode === 'phone' ? q : '', mode === 'name' ? q : ''))
          : null);
    }, 140);
    input.addEventListener('input', search);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const first = results.querySelector('.lookup-row');
        if (first) first.click();
      }
    });

    const press = (k) => {
      if (k === 'clear') input.value = '';
      else if (k === 'back') input.value = input.value.slice(0, -1);
      else input.value = formatTyping(input.value.replace(/\D/g, '') + k);
      search();
    };
    const keypad = h('div.keypad', ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'back'].map((k) =>
      h('button.key' + (k.length > 1 ? '.fn' : ''), { type: 'button', 'aria-label': k, onclick: () => press(k) },
        k === 'back' ? icon('delete', 24) : k === 'clear' ? 'Clear' : k)));
    const toggle = h('button.link', { type: 'button', onclick: () => {
      mode = mode === 'phone' ? 'name' : 'phone';
      input.type = mode === 'phone' ? 'tel' : 'search';
      input.inputMode = mode === 'phone' && touch ? 'none' : mode === 'phone' ? 'tel' : 'text';
      input.placeholder = mode === 'phone' ? 'Phone number' : 'Customer name';
      keypad.hidden = mode !== 'phone';
      toggle.textContent = mode === 'phone' ? 'Search by name instead' : 'Search by phone number';
      input.value = '';
      clear(results);
      input.focus();
    } }, 'Search by name instead');

    clear(customerSection,
      h('div.step-head', h('span.step-num', '1'), h('h2', 'Customer'), toggle),
      h('div.lookup',
        h('div.lookup-left', h('div.search-box.big', icon('phone', 22), input), keypad),
        results));
    if (!touch) setTimeout(() => input.focus(), 30);
    search();
  }

  function formatTyping(d) {
    if (d.length <= 3) return d;
    if (d.length <= 6) return `${d.slice(0, 3)}-${d.slice(3)}`;
    if (d.length <= 10) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
    return d;
  }

  function newCustomerInline(phone, name) {
    const nameEl = h('input.input', { value: name, placeholder: 'Full name', autocapitalize: 'words', autocomplete: 'off' });
    const phoneEl = h('input.input', { type: 'tel', value: phone, placeholder: 'Phone number', autocomplete: 'off' });
    const emailEl = h('input.input', { type: 'email', placeholder: 'Email (optional)', autocapitalize: 'none', autocomplete: 'off' });
    const err = h('p.form-error');
    const save = async (confirmDuplicate) => {
      err.textContent = '';
      try {
        const r = await visitData.createCustomer({ fullName: nameEl.value, phone: phoneEl.value, email: emailEl.value, confirmDuplicate });
        toast(r.offline ? 'Customer saved on this iPad' : `Customer created (${r.customerCode})`);
        selectCustomer(r.id);
      } catch (e) {
        if (e.status === 409) {
          err.replaceChildren(`Already registered: ${e.data.duplicates.map((d) => d.fullName).join(', ')}. `,
            h('button.link', { type: 'button', onclick: () => selectCustomer(e.data.duplicates[0].id) }, 'Use existing'), ' or ',
            h('button.link', { type: 'button', onclick: () => save(true) }, 'create anyway'));
        } else err.textContent = e.message;
      }
    };
    return h('div.new-inline',
      h('div.new-inline-head', icon('userPlus', 20), h('strong', 'New customer'),
        offline.active ? null : h('button.link', { type: 'button', onclick: async () => { const r = await customerFormModal({ phone: phoneEl.value }); if (r) selectCustomer(r.id); } }, 'More details')),
      h('div.grid-2', nameEl, phoneEl), emailEl, err,
      h('button.btn.primary.block', { type: 'button', onclick: () => save(false) }, icon('check', 18), 'Create New Customer'));
  }

  async function selectCustomer(id) {
    clear(customerSection, spinner());
    try {
      state.customer = await visitData.customer(id);
    } catch (e) {
      toast(e.message, 'error');
      state.customer = null;
    }
    renderAll();
    if (innerWidth < 1000) servicesSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ---------- Step 2: services ----------
  function addService(s) {
    const existing = state.items.find((i) => i.serviceId === s.id);
    if (existing) existing.quantity = Math.min(existing.quantity + 1, 99);
    else state.items.push({ key: ++keySeq, serviceId: s.id, name: s.name, unitPriceCents: s.priceCents, quantity: 1, taxable: s.taxable });
    changed();
  }

  function renderServices() {
    const enabled = !!state.customer;
    const cats = h('div.chips.scroll', catalogue.map((c) =>
      h('button.chip' + (c.id === state.category ? '.on' : ''), { type: 'button', onclick: () => { state.category = c.id; renderServices(); } }, c.name)));
    const cat = catalogue.find((c) => c.id === state.category) || catalogue[0];
    const lastNames = state.customer?.stats.lastServices || [];
    const lastSvcs = lastNames.map((n) => catalogue.flatMap((c) => c.services).find((s) => s.name === n)).filter(Boolean);
    clear(servicesSection,
      h('div.step-head', h('span.step-num' + (state.items.length ? '.done' : ''), state.items.length ? icon('check', 16) : '2'), h('h2', 'Services'),
        lastSvcs.length ? h('button.btn.soft.sm', { type: 'button', onclick: () => lastSvcs.forEach(addService) }, icon('repeat', 16), 'Same as last time') : null),
      enabled ? null : h('p.muted', 'Choose the customer first.'),
      h('div' + (enabled ? '' : '.disabled'),
        cats,
        h('div.service-grid', (cat?.services || []).map((s) => {
          const inCart = state.items.find((i) => i.serviceId === s.id);
          return h('button.service-tile' + (inCart ? '.on' : ''), { type: 'button', disabled: !enabled, onclick: () => addService(s) },
            inCart ? h('span.tile-qty', String(inCart.quantity)) : null,
            h('span.tile-name', s.name),
            h('span.tile-meta', h('strong', money(s.priceCents)), s.durationMinutes ? h('span.muted', ` · ${s.durationMinutes} min`) : null));
        }), !cat ? h('p.muted', 'No services yet. ', session.can('services.manage') ? h('a', { href: '#/services' }, 'Add your services and prices.') : 'The owner can add them on the Services screen.')
          : !cat.services.length ? h('p.muted', 'No services in this category yet.') : null)));
  }

  // ---------- Bill ----------
  const requestQuote = debounce(async () => {
    if (!state.items.length) {
      state.quote = null;
      state.quoteError = '';
      return renderQuoteParts();
    }
    try {
      state.quote = await visitData.quote(payload());
      state.quoteError = '';
    } catch (e) {
      state.quote = null;
      state.quoteError = e.message;
    }
    renderQuoteParts();
  }, 150);

  function changed() {
    renderServices();
    renderBill();
    requestQuote();
  }

  function payload() {
    const discount = state.discountValue !== '' && Number(state.discountValue) > 0
      ? state.discountType === 'percent' ? { type: 'percent', percent: Number(state.discountValue) } : { type: 'amount', amountCents: parseMoney(state.discountValue) ?? -1 }
      : null;
    return {
      items: state.items.map((i) => (i.serviceId ? { serviceId: i.serviceId, quantity: i.quantity } : { type: 'custom', description: i.name, priceCents: i.unitPriceCents, quantity: i.quantity, taxable: i.taxable })),
      discount,
    };
  }

  function paymentsFor(total) {
    if (!state.split) return state.payLater ? [] : [{ method: state.method, amountCents: total }];
    return state.payments.map((p) => ({ method: p.method, amountCents: parseMoney(p.amount) || 0 })).filter((p) => p.amountCents > 0);
  }

  function addCustom() {
    const desc = h('input.input', { placeholder: 'e.g. Hair treatment add-on' });
    const price = h('input.input', { inputmode: 'decimal', placeholder: '0.00' });
    const taxable = h('input', { type: 'checkbox', checked: true });
    const m = modal({
      title: 'Custom charge',
      body: h('div.stack', field('Description', desc), field('Price (CAD)', price), h('label.check', taxable, ' Taxable')),
      actions: [h('button.btn.ghost', { type: 'button', onclick: () => m.close() }, 'Cancel'), h('button.btn.primary', { type: 'button', onclick: () => {
        const cents = parseMoney(price.value);
        if (!desc.value.trim() || cents == null) return toast('Enter a description and price', 'error');
        state.items.push({ key: ++keySeq, serviceId: null, name: desc.value.trim(), unitPriceCents: cents, quantity: 1, taxable: taxable.checked });
        m.close();
        changed();
      } }, 'Add')],
    });
  }

  // The bill is split into parts so typing in one box (discount, cash) is never
  // interrupted by a refresh of another part.
  const billParts = { totals: h('div'), pay: h('div'), button: h('div') };

  function renderBill() {
    const lines = state.items.map((it) =>
      h('div.bill-line',
        h('div.grow', h('div', it.name), h('div.muted.small', money(it.unitPriceCents) + (it.taxable ? '' : ' · no tax'))),
        h('div.stepper',
          h('button', { type: 'button', 'aria-label': it.quantity > 1 ? 'Less' : 'Remove', onclick: () => { it.quantity -= 1; if (it.quantity < 1) state.items = state.items.filter((x) => x !== it); changed(); } }, icon(it.quantity > 1 ? 'minus' : 'trash', 16)),
          h('span', String(it.quantity)),
          h('button', { type: 'button', 'aria-label': 'More', onclick: () => { it.quantity = Math.min(99, it.quantity + 1); changed(); } }, icon('plus', 16))),
        h('strong.line-amt', money(it.unitPriceCents * it.quantity))));

    const discountRow = allowDiscount && state.items.length
      ? h('div.bill-row',
          h('span', 'Discount'),
          h('div.seg', ['amount', 'percent'].map((t) => h('button' + (state.discountType === t ? '.on' : ''), { type: 'button', onclick: () => { state.discountType = t; renderBill(); requestQuote(); } }, t === 'amount' ? '$' : '%'))),
          h('input.input.sm', { inputmode: 'decimal', value: state.discountValue, placeholder: '0', 'aria-label': 'Discount', oninput: (e) => { state.discountValue = e.target.value; requestQuote(); } }))
      : null;

    clear(bill,
      h('div.bill-head', h('h2', 'Bill'), state.customer ? h('span.muted', state.customer.fullName) : null),
      state.items.length ? h('div.bill-lines', lines) : h('p.muted.center.pad', 'Selected services will appear here.'),
      allowCustom && state.customer ? h('button.link.small', { type: 'button', onclick: addCustom }, icon('plus', 14), ' Custom charge') : null,
      discountRow,
      billParts.totals,
      state.items.length ? h('div.bill-extra',
        field('Visit note (optional)', h('textarea.input', { rows: 2, placeholder: 'Only for this visit, e.g. used colour 6.3', value: state.notes, oninput: (e) => (state.notes = e.target.value) })),
        staff.length > 1 ? field('Served by', h('select.input', { onchange: (e) => (state.staffUserId = Number(e.target.value)) }, staff.map((s) => h('option', { value: s.id, selected: s.id === state.staffUserId }, s.displayName)))) : null) : null,
      billParts.pay,
      billParts.button);
    renderQuoteParts();
  }

  function splitInfo(total) {
    const sum = paymentsFor(total).reduce((s, p) => s + p.amountCents, 0);
    return sum === total ? h('span.ok', 'Fully paid') : sum < total ? h('span.warn', `Remaining: ${money(total - sum)} (will be owing)`) : h('span.err', `Over by ${money(sum - total)}`);
  }

  function renderQuoteParts() {
    const q = state.items.length ? state.quote : null;
    const total = q ? q.totalCents : 0;
    clear(billParts.totals, q
      ? h('div.totals',
          h('div', h('span', 'Subtotal'), h('span', money(q.subtotalCents))),
          q.discountCents ? h('div', h('span', 'Discount'), h('span', '-' + money(q.discountCents))) : null,
          h('div', h('span', `${q.taxName} ${q.taxRateBp / 100}%${q.pricesIncludeTax ? ' (included)' : ''}`), h('span', money(q.taxCents))),
          h('div.grand', h('span', 'Total'), h('span', money(q.totalCents), h('small', ' CAD'))))
      : state.quoteError && state.items.length ? h('p.form-error', state.quoteError) : null);
    renderPay(q, total);
    const ready = !!(state.customer && state.items.length && q && !state.busy);
    clear(billParts.button, h('button.btn.primary.xl.block', { type: 'button', disabled: !ready, onclick: complete },
      icon('check', 22), q ? (state.payLater ? `Save visit · ${money(total)} owing` : `Complete · ${money(total)}`) : 'Complete Payment'));
    clear(mobileBar,
      h('div', h('span.muted.small', `${state.items.reduce((s, i) => s + i.quantity, 0)} item(s)`), h('strong', q ? money(total) : '$0.00')),
      h('button.btn.primary', { type: 'button', disabled: !state.items.length, onclick: () => bill.scrollIntoView({ behavior: 'smooth', block: 'start' }) }, 'Review & Pay'));
    mobileBar.classList.toggle('show', !!state.customer);
  }

  function renderPay(q, total) {
    if (!q) return clear(billParts.pay);
    const rerender = () => renderQuoteParts();
    const methods = h('div.methods', METHODS.map(([m, label]) =>
      h('button.method' + (!state.split && !state.payLater && state.method === m ? '.on' : ''), { type: 'button', onclick: () => { state.method = m; rerender(); } }, label)));
    let extra = null;
    if (state.split) {
      const info = h('div.split-info', splitInfo(total));
      const rest = (p, other) => () => { p.amount = (Math.max(total - (parseMoney(other.amount) || 0), 0) / 100).toFixed(2); rerender(); };
      const [p0, p1] = state.payments;
      extra = h('div.split',
        [[p0, p1], [p1, p0]].map(([p, other]) => h('div.split-row',
          h('select.input.sm', { 'aria-label': 'Payment method', onchange: (e) => { p.method = e.target.value; } }, METHODS.map(([m, l]) => h('option', { value: m, selected: p.method === m }, l))),
          h('input.input.sm', { inputmode: 'decimal', placeholder: '0.00', value: p.amount, 'aria-label': 'Amount', oninput: (e) => { p.amount = e.target.value; clear(info, splitInfo(total)); } }),
          h('button.link.small', { type: 'button', onclick: rest(p, other) }, 'Rest'))),
        info);
    } else if (state.payLater) {
      extra = h('div.alert.warn', icon('alert', 18), `No payment now. ${money(total)} will be recorded as owing.`);
    } else if (state.method === 'cash') {
      const change = h('div.change');
      const show = () => {
        const received = parseMoney(state.cashReceived);
        change.textContent = received != null && received >= total ? `Change due: ${money(received - total)}` : '';
      };
      extra = h('div.cash',
        h('label.field.inline', h('span.label', 'Cash received'), h('input.input.sm', { inputmode: 'decimal', placeholder: (total / 100).toFixed(2), value: state.cashReceived, oninput: (e) => { state.cashReceived = e.target.value; show(); } })),
        change);
      show();
    }
    clear(billParts.pay, h('div.pay',
      h('div.pay-head', h('h3', 'Payment'),
        h('div.pay-opts',
          h('button.link.small', { type: 'button', onclick: () => { state.split = !state.split; state.payLater = false; rerender(); } }, state.split ? 'Single payment' : 'Split payment'),
          h('button.link.small', { type: 'button', onclick: () => { state.payLater = !state.payLater; state.split = false; rerender(); } }, state.payLater ? 'Take payment now' : 'Pay later'))),
      state.split || state.payLater ? null : methods,
      extra));
  }

  async function complete() {
    const q = state.quote;
    if (!q) return;
    const payments = paymentsFor(q.totalCents);
    const paid = payments.reduce((s, p) => s + p.amountCents, 0);
    if (paid > q.totalCents) return toast('Payments are more than the total', 'error');
    const body = { customerId: state.customer.id, ...payload(), payments, notes: state.notes, staffUserId: state.staffUserId, allowBalance: paid < q.totalCents };
    state.busy = true;
    renderQuoteParts();
    try {
      const r = await visitData.createVisit(body, { customerName: state.customer.fullName, phone: state.customer.phone, totalCents: q.totalCents });
      if (r.offline) successOffline(r);
      else success(r);
    } catch (e) {
      state.busy = false;
      renderQuoteParts();
      toast(e.message, 'error');
    }
  }

  function success(r) {
    const c = state.customer;
    const emailBtn = c.email
      ? h('button.btn.ghost.lg', { type: 'button', onclick: async (e) => {
          e.currentTarget.disabled = true;
          try {
            await api.post(`/invoices/${r.invoiceId}/email`, {});
            toast('Receipt emailed to ' + c.email);
          } catch (ex) {
            toast(ex.message, 'error');
            e.currentTarget.disabled = false;
          }
        } }, icon('mail', 20), 'Email receipt')
      : null;
    clear(view,
      h('div.success.card',
        h('div.success-icon', icon('check', 44)),
        h('h1.display', r.balanceCents > 0 ? 'Visit saved' : 'Payment complete'),
        h('p.big', `${c.fullName} · ${money(r.totalCents)}`),
        r.balanceCents > 0 ? h('div.alert.warn', icon('alert', 18), `Balance owing: ${money(r.balanceCents)}`) : null,
        h('p.muted', `Receipt ${r.invoiceNumber} · Visit ${r.visitCode}`),
        h('div.success-actions',
          h('a.btn.ghost.lg', { href: `#/invoice/${r.invoiceId}?print=1` }, icon('printer', 20), 'Print receipt'),
          h('button.btn.ghost.lg', { type: 'button', onclick: () => download(`/invoices/${r.invoiceId}/pdf?download=1`) }, icon('download', 20), 'Download PDF'),
          emailBtn),
        h('div.success-actions',
          h('a.btn.soft.lg', { href: '#/customer/' + c.id }, 'View customer'),
          h('button.btn.primary.lg', { type: 'button', onclick: () => render(view, { query: new URLSearchParams() }) }, icon('plus', 20), 'Next customer'))));
  }

  // Saved on this iPad; the salon computer gives the real receipt number at sync.
  function successOffline(r) {
    const c = state.customer;
    clear(view,
      h('div.success.card',
        h('div.success-icon.offline', icon('check', 44)),
        h('h1.display', 'Saved on this iPad'),
        h('p.big', `${c.fullName} · ${money(r.totalCents)}`),
        r.balanceCents > 0 ? h('div.alert.warn', icon('alert', 18), `Balance owing: ${money(r.balanceCents)}`) : null,
        h('p.muted', `Temporary receipt ${r.tempNumber}. The salon computer gives the final receipt number when it’s back, and the receipt can then be printed or emailed from Billing.`),
        h('div.success-actions',
          h('button.btn.primary.lg', { type: 'button', onclick: () => render(view, { query: new URLSearchParams() }) }, icon('plus', 20), 'Next customer'))));
  }

  function renderAll() {
    renderCustomer();
    renderServices();
    renderBill();
  }

  renderAll();
  const preset = Number(query.get('customer'));
  if (preset) await selectCustomer(preset);
}

import { h, clear, icon, money, fmtDateTime, methodLabel, modal, field, toast, METHODS, parseMoney } from '../ui.js';
import { api, download } from '../api.js';
import { session } from '../app.js';
import { statusBadge } from './shared.js';

export async function render(view, { params, query }) {
  const inv = await api.get('/invoices/' + encodeURIComponent(params[0]));
  const biz = session.settings;
  const reload = () => render(view, { params, query: new URLSearchParams() });

  const recordPayment = () => {
    let method = 'cash';
    const amount = h('input.input', { inputmode: 'decimal', value: (inv.balanceCents / 100).toFixed(2) });
    const methods = h('div.methods', METHODS.map(([m, l]) => h('button.method' + (m === method ? '.on' : ''), { type: 'button', onclick: (e) => { method = m; methods.querySelectorAll('.method').forEach((b) => b.classList.remove('on')); e.currentTarget.classList.add('on'); } }, l)));
    const m = modal({
      title: 'Record payment',
      body: h('div.stack', h('p', `Balance owing: `, h('strong', money(inv.balanceCents))), methods, field('Amount (CAD)', amount)),
      actions: [h('button.btn.ghost', { type: 'button', onclick: () => m.close() }, 'Cancel'), h('button.btn.primary', { type: 'button', onclick: async () => {
        const cents = parseMoney(amount.value);
        if (!cents) return toast('Enter an amount', 'error');
        try {
          await api.post(`/invoices/${inv.id}/payments`, { method, amountCents: cents });
          m.close();
          toast('Payment recorded');
          reload();
        } catch (e) {
          toast(e.message, 'error');
        }
      } }, 'Record payment')],
    });
  };

  const voidInvoice = async () => {
    const reason = h('input.input', { placeholder: 'e.g. Entered by mistake' });
    const m = modal({
      title: 'Void this receipt?',
      body: h('div.stack', h('p', 'The receipt stays in the records but is marked VOID and removed from sales totals. Any refund must be given separately.'), field('Reason', reason)),
      actions: [h('button.btn.ghost', { type: 'button', onclick: () => m.close() }, 'Cancel'), h('button.btn.danger', { type: 'button', onclick: async () => {
        if (!reason.value.trim()) return toast('Please enter a reason', 'error');
        try {
          await api.post(`/invoices/${inv.id}/void`, { reason: reason.value });
          m.close();
          toast('Receipt voided');
          reload();
        } catch (e) {
          toast(e.message, 'error');
        }
      } }, 'Void receipt')],
    });
  };

  const editNote = () => {
    const ta = h('textarea.input', { rows: 4, value: inv.visitNotes || '' });
    const m = modal({
      title: 'Visit note',
      body: field('Note for this visit only', ta, 'The previous text is kept in the audit log.'),
      actions: [h('button.btn.ghost', { type: 'button', onclick: () => m.close() }, 'Cancel'), h('button.btn.primary', { type: 'button', onclick: async () => {
        await api.put(`/invoices/${inv.id}/notes`, { notes: ta.value });
        m.close();
        reload();
      } }, 'Save')],
    });
  };

  const emailReceipt = async (btn) => {
    btn.disabled = true;
    try {
      const r = await api.post(`/invoices/${inv.id}/email`, {});
      toast('Receipt emailed to ' + r.to);
    } catch (e) {
      toast(e.message, 'error');
    }
    btn.disabled = false;
  };

  const actions = h('div.receipt-actions.no-print',
    h('button.btn.primary', { type: 'button', onclick: () => window.print() }, icon('printer', 18), 'Print'),
    h('button.btn.ghost', { type: 'button', onclick: () => download(`/invoices/${inv.id}/pdf?download=1`) }, icon('download', 18), 'PDF'),
    inv.customer.email ? h('button.btn.ghost', { type: 'button', onclick: (e) => emailReceipt(e.currentTarget) }, icon('mail', 18), 'Email') : null,
    session.isOwner && biz.drive_refresh_token_set === '1' ? h('button.btn.ghost', { type: 'button', onclick: async (e) => {
      e.currentTarget.disabled = true;
      try {
        await api.post(`/invoices/${inv.id}/drive`);
        toast('Saved to Google Drive › Receipts');
      } catch (ex) {
        toast(ex.message, 'error');
      }
    } }, icon('cloud', 18), 'Save to Drive') : null,
    inv.balanceCents > 0 && inv.status !== 'void' ? h('button.btn.soft', { type: 'button', onclick: recordPayment }, icon('dollar', 18), 'Record payment') : null,
    h('button.btn.ghost', { type: 'button', onclick: editNote }, icon('note', 18), 'Visit note'),
    session.can('invoices.void') && inv.status !== 'void' ? h('button.btn.ghost.danger-text', { type: 'button', onclick: voidInvoice }, icon('x', 18), 'Void') : null);

  const paid = inv.payments.filter((p) => p.status === 'completed');
  const receipt = h('article.receipt' + (inv.status === 'void' ? '.is-void' : ''),
    h('header.receipt-head',
      biz.business_logo ? h('img.receipt-logo', { src: biz.business_logo, alt: '' }) : null,
      h('div.receipt-biz',
        h('h2.display', biz.business_name),
        [biz.business_address, biz.business_phone, biz.business_email, biz.business_website].filter(Boolean).map((l) => h('div', l)),
        biz.receipt_show_tax_number === '1' && biz.tax_number ? h('div', `${inv.taxName} #: ${biz.tax_number}`) : null),
      h('div.receipt-meta', h('div.receipt-title', inv.status === 'void' ? 'VOID' : 'Receipt'), h('div', inv.invoiceNumber), h('div', fmtDateTime(inv.issuedAt)))),
    h('div.receipt-to',
      h('div', h('span.muted.small', 'Customer'), h('div', h('strong', inv.customer.fullName)), h('div.small', `${inv.customer.phone} · ${inv.customer.customerCode}`)),
      inv.staffName ? h('div.right', h('span.muted.small', 'Served by'), h('div', inv.staffName)) : null),
    h('table.receipt-items',
      h('thead', h('tr', h('th', 'Service'), h('th.num', 'Qty'), h('th.num', 'Price'), h('th.num', 'Amount'))),
      h('tbody', inv.items.map((i) => h('tr', h('td', i.description, i.taxable ? '' : ' *'), h('td.num', String(i.quantity)), h('td.num', money(i.unitPriceCents)), h('td.num', money(i.lineSubtotalCents)))))),
    h('div.receipt-totals',
      h('div', h('span', 'Subtotal'), h('span', money(inv.subtotalCents))),
      inv.discountCents ? h('div', h('span', 'Discount' + (inv.discountType === 'percent' ? ` (${inv.discountValue / 100}%)` : '')), h('span', '-' + money(inv.discountCents))) : null,
      h('div', h('span', `${inv.taxName} (${inv.taxRateBp / 100}%)${inv.pricesIncludeTax ? ' included' : ''}`), h('span', money(inv.taxCents))),
      h('div.grand', h('span', 'Total (CAD)'), h('span', money(inv.totalCents))),
      paid.map((p) => h('div.muted', h('span', `Paid · ${methodLabel(p.method)}`), h('span', money(p.amountCents)))),
      inv.balanceCents > 0 ? h('div.owing', h('span', 'Balance owing'), h('span', money(inv.balanceCents))) : null),
    inv.items.some((i) => !i.taxable) ? h('p.small.muted', '* not taxable') : null,
    inv.status === 'void' ? h('div.alert.danger', `Voided${inv.voidedAt ? ' on ' + fmtDateTime(inv.voidedAt) : ''}${inv.voidedBy ? ' by ' + inv.voidedBy : ''}: ${inv.voidReason || ''}`) : null,
    biz.receipt_footer ? h('footer.receipt-foot', biz.receipt_footer) : null);

  clear(view,
    h('div.no-print.invoice-top',
      h('a.back', { href: '#/customer/' + inv.customer.id }, icon('chevronLeft', 18), inv.customer.fullName),
      h('div.invoice-status', statusBadge(inv.status), h('span.muted.small', `Visit ${inv.visitCode}`))),
    actions,
    h('div.invoice-layout',
      receipt,
      h('aside.card.no-print.invoice-side',
        h('h3', 'Visit details'),
        h('dl.details',
          h('dt', 'Visit ID'), h('dd', inv.visitCode),
          h('dt', 'Created by'), h('dd', inv.createdBy || '—'),
          h('dt', 'Payments'), h('dd', inv.payments.length ? inv.payments.map((p) => h('div' + (p.status === 'void' ? '.strike' : ''), `${methodLabel(p.method)} ${money(p.amountCents)} · ${fmtDateTime(p.receivedAt)}`)) : 'None'),
          h('dt', 'Visit note'), h('dd', inv.visitNotes || '—')))));

  if (query.get('print') === '1') setTimeout(() => window.print(), 300);
}

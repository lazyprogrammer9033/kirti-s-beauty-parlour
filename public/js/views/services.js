import { h, clear, icon, money, modal, field, toast, emptyState } from '../ui.js';
import { api } from '../api.js';
import { session } from '../app.js';
import { pageHeader } from './shared.js';

export async function render(view) {
  const manage = session.can('services.manage');
  const cats = await api.get('/services' + (manage ? '?all=1' : ''));
  const reload = () => render(view);

  const serviceModal = (svc, categoryId) => {
    const s = svc || { categoryId, taxable: 1, active: 1 };
    const els = {
      name: h('input.input', { value: s.name || '', autocapitalize: 'words' }),
      categoryId: h('select.input', cats.map((c) => h('option', { value: c.id, selected: c.id === s.categoryId }, c.name))),
      price: h('input.input', { inputmode: 'decimal', value: s.priceCents != null ? (s.priceCents / 100).toFixed(2) : '', placeholder: '0.00' }),
      durationMinutes: h('input.input', { inputmode: 'numeric', value: s.durationMinutes ?? '', placeholder: 'e.g. 45' }),
      description: h('textarea.input', { rows: 2, value: s.description || '' }),
      taxable: h('input', { type: 'checkbox', checked: !!s.taxable }),
      active: h('input', { type: 'checkbox', checked: !!s.active }),
    };
    const err = h('p.form-error');
    const m = modal({
      title: svc ? 'Edit service' : 'New service',
      body: h('div.stack',
        field('Service name', els.name),
        h('div.grid-2', field('Category', els.categoryId), field('Price (CAD)', els.price, svc ? 'Changing the price never changes past receipts.' : null)),
        field('Duration (minutes)', els.durationMinutes),
        field('Description', els.description),
        h('div.checks', h('label.check', els.taxable, ' Taxable'), h('label.check', els.active, ' Offered (active)')),
        err),
      actions: [h('button.btn.ghost', { type: 'button', onclick: () => m.close() }, 'Cancel'), h('button.btn.primary', { type: 'button', onclick: async () => {
        const body = { name: els.name.value, categoryId: Number(els.categoryId.value), price: els.price.value, durationMinutes: els.durationMinutes.value, description: els.description.value, taxable: els.taxable.checked, active: els.active.checked };
        try {
          if (svc) await api.put('/services/' + svc.id, body);
          else await api.post('/services', body);
          m.close();
          toast(svc ? 'Service updated' : 'Service added');
          reload();
        } catch (e) {
          err.textContent = e.message;
        }
      } }, 'Save')],
    });
  };

  const categoryModal = (cat) => {
    const name = h('input.input', { value: cat?.name || '', autocapitalize: 'words' });
    const active = h('input', { type: 'checkbox', checked: cat ? !!cat.active : true });
    const err = h('p.form-error');
    const m = modal({
      title: cat ? 'Edit category' : 'New category',
      body: h('div.stack', field('Category name', name), cat ? h('label.check', active, ' Show this category') : null, err),
      actions: [h('button.btn.ghost', { type: 'button', onclick: () => m.close() }, 'Cancel'), h('button.btn.primary', { type: 'button', onclick: async () => {
        try {
          if (cat) await api.put('/service-categories/' + cat.id, { name: name.value, active: active.checked });
          else await api.post('/service-categories', { name: name.value });
          m.close();
          reload();
        } catch (e) {
          err.textContent = e.message;
        }
      } }, 'Save')],
    });
  };

  const toggle = async (svc) => {
    await api.put('/services/' + svc.id, { active: !svc.active });
    toast(svc.active ? `${svc.name} disabled` : `${svc.name} enabled`);
    reload();
  };

  clear(view,
    pageHeader('Services', manage ? 'Your menu of services and prices.' : 'Services and current prices.',
      manage ? h('button.btn.ghost', { type: 'button', onclick: () => categoryModal() }, icon('tag', 18), 'New Category') : null,
      manage ? h('button.btn.primary', { type: 'button', onclick: () => serviceModal(null, cats[0]?.id) }, icon('plus', 18), 'New Service') : null),
    cats.length ? null : emptyState('scissors', 'No services yet', 'Create a category, then add services.'),
    cats.map((c) => h('section.card.svc-cat' + (c.active ? '' : '.muted-card'),
      h('div.card-head',
        h('h3', c.name, c.active ? null : h('span.badge.inactive', 'Hidden')),
        manage ? h('div.row', h('button.btn.ghost.sm', { type: 'button', onclick: () => categoryModal(c) }, 'Edit'), h('button.btn.soft.sm', { type: 'button', onclick: () => serviceModal(null, c.id) }, icon('plus', 16), 'Add')) : null),
      c.services.length
        ? h('div.svc-list', c.services.map((s) =>
            h('div.svc-row' + (s.active ? '' : '.off'),
              h('div.grow', h('div.svc-name', s.name, s.taxable ? null : h('span.badge', 'No tax'), s.active ? null : h('span.badge.inactive', 'Disabled')), s.description ? h('div.muted.small', s.description) : null),
              h('span.muted.small.hide-sm', s.durationMinutes ? `${s.durationMinutes} min` : ''),
              h('strong.svc-price', money(s.priceCents)),
              manage ? h('div.row',
                h('button.btn.ghost.sm', { type: 'button', onclick: () => serviceModal(s) }, icon('edit', 16), h('span.hide-sm', 'Edit')),
                h('button.switch' + (s.active ? '.on' : ''), { type: 'button', role: 'switch', 'aria-checked': String(!!s.active), 'aria-label': (s.active ? 'Disable ' : 'Enable ') + s.name, onclick: () => toggle(s) }, h('span'))) : null)))
        : h('p.muted', 'No services in this category.'))));
}

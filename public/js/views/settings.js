import { h, clear, icon, field, toast, modal, confirmDialog, fmtDateTime, spinner, money } from '../ui.js';
import { api, download } from '../api.js';
import { session, refreshSettings } from '../app.js';
import { pageHeader } from './shared.js';

const OWNER_TABS = [
  ['business', 'Business'],
  ['tax', 'Tax & Receipts'],
  ['backup', 'Backup & Data'],
  ['appointments', 'Appointments'],
  ['users', 'Staff Accounts'],
  ['email', 'Email'],
  ['audit', 'Audit Log'],
  ['ipad', 'iPad & Offline'],
  ['account', 'My Account'],
];

export async function render(view, { params, query }) {
  const owner = session.can('settings.manage');
  const tabs = owner ? OWNER_TABS : [['account', 'My Account']];
  const tab = tabs.some(([k]) => k === params[0]) ? params[0] : tabs[0][0];
  const body = h('div', spinner());
  clear(view,
    pageHeader('Settings', owner ? 'Business details, tax, backups and staff.' : 'Your account.',
      owner ? h('a.btn.ghost', { href: '#/services' }, icon('scissors', 18), 'Manage services') : null),
    h('div.tabs', tabs.map(([k, l]) => h('a.tab' + (k === tab ? '.on' : ''), { href: '#/settings/' + k }, l))),
    body);
  const renderers = { business, tax, backup, appointments, users, email, audit, account, ipad };
  await renderers[tab](body, { query, rerender: () => render(view, { params, query: new URLSearchParams() }) });
}

// Generic settings form: fields bound to setting keys, saved together.
function settingsForm(container, s, rows, { title, intro } = {}) {
  const inputs = {};
  const make = (key, opts = {}) => {
    if (opts.type === 'checkbox') return (inputs[key] = h('input', { type: 'checkbox', checked: s[key] === '1' }));
    if (opts.type === 'textarea') return (inputs[key] = h('textarea.input', { rows: opts.rows || 3, value: s[key] || '' }));
    if (opts.type === 'select') return (inputs[key] = h('select.input', opts.options.map(([v, l]) => h('option', { value: v, selected: String(s[key]) === String(v) }, l))));
    return (inputs[key] = h('input.input', { value: opts.value ?? s[key] ?? '', type: opts.inputType || 'text', inputmode: opts.inputmode, placeholder: opts.placeholder || '' }));
  };
  const save = h('button.btn.primary', { type: 'submit' }, 'Save changes');
  const form = h('form.card.stack', {
    onsubmit: async (e) => {
      e.preventDefault();
      save.disabled = true;
      const data = {};
      for (const [k, el] of Object.entries(inputs)) data[k] = el.type === 'checkbox' ? el.checked : el.value;
      try {
        const r = await api.put('/settings', data);
        await refreshSettings();
        toast(r.changed.length ? 'Settings saved' : 'No changes');
      } catch (ex) {
        toast(ex.message, 'error');
      }
      save.disabled = false;
    },
  },
  title ? h('h3', title) : null,
  intro ? h('p.muted', intro) : null,
  rows(make),
  h('div.row.end', save));
  container.append(form);
  return inputs;
}

async function business(body) {
  const s = await api.get('/settings');
  clear(body);
  let logo = s.business_logo || '';
  const preview = h('div.logo-preview', logo ? h('img', { src: logo, alt: 'Logo' }) : h('span.muted', 'No logo'));
  const fileInput = h('input', { type: 'file', accept: 'image/png,image/jpeg', hidden: true, onchange: async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    if (f.size > 500 * 1024) return toast('Please choose an image under 500 KB', 'error');
    logo = await new Promise((r) => {
      const fr = new FileReader();
      fr.onload = () => r(fr.result);
      fr.readAsDataURL(f);
    });
    try {
      await api.put('/settings', { business_logo: logo });
      await refreshSettings();
      clear(preview, h('img', { src: logo, alt: 'Logo' }));
      toast('Logo updated');
    } catch (ex) {
      toast(ex.message, 'error');
    }
  } });
  body.append(h('div.card.logo-card',
    preview,
    h('div', h('h3', 'Logo'), h('p.muted', 'Shown on receipts. PNG or JPEG, under 500 KB.'),
      h('div.row', h('button.btn.soft', { type: 'button', onclick: () => fileInput.click() }, icon('upload', 18), 'Upload logo'),
        logo ? h('button.btn.ghost', { type: 'button', onclick: async () => { await api.put('/settings', { business_logo: '' }); await refreshSettings(); clear(preview, h('span.muted', 'No logo')); } }, 'Remove') : null)),
    fileInput));
  settingsForm(body, s, (f) => [
    field('Business name', f('business_name')),
    field('Address', f('business_address', { type: 'textarea', rows: 2 })),
    h('div.grid-2', field('Phone', f('business_phone', { inputType: 'tel' })), field('Email', f('business_email', { inputType: 'email' }))),
    h('div.grid-2', field('Website', f('business_website', { placeholder: 'www.example.com' })), field('Social media', f('business_social', { placeholder: '@yoursalon' }))),
    h('div.grid-2',
      field('Time zone', f('timezone', { type: 'select', options: ['America/Toronto', 'America/Vancouver', 'America/Edmonton', 'America/Winnipeg', 'America/Regina', 'America/Halifax', 'America/St_Johns'].map((z) => [z, z.replace('America/', '').replace('_', ' ')]) })),
      field('Currency', h('input.input', { value: 'CAD — Canadian dollar', disabled: true }))),
  ], { title: 'Business information' });
}

async function tax(body) {
  const s = await api.get('/settings');
  clear(body);
  settingsForm(body, s, (f) => [
    h('div.grid-2',
      field('Tax name', f('tax_name', { placeholder: 'HST' }), 'e.g. HST, GST, GST + PST'),
      field('Tax rate (%)', f('tax_rate_bp', { value: (Number(s.tax_rate_bp) / 100).toString(), inputmode: 'decimal' }), 'Ontario HST is 13%. Changing it only affects new bills.')),
    h('label.check', f('prices_include_tax', { type: 'checkbox' }), ' My service prices already include tax'),
    h('div.grid-2', field('GST/HST registration number', f('tax_number', { placeholder: '123456789 RT0001' })), h('label.check.pad-top', f('receipt_show_tax_number', { type: 'checkbox' }), ' Show tax number on receipts')),
  ], { title: 'Tax', intro: 'Each bill stores the tax it was charged, so old receipts never change.' });
  settingsForm(body, s, (f) => [
    field('Thank-you message', f('receipt_footer', { type: 'textarea', rows: 3 })),
  ], { title: 'Receipts' });
  settingsForm(body, s, (f) => [
    h('label.check', f('staff_can_discount', { type: 'checkbox' }), ' Staff can give discounts'),
    h('label.check', f('staff_can_custom_charge', { type: 'checkbox' }), ' Staff can add custom charges'),
  ], { title: 'Staff billing permissions' });
}

async function backup(body, { query, rerender }) {
  const [data, drive] = await Promise.all([api.get('/backups'), api.get('/drive/status')]);
  const st = data.status;
  clear(body);
  if (query.get('drive') === 'connected') toast('Google Drive connected');
  if (query.get('drive') === 'error') toast(query.get('message') || 'Google Drive connection failed', 'error');

  const lastOk = st.lastSuccess;
  const ageHours = lastOk ? (Date.now() - new Date(lastOk.at).getTime()) / 36e5 : Infinity;
  const health = !lastOk ? 'bad' : ageHours > 48 ? 'warn' : 'good';
  const backupNow = h('button.btn.primary.lg', { type: 'button', onclick: async () => {
    backupNow.disabled = true;
    backupNow.textContent = 'Backing up…';
    try {
      const b = await api.post('/backups');
      toast(b.driveStatus === 'uploaded' ? 'Backup saved here and to Google Drive' : b.driveStatus === 'failed' ? 'Backup saved here; Drive upload failed' : 'Backup saved on this computer');
      rerender();
    } catch (e) {
      toast(e.message, 'error');
      backupNow.disabled = false;
    }
  } }, icon('shield', 20), 'Backup Now');

  body.append(h('div.card.backup-status.' + health,
    h('div.bs-icon', icon(health === 'good' ? 'check' : 'alert', 28)),
    h('div.grow',
      h('h3', health === 'good' ? 'Your data is backed up' : health === 'warn' ? 'Last backup is more than 2 days old' : 'No backup yet'),
      h('p', lastOk ? `Last successful backup: ${fmtDateTime(lastOk.at)}${lastOk.driveStatus === 'uploaded' ? ' · also on Google Drive' : ''}` : 'Make your first backup now.'),
      st.lastFailure ? h('p.small.err', `Problem on ${fmtDateTime(st.lastFailure.at)}: ${st.lastFailure.error}`) : null,
      h('p.small.muted', `Automatic backup: ${st.autoEnabled ? (st.frequency === 'daily' ? `daily after ${st.backupHour}:00` : 'every hour') : 'off'} · Google Drive: ${drive.connected ? 'connected' : 'not connected'}`)),
    backupNow));

  // Google Drive
  const driveCard = h('div.card.stack');
  if (drive.connected) {
    driveCard.append(
      h('div.card-head', h('h3', icon('cloud', 20), ' Google Drive'), h('span.badge.paid', 'Connected')),
      h('p', `Connected to ${drive.account || 'your Google account'}${drive.connectedAt ? ' since ' + fmtDateTime(drive.connectedAt) : ''}.`),
      h('p.muted.small', 'Files are organised in your Drive under “Beauty Parlour” › Backups, Reports, Receipts, Exports. The app can only see files it created.'),
      h('div.row',
        h('button.btn.ghost', { type: 'button', onclick: () => showDriveBackups(rerender) }, icon('cloud', 18), 'Restore from Drive'),
        h('button.btn.ghost.danger-text', { type: 'button', onclick: async () => {
          if (!(await confirmDialog({ title: 'Disconnect Google Drive?', message: 'Backups will only be saved on this computer until you reconnect. Files already in Drive are kept.', confirmLabel: 'Disconnect', danger: true }))) return;
          await api.post('/drive/disconnect');
          await refreshSettings();
          rerender();
        } }, 'Disconnect')));
  } else {
    const idEl = h('input.input', { placeholder: 'xxxxxxxx.apps.googleusercontent.com', autocomplete: 'off', autocapitalize: 'none' });
    const secretEl = h('input.input', { type: 'password', placeholder: drive.configured ? '•••••••• (saved)' : 'Client secret', autocomplete: 'off' });
    driveCard.append(
      h('div.card-head', h('h3', icon('cloud', 20), ' Google Drive'), h('span.badge.unpaid', 'Not connected')),
      h('p', 'Connect Google Drive to keep a copy of every backup, plus receipts, reports and exports, in your own Google account.'),
      drive.configured
        ? h('div.row', h('button.btn.primary', { type: 'button', onclick: async () => {
            try {
              const r = await api.post('/drive/connect');
              location.href = r.url;
            } catch (e) {
              toast(e.message, 'error');
            }
          } }, icon('cloud', 18), 'Connect Google Drive'))
        : '',
      h('details.more', { open: !drive.configured },
        h('summary', drive.configured ? 'Change Google app credentials' : 'One-time setup: Google app credentials'),
        h('ol.steps',
          h('li', 'Open console.cloud.google.com and create a project (free).'),
          h('li', 'Enable the “Google Drive API”.'),
          h('li', 'Under “OAuth consent screen”, choose External, add your Gmail as a test user (or publish the app).'),
          h('li', 'Under Credentials, create an “OAuth client ID” of type “Web application”.'),
          h('li', 'Add this exact Authorised redirect URI: ', h('code', drive.redirectUri)),
          h('li', 'Paste the client ID and secret below, then press Connect.')),
        h('p.small.muted', 'Google only allows http:// addresses for “localhost”, so connect from the salon Mac itself (http://localhost:3000) unless the app has an https address.'),
        drive.envCredentials ? h('p.small', 'Credentials are set by the server administrator.') : h('div.stack',
          field('Client ID', idEl), field('Client secret', secretEl),
          h('div.row', h('button.btn.soft', { type: 'button', onclick: async () => {
            try {
              await api.post('/drive/credentials', { clientId: idEl.value, clientSecret: secretEl.value });
              toast('Saved. Now press Connect Google Drive.');
              rerender();
            } catch (e) {
              toast(e.message, 'error');
            }
          } }, 'Save credentials')))));
  }
  body.append(driveCard);

  // Schedule
  const s = await api.get('/settings');
  settingsForm(body, s, (f) => [
    h('label.check', f('backup_auto_enabled', { type: 'checkbox' }), ' Back up automatically'),
    h('div.grid-2',
      field('How often', f('backup_frequency', { type: 'select', options: [['hourly', 'Every hour'], ['daily', 'Once a day']] }), 'Hourly backups are skipped when nothing has changed.'),
      field('Daily backup after', f('backup_hour', { type: 'select', options: Array.from({ length: 24 }, (_, i) => [i, `${String(i).padStart(2, '0')}:00`]) }), 'Only used for once-a-day backups.')),
    field('Days of backups to keep', f('backup_keep_local', { inputmode: 'numeric' }), 'Every backup from the last 2 days is kept, then one per day. Older automatic backups are removed here and from Google Drive.'),
  ], { title: 'Automatic backups' });

  // Export
  body.append(h('div.card.stack',
    h('h3', 'Export data'),
    h('p.muted', 'Download everything as an Excel workbook, or a single table as CSV. Opens in Excel or Numbers.'),
    h('div.row',
      h('button.btn.primary', { type: 'button', onclick: () => download('/export/all.xlsx') }, icon('download', 18), 'Export All Data'),
      drive.connected ? h('button.btn.ghost', { type: 'button', onclick: async (e) => {
        e.currentTarget.disabled = true;
        try {
          await api.post('/export/drive');
          toast('Export saved to Google Drive › Exports');
        } catch (ex) {
          toast(ex.message, 'error');
        }
        e.currentTarget.disabled = false;
      } }, icon('cloud', 18), 'Export to Drive') : null),
    h('div.chips', [['customers', 'Customers'], ['visits', 'Visits'], ['invoices', 'Invoices'], ['invoice_items', 'Invoice items'], ['payments', 'Payments'], ['services', 'Services'], ['customer_notes', 'Notes']]
      .map(([k, l]) => h('button.chip', { type: 'button', onclick: () => download(`/export/${k}.csv`) }, icon('download', 14), ' ', l)))));

  // Backup history + restore
  const fileInput = h('input', { type: 'file', accept: '.db,application/octet-stream', hidden: true, onchange: async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const ok = await confirmDialog({ title: 'Restore from this file?', message: `All current data will be replaced with the contents of “${f.name}”. A safety backup of the current data is made first.`, confirmLabel: 'Restore', danger: true, typeWord: 'RESTORE' });
    if (!ok) return;
    try {
      const r = await api.post('/backups/restore-upload', f, { 'X-Confirm': 'RESTORE', 'X-Filename': encodeURIComponent(f.name), 'Content-Type': 'application/octet-stream' });
      restored(r);
    } catch (ex) {
      toast(ex.message, 'error');
    }
  } });
  body.append(h('div.card.stack',
    h('div.card-head', h('h3', 'Backup history'), h('button.btn.ghost.sm', { type: 'button', onclick: () => fileInput.click() }, icon('upload', 16), 'Restore from a file')),
    fileInput,
    h('p.muted.small', `Backup files are stored in: ${st.folder}`),
    data.backups.length
      ? h('div.table-scroll', h('table.table',
          h('thead', h('tr', h('th', 'Date'), h('th', 'Type'), h('th.hide-sm', 'Size'), h('th', 'Google Drive'), h('th', ''))),
          h('tbody', data.backups.map((b) => h('tr',
            h('td', fmtDateTime(b.createdAt), b.status === 'failed' ? h('div.small.err', b.error) : null),
            h('td', { manual: 'Manual', auto: 'Automatic', 'pre-restore': 'Safety copy' }[b.kind]),
            h('td.hide-sm', b.sizeBytes ? (b.sizeBytes / 1024 / 1024).toFixed(2) + ' MB' : '—'),
            h('td', b.driveStatus === 'uploaded' ? h('span.badge.paid', 'Uploaded') : b.driveStatus === 'failed' ? h('span.badge.unpaid', 'Failed') : h('span.muted', '—')),
            h('td.actions', b.onDisk ? [
              h('button.btn.ghost.sm', { type: 'button', onclick: () => download(`/backups/${b.id}/download`) }, icon('download', 16)),
              h('button.btn.ghost.sm', { type: 'button', onclick: async () => {
                const ok = await confirmDialog({ title: 'Restore this backup?', message: `All current data will be replaced with the backup from ${fmtDateTime(b.createdAt)}. A safety backup of the current data is made first, so this can be undone.`, confirmLabel: 'Restore', danger: true, typeWord: 'RESTORE' });
                if (!ok) return;
                try {
                  restored(await api.post(`/backups/${b.id}/restore`, { confirm: 'RESTORE' }));
                } catch (ex) {
                  toast(ex.message, 'error');
                }
              } }, 'Restore'),
              h('button.btn.ghost.sm.danger-text', { type: 'button', 'aria-label': 'Delete backup', onclick: async () => {
                const ok = await confirmDialog({ title: 'Delete this backup file?', message: 'This removes the file from this computer. Copies in Google Drive are not affected.', confirmLabel: 'Delete', danger: true, typeWord: 'DELETE' });
                if (!ok) return;
                try {
                  await api.post(`/backups/${b.id}/delete`, { confirm: 'DELETE' });
                  rerender();
                } catch (ex) {
                  toast(ex.message, 'error');
                }
              } }, icon('trash', 16)),
            ] : h('span.muted.small', b.status === 'success' ? 'removed' : '')))))))
      : h('p.muted', 'No backups yet.')));
}

function restored(r) {
  modal({
    title: 'Restore complete',
    body: h('div.stack',
      h('p', `Data restored from ${r.restored}. It contains ${r.counts.customers} customers and ${r.counts.invoices} invoices.`),
      h('p.muted.small', `Your previous data was saved as ${r.safetyBackup}.`)),
    actions: [h('button.btn.primary', { type: 'button', onclick: () => location.reload() }, 'Reload app')],
  });
}

async function showDriveBackups(rerender) {
  const list = h('div', spinner());
  const m = modal({ title: 'Backups in Google Drive', body: list, wide: true });
  try {
    const files = await api.get('/drive/backups');
    clear(list, files.length
      ? h('div.list', files.map((f) => h('div.list-row',
          h('span.grow', h('strong', f.name), h('span.muted.small.block', `${fmtDateTime(f.createdTime)} · ${(Number(f.size || 0) / 1024 / 1024).toFixed(2)} MB`)),
          h('button.btn.soft.sm', { type: 'button', onclick: async () => {
            const ok = await confirmDialog({ title: 'Restore from Google Drive?', message: `All current data will be replaced with “${f.name}”. A safety backup is made first.`, confirmLabel: 'Restore', danger: true, typeWord: 'RESTORE' });
            if (!ok) return;
            try {
              m.close();
              restored(await api.post(`/drive/backups/${encodeURIComponent(f.id)}/restore`, { confirm: 'RESTORE' }));
            } catch (ex) {
              toast(ex.message, 'error');
            }
          } }, 'Restore'))))
      : h('p.muted', 'No backups found in Google Drive yet.'));
  } catch (e) {
    clear(list, h('p.form-error', e.message));
  }
  void rerender;
}

async function users(body, { rerender }) {
  const list = await api.get('/users');
  clear(body);
  const userModal = (u) => {
    const els = {
      displayName: h('input.input', { value: u?.displayName || '', autocapitalize: 'words' }),
      username: h('input.input', { value: u?.username || '', autocapitalize: 'none', disabled: !!u, autocomplete: 'off' }),
      role: h('select.input', [['staff', 'Staff'], ['owner', 'Owner']].map(([v, l]) => h('option', { value: v, selected: (u?.role || 'staff') === v }, l))),
      password: h('input.input', { type: 'password', autocomplete: 'new-password', placeholder: u ? 'Leave blank to keep current password' : 'At least 8 characters' }),
      active: h('input', { type: 'checkbox', checked: u ? !!u.active : true }),
    };
    const err = h('p.form-error');
    const m = modal({
      title: u ? 'Edit account' : 'New staff account',
      body: h('div.stack',
        h('div.grid-2', field('Name', els.displayName), field('Username', els.username)),
        h('div.grid-2', field('Role', els.role, 'Staff: customers, check-in, billing. Owner: everything.'), field(u ? 'Reset password' : 'Password', els.password)),
        u ? h('label.check', els.active, ' Account active (can sign in)') : null,
        err),
      actions: [h('button.btn.ghost', { type: 'button', onclick: () => m.close() }, 'Cancel'), h('button.btn.primary', { type: 'button', onclick: async () => {
        try {
          if (u) await api.put('/users/' + u.id, { displayName: els.displayName.value, role: els.role.value, active: els.active.checked, password: els.password.value || undefined });
          else await api.post('/users', { displayName: els.displayName.value, username: els.username.value, role: els.role.value, password: els.password.value });
          m.close();
          toast('Saved');
          rerender();
        } catch (e) {
          err.textContent = e.message;
        }
      } }, 'Save')],
    });
  };
  body.append(h('div.card.stack',
    h('div.card-head', h('h3', 'Accounts'), h('button.btn.primary.sm', { type: 'button', onclick: () => userModal() }, icon('userPlus', 16), 'Add staff')),
    h('p.muted.small', 'Give each person their own login so the audit log shows who did what.'),
    h('div.list', list.map((u) => h('div.list-row',
      h('span.grow', h('strong', u.displayName), h('span.muted.small.block', `@${u.username} · ${u.role === 'owner' ? 'Owner' : 'Staff'}${u.lastLoginAt ? ' · last sign-in ' + fmtDateTime(u.lastLoginAt) : ''}`)),
      u.active ? null : h('span.badge.inactive', 'Disabled'),
      h('button.btn.ghost.sm', { type: 'button', onclick: () => userModal(u) }, icon('edit', 16), 'Edit'))))));
}

async function appointments(body, { query, rerender }) {
  const [s, cal] = await Promise.all([api.get('/settings'), api.get('/calendar/status')]);
  clear(body);
  if (query.get('calendar') === 'connected') toast('Google Calendar connected');
  if (query.get('calendar') === 'error') toast(query.get('message') || 'Google Calendar connection failed', 'error');

  const connect = async (e) => {
    e.currentTarget.disabled = true;
    try {
      const r = await api.post('/calendar/connect', { email: emailEl?.value || '' });
      location.href = r.url;
    } catch (ex) {
      toast(ex.message, 'error');
      e.currentTarget.disabled = false;
    }
  };
  let emailEl = null;
  const card = h('div.card.stack');
  if (cal.connected) {
    const picker = h('select.input', h('option', { value: cal.calendarId }, cal.calendarName || 'Main calendar'));
    api.get('/calendar/calendars').then((list) => {
      clear(picker, list.map((c) => h('option', { value: c.primary ? 'primary' : c.id, selected: (c.primary ? 'primary' : c.id) === cal.calendarId }, c.name + (c.primary ? ' (main)' : ''))));
    }).catch((ex) => toast(ex.message, 'error'));
    const savePick = h('button.btn.soft', { type: 'button', onclick: async () => {
      savePick.disabled = true;
      try {
        const r = await api.put('/calendar/calendar', { id: picker.value });
        toast(`Bookings now go to “${r.name}”`);
        rerender();
      } catch (ex) {
        toast(ex.message, 'error');
        savePick.disabled = false;
      }
    } }, 'Use this calendar');
    card.append(
      h('div.card-head', h('h3', icon('calendar', 20), ' Google Calendar'), h('span.badge.paid', 'Connected')),
      h('p', `Bookings are added to ${cal.account || 'your Google account'}${cal.connectedAt ? ' (connected ' + fmtDateTime(cal.connectedAt) + ')' : ''}.`),
      h('div.row', field('Calendar', picker, 'Upcoming bookings move across when you change it.'), savePick),
      cal.failed ? h('div.alert.warn', icon('alert', 18), `${cal.failed} booking${cal.failed > 1 ? 's are' : ' is'} not in Google Calendar yet. ${cal.lastError || ''}`) : '',
      h('p.muted.small', 'Bookings made, moved or cancelled here are copied to the calendar. Changes made in Google Calendar are not copied back, so make changes in this app.'),
      h('div.row',
        h('button.btn.ghost', { type: 'button', onclick: async (e) => {
          e.currentTarget.disabled = true;
          try {
            const r = await api.post('/calendar/sync');
            toast(r.failed ? `${r.failed} could not be copied` : 'Google Calendar is up to date', r.failed ? 'error' : 'ok');
          } catch (ex) {
            toast(ex.message, 'error');
          }
          rerender();
        } }, icon('repeat', 18), 'Sync now'),
        h('button.btn.ghost', { type: 'button', onclick: connect }, icon('user', 18), 'Use a different Google account'),
        h('button.btn.ghost.danger-text', { type: 'button', onclick: async () => {
          if (!(await confirmDialog({ title: 'Disconnect Google Calendar?', message: 'Upcoming bookings are taken out of the calendar. They stay in this app.', confirmLabel: 'Disconnect', danger: true }))) return;
          await api.post('/calendar/disconnect');
          toast('Google Calendar disconnected');
          rerender();
        } }, 'Disconnect')));
  } else {
    emailEl = h('input.input', { type: 'email', value: s.business_email || '', placeholder: 'you@gmail.com', autocapitalize: 'none' });
    card.append(
      h('div.card-head', h('h3', icon('calendar', 20), ' Google Calendar'), h('span.badge.unpaid', 'Not connected')),
      h('p', 'Connect a Google account and every booking appears in its calendar, on your phone too.'),
      cal.configured
        ? h('div.stack',
            field('Google account to use', emailEl, 'Google will ask you to sign in and allow access. You can change the account later.'),
            h('div.row', h('button.btn.primary', { type: 'button', onclick: connect }, icon('calendar', 18), 'Connect Google Calendar')),
            h('details.more',
              h('summary', 'If Google says the app is blocked or not verified'),
              h('ol.small',
                h('li', 'In console.cloud.google.com, open the same project used for Drive backups.'),
                h('li', 'APIs & Services › Library: enable “Google Calendar API”.'),
                h('li', 'OAuth consent screen › Test users: add the Google account above.'),
                h('li', 'On the “Google hasn’t verified this app” screen, choose Continue.'))))
        : h('div.alert.note', icon('note', 18), h('div', 'First set up the Google app once in ', h('a', { href: '#/settings/backup' }, 'Backup & Data › Google Drive'), '. The calendar uses the same Google app.')));
  }
  body.append(card);

  const emailReady = s.email_configured === '1';
  settingsForm(body, s, (f) => [
    emailReady ? null : h('div.alert.warn', icon('alert', 18), h('div', 'Customer emails need your mailbox set up first in ', h('a', { href: '#/settings/email' }, 'Settings › Email'), '.')),
    h('label.check', f('appt_confirm_email', { type: 'checkbox' }), ' Email customers a confirmation when they are booked'),
    h('div.grid-2',
      h('label.check.pad-top', f('appt_reminder_email', { type: 'checkbox' }), ' Email customers a reminder before their appointment'),
      field('Send the reminder', f('appt_reminder_hours', { type: 'select', options: [[2, '2 hours before'], [4, '4 hours before'], [12, '12 hours before'], [24, '1 day before'], [48, '2 days before']] }))),
    field('Default appointment length (minutes)', f('appt_default_minutes', { inputmode: 'numeric' }), 'Used when the chosen services have no length set.'),
  ], { title: 'Customer emails', intro: 'Only customers with an email address on file get these. You can untick the box on any booking. Customers can tap Confirm, Change time or Cancel, which sends a reply to your salon email (Settings › Business), and add the booking to their own calendar.' });
  if (emailReady) {
    const to = h('input.input', { type: 'email', value: s.business_email || '', placeholder: 'you@gmail.com' });
    body.append(h('div.card.row', field('See what customers get: send a sample to', to), h('button.btn.soft', { type: 'button', onclick: async (e) => {
      e.currentTarget.disabled = true;
      try {
        await api.post('/appointments/sample-email', { to: to.value });
        toast('Sample sent to ' + to.value);
      } catch (ex) {
        toast(ex.message, 'error');
      }
      e.currentTarget.disabled = false;
    } }, icon('mail', 18), 'Send sample')));
  }
}

async function email(body) {
  const s = await api.get('/settings');
  clear(body);
  settingsForm(body, s, (f) => [
    h('div.grid-2', field('SMTP server', f('smtp_host', { placeholder: 'smtp.gmail.com' })), field('Port', f('smtp_port', { inputmode: 'numeric', placeholder: '587' }))),
    h('div.grid-2', field('Username', f('smtp_user', { placeholder: 'yoursalon@gmail.com' })), field('Password / app password', f('smtp_pass', { inputType: 'password', placeholder: s.smtp_pass_set === '1' ? '•••••••• (saved)' : '' }))),
    field('From address (optional)', f('smtp_from', { placeholder: 'Same as username' })),
  ], { title: 'Email receipts', intro: 'Receipts are sent from your own mailbox. For Gmail, turn on 2-Step Verification and create an “App password” at myaccount.google.com/apppasswords, then use smtp.gmail.com, port 587.' });
  const to = h('input.input', { type: 'email', placeholder: 'you@example.com', value: s.business_email || '' });
  body.append(h('div.card.row', field('Send a test email to', to), h('button.btn.soft', { type: 'button', onclick: async () => {
    try {
      await api.post('/settings/test-email', { to: to.value });
      toast('Test email sent');
    } catch (e) {
      toast(e.message, 'error');
    }
  } }, icon('mail', 18), 'Send test')));
}

const ACTION_LABELS = {
  'customer.created': 'Customer created', 'customer.updated': 'Customer updated', 'customer.note_added': 'Note added',
  'visit.created': 'Visit created', 'visit.notes_updated': 'Visit note edited', 'invoice.created': 'Invoice created', 'invoice.voided': 'Invoice voided',
  'invoice.emailed': 'Receipt emailed', 'payment.recorded': 'Payment recorded', 'service.price_changed': 'Service price changed',
  'service.created': 'Service created', 'service.updated': 'Service updated', 'category.created': 'Category created', 'category.updated': 'Category updated',
  'user.created': 'User created', 'user.updated': 'User updated', 'user.password_changed': 'Password changed', 'auth.login': 'Signed in', 'auth.login_required': 'Sign-in setting changed', 'auth.login_failed': 'Failed sign-in',
  'settings.updated': 'Settings changed', 'settings.tax_changed': 'Tax settings changed', 'backup.created': 'Backup created', 'backup.restored': 'Backup restored',
  'backup.deleted': 'Backup deleted', 'backup.downloaded': 'Backup downloaded', 'data.exported': 'Data exported', 'drive.connected': 'Google Drive connected', 'drive.disconnected': 'Google Drive disconnected',
  'appointment.booked': 'Appointment booked', 'appointment.rescheduled': 'Appointment moved', 'appointment.updated': 'Appointment changed',
  'appointment.cancelled': 'Appointment cancelled', 'appointment.confirmed': 'Appointment confirmed', 'appointment.completed': 'Appointment completed',
  'appointment.no_show': 'Appointment no-show', 'calendar.connected': 'Google Calendar connected',
  'calendar.disconnected': 'Google Calendar disconnected', 'calendar.changed': 'Calendar changed',
};

function describe(a) {
  const d = a.details || {};
  if (a.action === 'service.price_changed') return `${d.name}: ${money(d.fromCents)} → ${money(d.toCents)}`;
  if (d.invoiceNumber) return d.invoiceNumber + (d.amountCents ? ` · ${money(d.amountCents)}` : d.totalCents ? ` · ${money(d.totalCents)}` : '') + (d.reason ? ` · ${d.reason}` : '');
  if (d.customerCode) return d.customerCode;
  if (d.filename) return d.filename;
  if (d.changed) return Array.isArray(d.changed) ? d.changed.join(', ') : '';
  const keys = Object.keys(d).filter((k) => !['firstRun'].includes(k));
  return keys.slice(0, 4).map((k) => `${k}: ${typeof d[k] === 'object' ? JSON.stringify(d[k]) : d[k]}`).join(' · ');
}

async function audit(body) {
  let offset = 0;
  const tbody = h('tbody');
  const more = h('div.center');
  const load = async () => {
    const rows = await api.get(`/audit?limit=100&offset=${offset}`);
    tbody.append(...rows.map((a) => h('tr',
      h('td', fmtDateTime(a.createdAt)),
      h('td', a.username || '—'),
      h('td', ACTION_LABELS[a.action] || a.action),
      h('td.small', describe(a)))));
    offset += rows.length;
    clear(more, rows.length === 100 ? h('button.btn.ghost', { type: 'button', onclick: load }, 'Show more') : null);
  };
  clear(body, h('div.card.stack',
    h('h3', 'Audit log'),
    h('p.muted.small', 'A permanent record of important actions. It cannot be edited or deleted.'),
    h('div.table-scroll', h('table.table', h('thead', h('tr', h('th', 'When'), h('th', 'Who'), h('th', 'Action'), h('th', 'Details'))), tbody)),
    more));
  await load();
}

async function account(body) {
  clear(body);
  if (session.user.openAccess) return body.append(signInCard());
  const cur = h('input.input', { type: 'password', autocomplete: 'current-password' });
  const next = h('input.input', { type: 'password', autocomplete: 'new-password' });
  body.append(h('form.card.stack', {
    onsubmit: async (e) => {
      e.preventDefault();
      try {
        await api.post('/auth/password', { currentPassword: cur.value, newPassword: next.value });
        toast('Password changed');
        cur.value = next.value = '';
      } catch (ex) {
        toast(ex.message, 'error');
      }
    },
  },
  h('h3', `Signed in as ${session.user.displayName}`),
  h('p.muted', `Username: ${session.user.username} · ${session.user.role === 'owner' ? 'Owner' : 'Staff'}`),
  h('div.grid-2', field('Current password', cur), field('New password', next, 'At least 8 characters.')),
  h('div.row.end', h('button.btn.primary', { type: 'submit' }, 'Change password'))));
  if (session.isOwner) body.append(signInCard());
}

// The sign-in screen is off by default so the app opens straight away.
function signInCard() {
  if (!session.user.openAccess) {
    return h('div.card.stack',
      h('h3', 'Sign-in screen is on'),
      h('p.muted', 'Everyone must sign in with a username and password. Turning it off lets anyone who opens the app use it as the owner.'),
      h('div.row.end', h('button.btn.ghost', {
        type: 'button',
        onclick: async () => {
          if (!(await confirmDialog({ title: 'Turn off the sign-in screen?', message: 'Anyone on your Wi-Fi who opens the app will have full owner access.', confirmLabel: 'Turn off', danger: true }))) return;
          try {
            await api.post('/auth/require-login', { enabled: false });
            await api.post('/auth/logout');
            location.reload();
          } catch (ex) {
            toast(ex.message, 'error');
          }
        },
      }, 'Turn off sign-in')));
  }
  const username = h('input.input', { value: session.user.username, autocomplete: 'username', autocapitalize: 'none', required: true });
  const password = h('input.input', { type: 'password', autocomplete: 'new-password', required: true, minlength: 8 });
  return h('form.card.stack', {
    onsubmit: async (e) => {
      e.preventDefault();
      try {
        await api.post('/auth/require-login', { enabled: true, username: username.value, password: password.value });
        toast('Sign-in turned on. Use this username and password from now on.');
        location.reload();
      } catch (ex) {
        toast(ex.message, 'error');
      }
    },
  },
  h('h3', 'No sign-in needed'),
  h('p.muted', 'The app opens straight away as the owner. Anyone on your Wi-Fi who opens it gets full access. To protect it with a password, choose one below.'),
  h('div.grid-2', field('Username', username), field('Password', password, 'At least 8 characters.')),
  h('div.row.end', h('button.btn.primary', { type: 'submit' }, 'Turn on sign-in')));
}

// One-time steps so the iPad keeps working when the salon computer is off.
async function ipad(body) {
  const info = await api.get('/offline/setup');
  const httpPort = location.protocol === 'http:' ? location.port || '80' : '3000';
  const certUrl = `http://${info.host}:${httpPort}/salon-certificate.crt`;
  const secureUrl = info.https ? `https://${info.host}:${info.https.port}` : null;
  const here = window.isSecureContext && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1';
  clear(body,
    h('div.card.stack',
      h('h3', 'Keep working when the salon computer is off'),
      h('p.muted', 'If the computer is asleep or off, the iPad still checks customers in and takes payment. Everything is saved on the iPad and sent to the computer when it’s back. Customer IDs and receipt numbers are given when it syncs.'),
      here ? h('div.alert.ok', icon('check', 18), 'This device is set up: it keeps a copy of the app for offline use.') : null),
    !secureUrl
      ? h('div.card.stack', h('h3', 'Secure address not available'), h('p.muted', 'This computer couldn’t create its security certificate, so the iPad can’t keep an offline copy of the app. Offline mode still works while the app stays open on the iPad.'))
      : h('div.card.stack',
          h('h3', 'One-time iPad setup (about 2 minutes)'),
          h('ol.steps',
            h('li', 'On the iPad, open Safari and go to ', h('code', certUrl), '. Tap Allow, then Close.'),
            h('li', 'Open the Settings app. Tap “Profile Downloaded” near the top (or General › VPN & Device Management › Salon Manager), then Install and enter the iPad passcode.'),
            h('li', 'In Settings, go to General › About › Certificate Trust Settings and turn on “Salon Manager”.'),
            h('li', 'Back in Safari, open ', h('code', secureUrl), '. Tap Share › Add to Home Screen. Use this new icon from now on and delete the old one.')),
          h('p.muted.small', `If the .local name doesn’t load, use the number address instead: ${info.ips.map((ip) => `https://${ip}:${info.https.port}`).join(' or ')}. Offline entries are kept separately for each address, so stick to one.`)));
}

import { h, clear, icon, money, barChart, spinner, todayYmd, toast, emptyState } from '../ui.js';
import { api, download } from '../api.js';
import { session, navigate } from '../app.js';
import { pageHeader } from './shared.js';

const TABS = [
  ['sales', 'Sales'],
  ['customers', 'Customers'],
  ['services', 'Services'],
  ['payments', 'Payments'],
  ['staff', 'Staff'],
  ['spending', 'Customer spending'],
];

function shift(ymd, days) {
  const d = new Date(ymd + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function presets() {
  const t = todayYmd();
  const dow = (new Date(t + 'T12:00:00Z').getUTCDay() + 6) % 7;
  const monthStart = t.slice(0, 8) + '01';
  const lastMonthEnd = shift(monthStart, -1);
  return [
    ['today', 'Today', t, t],
    ['week', 'This week', shift(t, -dow), t],
    ['month', 'This month', monthStart, t],
    ['lastmonth', 'Last month', lastMonthEnd.slice(0, 8) + '01', lastMonthEnd],
    ['year', 'This year', t.slice(0, 5) + '01-01', t],
    ['30', 'Last 30 days', shift(t, -29), t],
  ];
}

const fmt = (v, type) => {
  if (v == null) return '—';
  if (type === 'money') return money(v);
  if (type === 'pct') return (v * 100).toFixed(1) + '%';
  if (type === 'int') return Number(v).toLocaleString('en-CA');
  return String(v);
};

export async function render(view, { params }) {
  if (!session.can('reports.view')) return navigate('dashboard');
  const type = TABS.some(([k]) => k === params[0]) ? params[0] : 'sales';
  const P = presets();
  const state = { preset: 'month', from: P[2][2], to: P[2][3], group: 'day' };
  const out = h('div.stack');
  const fromEl = h('input.input.sm', { type: 'date', value: state.from, 'aria-label': 'From' });
  const toEl = h('input.input.sm', { type: 'date', value: state.to, 'aria-label': 'To' });
  const presetChips = h('div.chips', P.map(([k, label, f, t]) => h('button.chip' + (k === state.preset ? '.on' : ''), { type: 'button', onclick: (e) => {
    state.preset = k;
    state.from = f;
    state.to = t;
    fromEl.value = f;
    toEl.value = t;
    presetChips.querySelectorAll('.chip').forEach((c) => c.classList.remove('on'));
    e.currentTarget.classList.add('on');
    load();
  } }, label)));
  const onDate = () => {
    state.from = fromEl.value;
    state.to = toEl.value;
    presetChips.querySelectorAll('.chip').forEach((c) => c.classList.remove('on'));
    load();
  };
  fromEl.addEventListener('change', onDate);
  toEl.addEventListener('change', onDate);
  const groupSel = type === 'sales'
    ? h('select.input.sm', { 'aria-label': 'Group by', onchange: (e) => { state.group = e.target.value; load(); } }, [['day', 'Daily'], ['week', 'Weekly'], ['month', 'Monthly'], ['year', 'Yearly']].map(([v, l]) => h('option', { value: v }, l)))
    : null;

  const qs = () => new URLSearchParams({ from: state.from, to: state.to, group: state.group }).toString();

  async function load() {
    clear(out, spinner());
    let r;
    try {
      r = await api.get(`/reports/${type}?${qs()}`);
    } catch (e) {
      return clear(out, h('p.form-error', e.message));
    }
    const chartData = r.chart ? r.rows.slice(0, r.chart.limit || 40).map((row) => ({ label: row[r.chart.labelKey], value: row[r.chart.valueKey] || 0 })) : [];
    clear(out,
      h('div.stat-grid.compact', r.summary.map((s) => h('div.stat-card', h('div.stat-label', s.label), h('div.stat-value.sm', fmt(s.value, s.type))))),
      chartData.length && chartData.some((d) => d.value)
        ? h('section.card', barChart(chartData, { format: (v) => fmt(v, r.chart.type), labelEvery: Math.ceil(chartData.length / 12) }))
        : null,
      h('section.card.table-card',
        r.rows.length
          ? h('div.table-scroll', h('table.table',
              h('thead', h('tr', r.columns.map((c) => h('th' + (c.type === 'text' ? '' : '.num'), c.label)))),
              h('tbody', r.rows.map((row) => h('tr', r.columns.map((c) => h('td' + (c.type === 'text' ? '' : '.num'), fmt(row[c.key], c.type))))))))
          : emptyState('chart', 'No data for this period', 'Try a longer date range.')));
  }

  clear(view,
    pageHeader('Reports', 'Sales, customers, services and payments.',
      h('button.btn.ghost', { type: 'button', onclick: () => download(`/reports/${type}?${qs()}&format=csv`) }, icon('download', 18), 'CSV'),
      h('button.btn.ghost', { type: 'button', onclick: () => download(`/reports/${type}?${qs()}&format=pdf`) }, icon('download', 18), 'PDF'),
      session.settings.drive_refresh_token_set === '1'
        ? h('button.btn.ghost', { type: 'button', onclick: async (e) => {
            e.currentTarget.disabled = true;
            try {
              await api.post(`/reports/${type}/drive`, { from: state.from, to: state.to, group: state.group });
              toast('Saved to Google Drive › Reports');
            } catch (ex) {
              toast(ex.message, 'error');
            }
            e.currentTarget.disabled = false;
          } }, icon('cloud', 18), 'Save to Drive')
        : null),
    h('div.tabs', TABS.map(([k, l]) => h('a.tab' + (k === type ? '.on' : ''), { href: '#/reports/' + k }, l))),
    h('div.toolbar', presetChips, h('div.toolbar-right', fromEl, h('span.muted', 'to'), toEl, groupSel)),
    out);
  await load();
}

import { sanitizeBrief, exportBrief, compareSummaries, COMPARISON_REASONS, RULES, finite } from './model.js';
import { loadReadState, setReadState, isRead, filterAlerts } from './inbox.js';

const sessions = new WeakMap();
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (value) => finite(value) === null ? 'Unavailable' : value.toLocaleString('en-US', { maximumFractionDigits: 2 });
const money = (value, currency, demo) => {
  if (finite(value) === null) return 'Unavailable';
  if (!currency) return num(value) + ' (currency unknown)';
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency, currencyDisplay: 'code', maximumFractionDigits: demo ? 0 : 2 }).format(value); }
  catch { return currency + ' ' + num(value); }
};
const when = (value, ctx) => value ? ctx.fmt?.datetime?.(value) || value : 'Time unavailable';

function download(ctx, block) {
  const doc = ctx.root?.ownerDocument;
  const urls = doc?.defaultView?.URL || globalThis.URL;
  if (!doc?.createElement || !urls?.createObjectURL || typeof Blob !== 'function') return;
  const blob = new Blob([JSON.stringify(exportBrief(block, ctx.demo), null, 2)], { type: 'application/json' });
  const url = urls.createObjectURL(blob);
  const link = doc.createElement('a');
  link.href = url;
  link.download = 'daily-brief-' + (ctx.demo ? 'demo-' : '') + (block.checkedAt?.slice(0, 10) || 'snapshot') + '.json';
  link.hidden = true;
  doc.body?.appendChild(link);
  link.click();
  link.remove?.();
  setTimeout(() => urls.revokeObjectURL(url), 1000);
}

function comparisonHtml(comparison, currency, demo) {
  const reason = COMPARISON_REASONS[comparison.reason] || COMPARISON_REASONS.context_unknown;
  if (!comparison.comparable) return '<span class="brief-muted">' + esc(reason) + '</span>';
  const changes = comparison.changes || {};
  return '<span>' + esc(reason) + '</span><dl class="brief-diff">' +
    [['totalRevenue', 'Revenue incl rebills'], ['cost', 'Spend'], ['calls', 'Calls'], ['sales', 'Sales']].map(([key, label]) => {
      const change = changes[key];
      const value = change ? (key === 'cost' || key === 'totalRevenue' ? money(change.delta, currency, demo) : num(change.delta)) : 'Unavailable';
      return '<div><dt>' + label + '</dt><dd>' + esc(value) + (finite(change?.percent) === null ? '' : ' / ' + esc(num(change.percent)) + '%') + '</dd></div>';
    }).join('') + '</dl>';
}

function coverageHtml(coverage) {
  return ['report', 'tracking', 'crm', 'attribution'].map((key) => {
    const state = coverage?.[key] || 'missing';
    return '<span class="brief-coverage-item">' + esc(key === 'crm' ? 'CRM' : key) + ' <b class="' + (state === 'complete' ? 'good' : '') + '">' + esc(state) + '</b></span>';
  }).join('');
}

export function render(ctx) {
  const root = ctx.root;
  if (!root || typeof root !== 'object') return;
  const block = !ctx.demo && ctx.block?.demo ? null : ctx.block;
  const safe = sanitizeBrief(block);
  const account = ctx.account;
  const identity = (ctx.demo ? 'demo' : account || 'none');
  const previous = sessions.get(root);
  const state = previous?.identity === identity ? previous : { identity, tab: 'inbox', severity: 'all', status: 'all', notice: '' };
  sessions.set(root, state);
  const find = (selector) => typeof root.querySelector === 'function' ? root.querySelector(selector) : null;
  const all = (selector) => typeof root.querySelectorAll === 'function' ? Array.from(root.querySelectorAll(selector) || []) : [];
  const readState = loadReadState(account, ctx.demo);
  const visible = filterAlerts(safe.alerts, readState, state);
  const unread = safe.alerts.filter((alert) => !isRead(alert, readState)).length;
  const current = safe.current;
  const status = !block ? 'No daily brief in this snapshot. Refresh to compute it.'
    : block.stale ? 'Showing the previous brief: ' + when(safe.checkedAt, ctx) + '.'
      : block.error ? 'The daily brief is unavailable for this refresh.'
        : block.skipped ? 'Brief skipped; nothing computed yet. Refresh to retry.'
          : current ? 'Snapshot: ' + when(current.generatedAt, ctx) : 'No summary has been computed.';
  const selected = (name, value) => state[name] === value ? ' selected' : '';
  const inbox = '<div class="brief-inbox-head"><h3>Alert Inbox</h3><span class="brief-muted">' + unread + ' unread / ' + safe.newIssues + ' new findings</span></div>' +
    '<div class="brief-filters"><label>Severity<select data-brief-severity>' +
    [['all', 'All severities'], ['high', 'High'], ['warning', 'Warning']].map(([key, label]) => '<option value="' + key + '"' + selected('severity', key) + '>' + label + '</option>').join('') +
    '</select></label><label>Status<select data-brief-status>' +
    [['all', 'All alerts'], ['unread', 'Unread'], ['read', 'Read']].map(([key, label]) => '<option value="' + key + '"' + selected('status', key) + '>' + label + '</option>').join('') +
    '</select></label></div><div class="brief-alerts">' + visible.map((alert) => {
      const rule = RULES[alert.rule], read = isRead(alert, readState);
      return '<article class="brief-alert' + (read ? ' brief-read' : '') + '">' +
        '<div class="brief-alert-state"><span class="pill ' + (alert.severity === 'high' ? 'bad' : 'warn') + '">' + esc(alert.severity) + '</span><span class="brief-muted">' + esc(alert.change) + '</span></div>' +
        '<div class="brief-alert-body"><h4>' + esc(rule.title) + '</h4><p>' + esc(rule.message) + '</p>' +
        '<details><summary>Evidence</summary><dl class="brief-evidence">' + Object.entries(alert.evidence).map(([key, value]) => '<div><dt>' + esc(key) + '</dt><dd>' + esc(num(value)) + '</dd></div>').join('') +
        '<div><dt>First observed</dt><dd>' + esc(when(alert.firstSeenAt, ctx)) + '</dd></div><div><dt>Last observed</dt><dd>' + esc(when(alert.lastSeenAt, ctx)) + '</dd></div>' +
        '<div><dt>Reference</dt><dd>' + esc(alert.id) + '</dd></div></dl></details></div>' +
        '<div class="brief-alert-actions"><button type="button" data-brief-review="' + esc(alert.rule) + '">Review</button>' +
        '<label><input type="checkbox" data-brief-read="' + esc(alert.id) + '"' + (read ? ' checked' : '') + (!account && !ctx.demo ? ' disabled' : '') + '>Read</label></div></article>';
    }).join('') + (visible.length ? '' : '<p class="brief-empty">' + (safe.alerts.length ? 'No alerts match these filters.' : current ? 'No rule-based findings in the available summary. This does not establish complete tracking coverage.' : 'No alert summary is available.') + '</p>') + '</div>' +
    (safe.alertsTruncated ? '<p class="brief-muted">Showing ' + safe.alerts.length + ' of ' + safe.alertCount + ' findings. Additional findings are omitted.</p>' : '') +
    '<p class="brief-muted">Read marks are stored in this browser for this account. A read mark does not resolve a tracking issue.</p>';
  const history = '<div class="brief-inbox-head"><h3>Snapshot History</h3><span class="brief-muted">' + safe.history.length + ' / 14 retained</span></div>' +
    '<div class="brief-history-wrap"><table class="brief-history"><caption class="brief-sr-only">Retained 7-day snapshot summaries</caption><thead><tr>' +
    ['Snapshot', 'Report window', 'Currency / model', 'Revenue incl rebills', 'Spend', 'Calls / sales', 'Coverage / revision'].map((name) => '<th scope="col">' + name + '</th>').join('') + '</tr></thead><tbody>' +
    safe.history.map((entry, index) => {
      const comparison = compareSummaries(entry, safe.history[index + 1]);
      return '<tr><td data-label="Snapshot">' + esc(when(entry.generatedAt, ctx)) + '</td><td data-label="Report window"><span>' + esc(entry.window.start || '?') + '<br>' + esc(entry.window.end || '?') +
        '</span></td><td data-label="Currency / model"><span>' + esc(entry.currency || 'Unknown') + '<br>' + esc(entry.model || 'Unknown') +
        '</span></td><td data-label="Revenue incl rebills">' + esc(money(entry.totalRevenue, entry.currency, ctx.demo)) + '</td><td data-label="Spend">' + esc(money(entry.cost, entry.currency, ctx.demo)) +
        '</td><td data-label="Calls / sales">' + esc(num(entry.calls)) + ' / ' + esc(num(entry.sales)) + '</td><td data-label="Coverage / revision"><span>' + esc(entry.coverage.report) +
        '</span><details><summary>' + esc(COMPARISON_REASONS[comparison.reason]) + '</summary>' + comparisonHtml(comparison, entry.currency, ctx.demo) +
        '<p class="brief-muted">Previous snapshot: ' + esc(when(comparison.previousGeneratedAt, ctx)) + '</p><pre>' + esc(JSON.stringify(entry.coverage, null, 2)) + '</pre></details></td></tr>';
    }).join('') + (safe.history.length ? '' : '<tr><td colspan="7" class="brief-empty">No retained snapshots.</td></tr>') + '</tbody></table></div>';
  root.innerHTML = '<div class="brief"><header class="brief-header"><h2>Daily Brief</h2><button type="button" data-brief-export' + (!current ? ' disabled' : '') + '><span aria-hidden="true">&darr;</span> JSON</button></header>' +
    '<p class="brief-status" role="status">' + esc(status) + (ctx.demo ? ' <span class="pill warn">Demo</span>' : '') + '</p>' +
    '<p class="brief-context">7-day window: ' + esc(current?.window?.start || '?') + ' / ' + esc(current?.window?.end || '?') + ' / ' + esc(current?.currency || 'Currency unknown') + ' / ' + esc(current?.model || 'Model unknown') + '</p>' +
    '<dl class="brief-metrics">' + [['Revenue incl rebills', money(current?.totalRevenue, current?.currency, ctx.demo)], ['Ad spend', money(current?.cost, current?.currency, ctx.demo)], ['Calls', num(current?.calls)], ['Sales', num(current?.sales)]].map(([label, value]) => '<div><dt>' + label + '</dt><dd>' + esc(value) + '</dd></div>').join('') + '</dl>' +
    '<div class="brief-coverage">' + coverageHtml(current?.coverage) + '</div><div class="brief-comparison">' + comparisonHtml(safe.comparison, current?.currency, ctx.demo) + '</div>' +
    '<p class="brief-delivery">In-app alerts only. Email and Slack delivery: not configured.</p>' +
    '<div class="brief-tabs" role="tablist" aria-label="Brief views"><button type="button" role="tab" data-brief-tab="inbox" aria-selected="' + (state.tab === 'inbox') + '">Inbox (' + unread + ')</button>' +
    '<button type="button" role="tab" data-brief-tab="history" aria-selected="' + (state.tab === 'history') + '">History (' + safe.history.length + ')</button></div>' +
    (state.notice ? '<p class="brief-status" role="status">' + esc(state.notice) + '</p>' : '') +
    '<section class="brief-content" role="tabpanel">' + (state.tab === 'history' ? history : inbox) + '</section></div>';
  const active = () => sessions.get(root) === state && state.identity === identity && ctx.account === account;
  for (const button of all('[data-brief-tab]')) button.addEventListener?.('click', () => {
    if (!active() || !['inbox', 'history'].includes(button.dataset?.briefTab)) return;
    state.tab = button.dataset.briefTab; render(ctx);
  });
  for (const [selector, key] of [['[data-brief-severity]', 'severity'], ['[data-brief-status]', 'status']]) find(selector)?.addEventListener?.('change', (event) => {
    if (!active()) return; state[key] = event.target.value; render(ctx);
  });
  for (const input of all('[data-brief-read]')) input.addEventListener?.('change', () => {
    if (!active()) return;
    const alert = safe.alerts.find((item) => item.id === input.dataset?.briefRead);
    if (!alert) return;
    state.notice = setReadState(account, ctx.demo, alert, Boolean(input.checked)) ? '' : 'Read mark could not be saved in this browser.';
    render(ctx);
  });
  for (const button of all('[data-brief-review]')) button.addEventListener?.('click', () => {
    const rule = RULES[button.dataset?.briefReview];
    if (active() && rule) ctx.selectView?.(rule.view);
  });
  find('[data-brief-export]')?.addEventListener?.('click', () => { if (active() && current) download(ctx, safe); });
}

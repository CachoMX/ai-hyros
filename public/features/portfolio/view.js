import { RANGES, STATUS_LABELS, REASONS, currencyTotals, currencyCode, selectAccounts, portfolioCsv } from './model.js';

const sessions = new WeakMap();
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const number = (value) => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '-';
const ratio = (value) => typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(2)}x` : '-';
const money = (value, currency, demo) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-';
  if (!currencyCode(currency)) return `${number(value)} (currency unknown)`;
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency, currencyDisplay: 'code', maximumFractionDigits: demo ? 0 : 2 }).format(value); }
  catch { return `${currency} ${number(value)}`; }
};
const dateTime = (value, ctx) => {
  if (!value || !Number.isFinite(Date.parse(value))) return 'No snapshot';
  return ctx.fmt?.datetime ? ctx.fmt.datetime(value) : new Date(value).toLocaleString();
};

function blockNotice(block, ctx) {
  if (!block) return 'No portfolio block in this snapshot.';
  if (block.stale) return `Showing the previous result (${dateTime(block.checkedAt, ctx)}).`;
  if (block.error) return 'Portfolio step failed during refresh.';
  if (block.skipped) return 'Portfolio step skipped; nothing computed yet. Refresh to retry.';
  return '';
}

function resultsHtml(state, ctx) {
  const rows = selectAccounts(state.accounts, state.filters);
  const totals = currencyTotals(rows);
  state.visible = rows;
  const counts = Object.keys(STATUS_LABELS).map((status) => `<span>${esc(STATUS_LABELS[status])} <b>${rows.filter((r) => r.status === status).length}</b></span>`).join('');
  const totalHtml = totals.map((total) => `<section class="portfolio-total" aria-label="${esc(total.currency)} totals">
    <div class="portfolio-total-head"><h3>${esc(total.currency)}</h3><span class="sub">${total.accounts} accounts${total.stale ? ` / ${total.stale} stale` : ''}</span></div>
    <dl class="portfolio-metrics">
      <div><dt>Spend</dt><dd>${esc(money(total.spend, total.currency, ctx.demo))}</dd></div>
      <div><dt>Revenue incl rebills</dt><dd class="portfolio-revenue">${esc(money(total.totalRevenue, total.currency, ctx.demo))}</dd></div>
      <div><dt>ROAS incl rebills</dt><dd>${esc(ratio(total.roas))}</dd></div>
      <div><dt>Calls</dt><dd>${number(total.calls)}</dd></div>
      <div><dt>Leads</dt><dd>${number(total.leads)}</dd></div>
    </dl>
    <div class="sub">${total.windows.length > 1 ? 'Different reporting dates in this total: ' : ''}${esc(total.windows.join('; '))}</div>
  </section>`).join('');
  const included = totals.reduce((n, total) => n + total.accounts, 0);
  const excluded = rows.length - included;
  const cells = rows.map((row) => {
    const metric = row.metrics || {};
    const status = STATUS_LABELS[row.status] || 'Unknown';
    const tone = row.status === 'fresh' ? 'ok' : row.status === 'error' ? 'bad' : 'warn';
    const age = row.ageHours === null || row.ageHours === undefined ? '' : ` / ${number(Math.max(0, row.ageHours))}h old`;
    const label = row.canOpen !== false && !ctx.demo
      ? `<button type="button" class="portfolio-account" data-portfolio-account="${esc(row.id)}" title="Open account war room">${esc(row.label)} <span aria-hidden="true">&rarr;</span></button>`
      : `<span class="portfolio-account-label">${esc(row.label)}</span>`;
    return `<tr>
      <td data-label="Account">${label}<span class="sub">${row.agency ? 'Agency' : row.kind === 'client' ? 'Client' : 'Account'}${row.demo ? ' / Demo' : ''}</span></td>
      <td data-label="Status"><span class="pill ${tone}">${esc(status)}</span>${REASONS[row.reason] ? `<span class="sub">${esc(REASONS[row.reason])}</span>` : ''}${row.partial && row.reason !== 'partial' ? '<span class="sub">Incomplete report</span>' : ''}</td>
      <td data-label="Currency">${esc(row.currency || 'Unknown')}</td>
      <td data-label="Spend" class="portfolio-number">${esc(money(metric.spend, row.currency, ctx.demo))}</td>
      <td data-label="Revenue incl rebills" class="portfolio-number portfolio-revenue">${esc(money(metric.totalRevenue, row.currency, ctx.demo))}</td>
      <td data-label="ROAS incl rebills" class="portfolio-number">${esc(ratio(metric.roas))}</td>
      <td data-label="Calls" class="portfolio-number">${number(metric.calls)}</td>
      <td data-label="Leads" class="portfolio-number">${number(metric.leads)}</td>
      <td data-label="Snapshot"><time datetime="${esc(row.generatedAt || '')}">${esc(dateTime(row.generatedAt, ctx))}</time><span class="sub">${esc(row.window?.start || '?')} / ${esc(row.window?.end || '?')}${esc(age)}</span></td>
    </tr>`;
  }).join('');
  return `<div class="portfolio-counts">${counts}</div>${totalHtml}
    ${excluded ? `<p class="portfolio-caveat">${excluded} account${excluded === 1 ? '' : 's'} excluded from totals: unavailable, incomplete, errored, or unknown currency.</p>` : ''}
    ${totals.some((t) => t.stale) ? '<p class="portfolio-caveat">Totals include previous snapshots marked stale.</p>' : ''}
    ${rows.some((r) => r.agency) ? '<p class="portfolio-caveat">Agency and client reports may contain overlapping attribution.</p>' : ''}
    <div class="portfolio-table-wrap"><table class="portfolio-table"><caption class="portfolio-sr-only">Registered account snapshots, ${esc(state.range)}</caption>
      <thead><tr><th scope="col">Account</th><th scope="col">Status</th><th scope="col">Currency</th><th scope="col">Spend</th><th scope="col">Revenue incl rebills</th><th scope="col">ROAS incl rebills</th><th scope="col">Calls</th><th scope="col">Leads</th><th scope="col">Snapshot / range</th></tr></thead>
      <tbody>${cells || `<tr><td colspan="9" class="empty">${state.loading ? 'Loading registered accounts...' : state.error ? 'Portfolio unavailable.' : state.accounts.length ? 'No accounts match these filters.' : 'No registered account snapshots.'}</td></tr>`}</tbody></table></div>`;
}

function download(state, ctx) {
  const doc = ctx.root.ownerDocument;
  const urlApi = doc?.defaultView?.URL || globalThis.URL;
  if (!doc?.createElement || typeof urlApi?.createObjectURL !== 'function' || typeof Blob !== 'function') return;
  const blob = new Blob(['\ufeff', portfolioCsv(state.visible, { range: state.range, demo: ctx.demo })], { type: 'text/csv;charset=utf-8' });
  const url = urlApi.createObjectURL(blob);
  const link = doc.createElement('a');
  link.href = url;
  link.download = `portfolio-${ctx.demo ? 'demo-' : ''}${state.range}.csv`;
  link.hidden = true;
  doc.body?.appendChild(link);
  link.click();
  link.remove?.();
  setTimeout(() => urlApi.revokeObjectURL(url), 1000);
}

export function render(ctx) {
  const root = ctx.root;
  if (!root || typeof root !== 'object') return;
  const previous = sessions.get(root);
  previous?.controller?.abort();
  const range = RANGES.includes(ctx.range) ? ctx.range : '30d';
  const identity = `${ctx.demo ? 'demo' : ctx.account || ''}:${range}`;
  const block = ctx.block && typeof ctx.block === 'object' ? ctx.block : null;
  const current = block?.current?.[range];
  const accounts = ctx.demo
    ? (Array.isArray(block?.accounts) ? block.accounts.map((row) => row?.ranges?.[range]).filter((row) => row?.demo === true) : [])
    : current && ctx.account ? [{ ...current, id: ctx.account, currency: current.currency || currencyCode(ctx.snapshot?.account?.currency),
      ...(block.stale ? { status: 'stale', reason: 'previous' } : {}), canOpen: true }] : [];
  const state = { identity, range, account: ctx.account, demo: ctx.demo, accounts, visible: [],
    filters: previous?.identity === identity ? { ...previous.filters } : { search: '', status: 'all', currency: 'all', sort: 'attention' },
    loading: false, error: '', notice: blockNotice(block, ctx), checkedAt: block?.checkedAt || null, sequence: 0, controller: null };
  sessions.set(root, state);
  const find = (selector) => typeof root.querySelector === 'function' ? root.querySelector(selector) : null;
  const findAll = (selector) => typeof root.querySelectorAll === 'function' ? Array.from(root.querySelectorAll(selector) || []) : [];
  const active = () => sessions.get(root) === state && ctx.account === state.account && ctx.demo === state.demo &&
    (RANGES.includes(ctx.range) ? ctx.range : '30d') === range && root.isConnected !== false && root.hidden !== true;
  const selected = (key, value) => state.filters[key] === value ? ' selected' : '';
  const currencyOptions = () => ['all', ...new Set(state.accounts.map((r) => r.currency || 'unknown'))].map((c) => `<option value="${esc(c)}"${selected('currency', c)}>${c === 'all' ? 'All currencies' : esc(c === 'unknown' ? 'Unknown currency' : c)}</option>`).join('');
  const statusText = () => [ctx.demo ? 'Demo accounts' : state.loading ? 'Loading registered snapshots...' : 'Stored account snapshots',
    state.error, state.notice, state.checkedAt ? `Checked ${dateTime(state.checkedAt, ctx)}` : ''].filter(Boolean).join(' / ');
  const wireAccounts = () => {
    for (const button of findAll('[data-portfolio-account]')) button.addEventListener?.('click', () => {
      if (!active() || ctx.demo) return;
      const accountId = button.dataset?.portfolioAccount;
      if (!state.accounts.some((r) => r.id === accountId && r.canOpen !== false)) return;
      const EventClass = root.ownerDocument?.defaultView?.CustomEvent || globalThis.CustomEvent;
      if (typeof EventClass === 'function' && typeof root.dispatchEvent === 'function') {
        root.dispatchEvent(new EventClass('hyros:account', { bubbles: true, detail: { accountId, view: 'warroom' } }));
      }
    });
  };
  const shell = () => `<div class="portfolio">
    <header class="portfolio-header"><h2>Agency Portfolio</h2><div class="portfolio-actions">
      <button type="button" data-portfolio-refresh title="Reload stored snapshots" aria-label="Reload stored snapshots">&#8635;</button>
      <button type="button" data-portfolio-download title="Download filtered accounts as CSV"><span aria-hidden="true">&darr;</span> CSV</button>
    </div></header>
    <p class="portfolio-status${state.error ? ' bad' : ''}" data-portfolio-status role="status" aria-live="polite">${esc(statusText())}</p>
    <div class="portfolio-controls">
      <label>Account<input type="search" data-portfolio-search value="${esc(state.filters.search)}" placeholder="Search accounts" autocomplete="off"></label>
      <label>Status<select data-portfolio-status-filter><option value="all"${selected('status', 'all')}>All statuses</option>${Object.entries(STATUS_LABELS).map(([key, label]) => `<option value="${key}"${selected('status', key)}>${label}</option>`).join('')}</select></label>
      <label>Currency<select data-portfolio-currency>${currencyOptions()}</select></label>
      <label>Sort<select data-portfolio-sort>${[['attention', 'Needs attention'], ['name', 'Account name'], ['spend', 'Spend by currency'], ['totalRevenue', 'Revenue by currency'], ['roas', 'Highest ROAS'], ['calls', 'Most calls'], ['leads', 'Most leads'], ['oldest', 'Oldest snapshot']].map(([key, label]) => `<option value="${key}"${selected('sort', key)}>${label}</option>`).join('')}</select></label>
    </div><div data-portfolio-results>${resultsHtml(state, ctx)}</div></div>`;
  const paint = () => {
    const results = find('[data-portfolio-results]');
    if (!results) { root.innerHTML = shell(); return; }
    results.innerHTML = resultsHtml(state, ctx);
    const status = find('[data-portfolio-status]');
    if (status) { status.textContent = statusText(); status.className = `portfolio-status${state.error ? ' bad' : ''}`; }
    const refresh = find('[data-portfolio-refresh]');
    if (refresh) refresh.disabled = state.loading || ctx.demo;
    const csv = find('[data-portfolio-download]');
    if (csv) csv.disabled = !state.visible.length || state.loading;
    wireAccounts();
  };
  const load = async () => {
    if (ctx.demo || typeof ctx.api !== 'function') return;
    state.controller?.abort();
    state.controller = typeof AbortController === 'function' ? new AbortController() : null;
    const sequence = ++state.sequence;
    state.loading = true;
    state.error = '';
    paint();
    try {
      const result = await ctx.api(`/api/portfolio?range=${encodeURIComponent(range)}`, { method: 'GET', signal: state.controller?.signal });
      if (!active() || sequence !== state.sequence) return;
      const body = result?.body;
      if (result?.status !== 200 || !body?.ok || !Array.isArray(body.accounts) || body.range !== range) {
        throw new Error(result?.status === 401 || body?.error === 'unauthorized' ? 'unauthorized' : 'unavailable');
      }
      state.accounts = body.accounts.filter((row) => row && typeof row.id === 'string' && !row.demo);
      state.checkedAt = body.checkedAt || null;
      state.notice = '';
      if (state.filters.currency !== 'all' && !state.accounts.some((r) => (r.currency || 'unknown') === state.filters.currency)) state.filters.currency = 'all';
      const currency = find('[data-portfolio-currency]');
      if (currency) currency.innerHTML = currencyOptions();
    } catch (err) {
      if (!active() || sequence !== state.sequence || err?.name === 'AbortError') return;
      state.accounts = [];
      state.checkedAt = null;
      state.error = err?.message === 'unauthorized' ? 'Sign in again to load the portfolio.' : 'Portfolio unavailable. Retry loading stored snapshots.';
    } finally {
      if (active() && sequence === state.sequence) { state.loading = false; paint(); }
    }
  };
  root.innerHTML = shell();
  for (const [selector, key, event] of [['[data-portfolio-search]', 'search', 'input'], ['[data-portfolio-status-filter]', 'status', 'change'], ['[data-portfolio-currency]', 'currency', 'change'], ['[data-portfolio-sort]', 'sort', 'change']]) {
    find(selector)?.addEventListener?.(event, (e) => { state.filters[key] = e.target.value; paint(); });
  }
  find('[data-portfolio-refresh]')?.addEventListener?.('click', load);
  find('[data-portfolio-download]')?.addEventListener?.('click', () => download(state, ctx));
  paint();
  return load();
}

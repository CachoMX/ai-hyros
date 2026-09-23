import { loadProfitSettings, saveProfitSettings, computeProfitRows, sumKnown, windowDays } from '../../shared/profit.js';
import { statusMarkup, downloadCsv } from './ui.js';

const DASH = '&mdash;';
const selected = (a, b) => a === b ? ' selected' : '';

export function render(ctx) {
  const { root, esc, fmt } = ctx;
  const block = ctx.block;
  const status = statusMarkup(ctx, block);
  if (!block?.ranges || block.error || (block.skipped && !block.stale)) {
    root.innerHTML = status || '<div class="empty">No profit data yet. Hit Refresh.</div>';
    return;
  }
  const range = block.ranges[ctx.range || '30d'];
  const rows = Array.isArray(range?.rows) ? range.rows : [];
  const account = ctx.demo ? 'demo' : ctx.account;
  let settings = loadProfitSettings(account);
  let computed = computeProfitRows(rows, settings, range);
  let search = '', filter = 'all', sort = 'spend';
  const money = (value) => value === null ? DASH : esc(fmt.money(value));
  const ratio = (value) => value === null ? DASH : `${value.toFixed(2)}x`;
  const tone = (value) => value === null ? '' : value >= 0 ? 'good' : 'bad';
  const identities = [];
  for (const [field, bucket, label] of [['productId', 'productMargins', 'Product'], ['offerId', 'offerMargins', 'Offer'], ['offer', 'offerMargins', 'Offer']]) {
    for (const value of new Set(rows.map((row) => row[field]).filter((value) => value != null && value !== ''))) {
      if (!identities.some((item) => item.bucket === bucket && item.id === String(value))) identities.push({ bucket, label, id: String(value) });
    }
  }
  const visible = () => computed.filter((item) => {
    if (!`${item.row.name || ''} ${item.row.parentName || ''} ${item.row.id || ''}`.toLowerCase().includes(search)) return false;
    return filter === 'all' || (filter === 'unknown' ? item.netProfit === null : filter === 'positive' ? item.netProfit !== null && item.netProfit >= 0 : item.netProfit !== null && item.netProfit < 0);
  }).sort((a, b) => {
    const key = sort === 'net' ? 'netProfit' : sort === 'revenue' ? 'revenue' : 'spend';
    return (b[key] ?? -Infinity) - (a[key] ?? -Infinity);
  });
  const table = () => {
    const items = visible();
    const total = (key) => sumKnown(items.map((item) => item[key]));
    const known = items.filter((item) => item.netProfit !== null).length;
    const tiles = ctx.kpis([
      { label: 'Revenue', value: total('revenue') === null ? 'Unknown' : fmt.money(total('revenue')), sub: 'Total revenue preferred; includes rebills' },
      { label: 'Contribution', value: total('contribution') === null ? 'Unknown' : fmt.money(total('contribution')), sub: 'Before ad spend and overhead' },
      { label: 'Net profit', value: total('netProfit') === null ? 'Unknown' : fmt.money(total('netProfit')), cls: tone(total('netProfit')), sub: 'After allocated overhead' },
      { label: 'Cost coverage', value: `${known} / ${items.length}`, sub: 'Rows with complete profit inputs' },
    ]);
    return `<div class="kpis">${tiles}</div><div class="profit-scroll"><table class="profit-table"><thead><tr>
      <th scope="col">Ad set / evidence</th><th scope="col">Revenue</th><th scope="col">Contribution</th><th scope="col">Spend</th><th scope="col">Overhead</th><th scope="col">Net profit</th><th scope="col">Break-even ROAS</th>
      </tr></thead><tbody>${items.length ? items.map((item) => `<tr><td><details><summary>${esc(item.row.name || item.row.id || 'Unnamed ad set')}</summary>
      <dl class="profit-evidence"><dt>Row ID</dt><dd>${esc(item.row.id ?? 'Unavailable')}</dd><dt>Revenue basis</dt><dd>${esc(item.revenueBasis || 'Unavailable')}</dd>
      <dt>Cost basis</dt><dd>${settings.costBasis === 'native' ? 'Native hard costs only' : item.marginPct === null ? 'Margin unknown' : `${esc(item.marginPct)}% margin; native costs not added`}</dd>
      <dt>Refund deduction</dt><dd>${item.configured ? money(item.refundDeduction) : 'Unconfirmed'}</dd><dt>Observed ROAS</dt><dd>${ratio(item.roas)}</dd></dl>
      ${item.issues.length ? `<div class="sub">${item.issues.map(esc).join(' ')}</div>` : ''}</details></td>
      <td>${money(item.revenue)}</td><td>${money(item.contribution)}</td><td>${money(item.spend)}</td><td>${money(item.overhead)}</td><td class="${tone(item.netProfit)}">${money(item.netProfit)}</td><td>${ratio(item.breakEvenRoas)}</td></tr>`).join('') : '<tr><td colspan="7" class="empty">No matching ad sets.</td></tr>'}</tbody></table></div>`;
  };
  root.innerHTML = `${status}<div class="profit-context"><span>${esc(range?.start || 'Unknown start')} to ${esc(range?.end || 'unknown end')}</span><span>${esc(block.model || 'Model unavailable')} / ${esc(block.currency || 'Currency unavailable')}</span>${ctx.demo ? '<span class="pill warn">Demo data</span>' : ''}</div>
    <details class="profit-settings"${settings.defaultMarginPct === null && settings.costBasis === 'margin' ? ' open' : ''}><summary>Cost settings</summary>
    <form data-profit-settings><div class="profit-fields">
      <label>Cost basis<select name="costBasis"><option value="margin"${selected(settings.costBasis, 'margin')}>Configured margin</option><option value="native"${selected(settings.costBasis, 'native')}>Native hard costs</option></select></label>
      <label>Default gross margin (%)<input name="defaultMarginPct" type="number" min="0" max="100" step="0.1" placeholder="Unknown" value="${settings.defaultMarginPct ?? ''}"></label>
      <label>Daily overhead (${esc(block.currency || 'account currency')})<input name="dailyOverhead" type="number" min="0" step="0.01" required value="${settings.dailyOverhead}"></label>
      <label>Refund treatment<select name="refundTreatment"><option value="unknown"${selected(settings.refundTreatment, 'unknown')}>Unconfirmed</option><option value="included"${selected(settings.refundTreatment, 'included')}>Already deducted from revenue</option><option value="subtract"${selected(settings.refundTreatment, 'subtract')}>Deduct reported refunds</option></select></label>
      <label>Refunds in native hard costs<select name="nativeCostsIncludeRefunds"><option value="unknown"${selected(settings.nativeCostsIncludeRefunds, null)}>Unconfirmed</option><option value="true"${selected(settings.nativeCostsIncludeRefunds, true)}>Included</option><option value="false"${selected(settings.nativeCostsIncludeRefunds, false)}>Excluded</option></select></label>
      ${identities.map((item, index) => `<label>${esc(item.label)} ${esc(item.id)} margin (%)<input data-margin="${index}" type="number" min="0" max="100" step="0.1" placeholder="Default margin" value="${settings[item.bucket][item.id] ?? ''}"></label>`).join('')}
    </div><div class="profit-actions"><button type="submit">Save settings</button><span class="sub" data-profit-save role="status">Settings are browser-local for this account.</span></div></form></details>
    <div class="profit-caveats sub">${identities.length ? '' : 'No product or offer IDs in these report rows. '}${esc(range?.errors?.join(' ') || '')} ${esc(block.errors?.join(' ') || '')}
      ${windowDays(range) === null ? 'Report dates unavailable. ' : ''}Overhead is allocated by spend across the captured ad sets before filtering. Break-even uses the observed revenue mix. Margins include variable costs; refunds use the selected treatment.</div>
    <div class="profit-controls"><label>Search<input data-profit-search type="search" placeholder="Ad set name or ID"></label><label>Profit status<select data-profit-filter><option value="all">All rows</option><option value="positive">Non-negative</option><option value="negative">Negative</option><option value="unknown">Unknown</option></select></label><label>Sort<select data-profit-sort><option value="spend">Spend</option><option value="net">Net profit</option><option value="revenue">Revenue</option></select></label><button type="button" data-profit-export>Export CSV</button></div>
    <div data-profit-results>${table()}</div>`;
  const find = (selector) => root.querySelector?.(selector);
  const redraw = () => { const target = find('[data-profit-results]'); if (target) target.innerHTML = table(); };
  find('[data-profit-search]')?.addEventListener?.('input', (event) => { search = event.target.value.toLowerCase(); redraw(); });
  find('[data-profit-filter]')?.addEventListener?.('change', (event) => { filter = event.target.value; redraw(); });
  find('[data-profit-sort]')?.addEventListener?.('change', (event) => { sort = event.target.value; redraw(); });
  find('[data-profit-settings]')?.addEventListener?.('submit', (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (form.reportValidity && !form.reportValidity()) return;
    const data = new FormData(form);
    const next = { ...settings, defaultMarginPct: data.get('defaultMarginPct'), dailyOverhead: data.get('dailyOverhead'),
      costBasis: data.get('costBasis'), refundTreatment: data.get('refundTreatment'),
      nativeCostsIncludeRefunds: data.get('nativeCostsIncludeRefunds') === 'unknown' ? null : data.get('nativeCostsIncludeRefunds') === 'true',
      productMargins: { ...settings.productMargins }, offerMargins: { ...settings.offerMargins } };
    identities.forEach((item, index) => {
      const input = form.querySelector(`[data-margin="${index}"]`);
      if (!input?.value) delete next[item.bucket][item.id];
      else Object.defineProperty(next[item.bucket], item.id, { value: Number(input.value), enumerable: true, configurable: true, writable: true });
    });
    const result = saveProfitSettings(account, next);
    settings = result.settings;
    computed = computeProfitRows(rows, settings, range);
    const message = find('[data-profit-save]');
    if (message) message.textContent = result.persisted ? 'Saved in this browser for this account.' : 'Browser storage unavailable; settings kept for this session only.';
    redraw();
  });
  find('[data-profit-export]')?.addEventListener?.('click', () => {
    downloadCsv(`profit-${ctx.range || '30d'}.csv`, ['Checked at', 'Stale', 'Account', 'Demo', 'Start', 'End', 'Model', 'Currency', 'Ad set ID', 'Ad set', 'Revenue', 'Contribution', 'Spend', 'Allocated overhead', 'Net profit', 'Break-even ROAS', 'Configured', 'Issues', 'Settings'],
      visible().map((item) => [block.checkedAt, Boolean(block.stale), account ?? 'default', Boolean(ctx.demo), range?.start, range?.end, block.model, block.currency, item.row.id, item.row.name, item.revenue, item.contribution, item.spend, item.overhead, item.netProfit, item.breakEvenRoas, item.configured, [...item.issues, ...(range?.errors || [])].join(' '), JSON.stringify(settings)]));
  });
}

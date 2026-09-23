import { SLOTS, loadCreativeSettings, saveCreativeSettings, groupCreatives, comparablePeriods, compareGroup } from './analysis.js';
import { statusMarkup, downloadCsv } from '../profit/ui.js';

const selected = (a, b) => a === b ? ' selected' : '';
export function render(ctx) {
  const { root, esc, fmt } = ctx;
  const block = ctx.block, status = statusMarkup(ctx, block);
  if (!block?.ranges || block.error || (block.skipped && !block.stale)) {
    root.innerHTML = status || '<div class="empty">No creative data yet. Hit Refresh.</div>';
    return;
  }
  const rangeKey = ctx.range || '30d', range = block.ranges[rangeKey];
  const rows = Array.isArray(range?.rows) ? range.rows : [];
  const account = ctx.demo ? 'demo' : ctx.account;
  let settings = loadCreativeSettings(account);
  let dimension = 'concept', search = '', platform = '', filter = 'all', sort = 'spend';
  const money = (value) => value === null ? '&mdash;' : esc(fmt.money(value));
  const ratio = (value) => value === null ? '&mdash;' : `${value.toFixed(2)}x`;
  const percent = (value) => value === null ? '&mdash;' : `${(value * 100).toFixed(1)}%`;
  const comparison = block.comparison?.rangeKey === rangeKey && comparablePeriods({ ...range, model: block.model, currency: block.currency, context: block.context }, block.comparison, block.checkedAt) ? block.comparison : null;
  const visible = () => {
    const groups = groupCreatives(rows.filter((row) => !platform || row._traffic === platform), { ...settings, coverageComplete: range?.complete === true }, dimension);
    const prior = new Map(groupCreatives(comparison?.rows || [], settings, dimension).map((group) => [group.key, group]));
    return groups.filter((group) => (!search || `${group.name} ${group.variants.map((item) => item.name).join(' ')}`.toLowerCase().includes(search))
      && (filter === 'all' || (filter === 'concentrated' ? group.concentrated : !group.evidenceMet || group.topShare === null)))
      .map((group) => ({ ...group, trend: comparison ? compareGroup(group, prior.get(group.key)) : { delta: null, reason: 'No comparable completed period' } }))
      .sort((a, b) => (b[sort] ?? -Infinity) - (a[sort] ?? -Infinity));
  };
  const report = () => {
    const groups = visible();
    return `<div class="kpis">${ctx.kpis([
      { label: 'Groups', value: fmt.int(groups.length), sub: settings.configured ? `Name slot: ${dimension}` : 'Ad set fallback; naming unconfigured' },
      { label: 'Ad variants', value: fmt.int(groups.reduce((sum, group) => sum + group.variants.length, 0)) },
      { label: 'Concentrated groups', value: fmt.int(groups.filter((group) => group.concentrated).length), sub: `Top share > ${settings.concentrationPct}%; at least ${settings.minVariants} variants` },
      { label: 'Comparison', value: comparison ? 'Available' : 'Unavailable', sub: comparison ? `${comparison.start} to ${comparison.end}` : 'Completed, adjacent, equal-length periods required' },
    ])}</div><div class="creative-list">${groups.length ? groups.map((group) => `<details class="creative-group"><summary>
      <span class="creative-title">${esc(group.name)}<span class="sub">${esc(group.platform || 'Platform unavailable')} / ${esc(group.basis)} / ${group.variants.length} variants</span></span>
      <span class="creative-stat"><span>Spend</span><b>${money(group.spend)}</b></span><span class="creative-stat"><span>Revenue</span><b>${money(group.revenue)}</b></span>
      <span class="creative-stat"><span>ROAS</span><b>${ratio(group.roas)}</b></span><span class="creative-stat"><span>Top share</span><b>${percent(group.topShare)}</b></span>
      <span class="pill ${group.concentrated ? 'warn' : ''}">${group.concentrated ? 'Concentrated' : !group.evidenceMet ? 'Below evidence threshold' : group.topShare === null ? 'Share unavailable' : 'Observed'}</span></summary>
      <div class="creative-detail"><div class="creative-evidence sub">${esc(group.trend.reason)}${group.trend.delta !== null ? `: ${group.trend.delta >= 0 ? '+' : ''}${group.trend.delta.toFixed(1)}%` : ''}. Revenue basis: ${esc(group.revenueBasis || 'Unavailable')}. Account: ${esc(group.account || 'Unavailable')}.</div>
      <div class="creative-scroll"><table class="creative-table"><thead><tr><th>Ad / evidence</th>${SLOTS.map((slot) => `<th>${esc(slot)}</th>`).join('')}<th>Spend</th><th>Revenue</th><th>ROAS</th><th>Revenue share</th></tr></thead><tbody>
      ${group.variants.map((item) => `<tr><td>${esc(item.name)}<span class="sub">${esc(item.row.id || 'ID unavailable')}</span>${item.issues.length ? `<span class="sub">${item.issues.map(esc).join(' ')}</span>` : ''}</td>${SLOTS.map((slot) => `<td>${item.slots[slot] === null ? '&mdash;' : esc(item.slots[slot])}</td>`).join('')}
      <td>${money(item.spend)}</td><td>${money(item.revenue)}</td><td>${ratio(item.roas)}</td><td><span class="creative-share"><span>${percent(item.share)}</span>${item.share !== null ? `<meter min="0" max="1" value="${item.share}" aria-label="Revenue share for ${esc(item.name)}"></meter>` : ''}</span></td></tr>`).join('')}
      </tbody></table></div></div></details>`).join('') : '<div class="empty">No matching creative groups.</div>'}</div>`;
  };
  root.innerHTML = `${status}<div class="creative-context"><span>${esc(range?.start || 'Unknown start')} to ${esc(range?.end || 'unknown end')}</span><span>${esc(block.model || 'Model unavailable')} / ${esc(block.currency || 'Currency unavailable')}</span>${ctx.demo ? '<span class="pill warn">Demo data</span>' : ''}</div>
    <details class="creative-settings"${settings.configured ? '' : ' open'}><summary>Naming and evidence settings</summary><form data-creative-settings>
    <div class="creative-fields"><label>Delimiter<input name="separator" maxlength="12" value="${esc(settings.separator)}"></label>
    ${settings.slots.map((value, index) => `<label>Name slot ${index + 1}<select name="slot${index}">${[...SLOTS, 'ignore'].map((slot) => `<option value="${slot}"${selected(value, slot)}>${slot}</option>`).join('')}</select></label>`).join('')}
    <label>Concentration threshold (%)<input type="number" name="concentrationPct" min="0" max="100" step="1" required value="${settings.concentrationPct}"></label>
    <label>Minimum variants<input type="number" name="minVariants" min="2" max="100" step="1" required value="${settings.minVariants}"></label>
    <label>Minimum group spend<input type="number" name="minSpend" min="0" step="0.01" required value="${settings.minSpend}"></label>
    <label>Minimum sales<input type="number" name="minSales" min="0" step="1" required value="${settings.minSales}"></label></div>
    <div class="creative-actions"><button type="submit">Save settings</button><label class="creative-check"><input type="checkbox" name="configured"${settings.configured ? ' checked' : ''}>Use name slots</label><span class="sub" data-creative-save role="status">Settings are browser-local for this account.</span></div></form></details>
    <div class="sub creative-caveats">${esc((range?.errors || []).join(' '))} ${esc((block.errors || []).join(' '))}Concentration is observed revenue share. Thresholds are operator settings. Creative assets are unavailable; name slots are not verified content labels.</div>
    <div class="creative-controls"><label>Search<input data-creative-search type="search" placeholder="Group or ad name"></label><label>Group by<select data-creative-dimension>${SLOTS.map((slot) => `<option value="${slot}">${slot}</option>`).join('')}</select></label>
    <label>Platform<select data-creative-platform><option value="">All platforms</option>${[...new Set(rows.map((row) => row._traffic).filter(Boolean))].map((value) => `<option value="${esc(value)}">${esc(value)}</option>`).join('')}</select></label>
    <label>Evidence<select data-creative-filter><option value="all">All groups</option><option value="concentrated">Concentrated</option><option value="limited">Limited evidence</option></select></label><label>Sort<select data-creative-sort><option value="spend">Spend</option><option value="revenue">Revenue</option><option value="topShare">Top share</option><option value="roas">ROAS</option></select></label><button type="button" data-creative-export>Export CSV</button></div>
    <div data-creative-results>${report()}</div>`;
  const find = (selector) => root.querySelector?.(selector);
  const redraw = () => { const target = find('[data-creative-results]'); if (target) target.innerHTML = report(); };
  for (const [name, update] of [
    ['search', (value) => { search = value.toLowerCase(); }], ['dimension', (value) => { dimension = value; }],
    ['platform', (value) => { platform = value; }], ['filter', (value) => { filter = value; }], ['sort', (value) => { sort = value; }],
  ]) find(`[data-creative-${name}]`)?.addEventListener?.(name === 'search' ? 'input' : 'change', (event) => { update(event.target.value); redraw(); });
  find('[data-creative-settings]')?.addEventListener?.('submit', (event) => {
    event.preventDefault();
    if (event.currentTarget.reportValidity && !event.currentTarget.reportValidity()) return;
    const data = new FormData(event.currentTarget), slots = SLOTS.map((_, index) => data.get(`slot${index}`));
    const active = slots.filter((slot) => slot !== 'ignore');
    const message = find('[data-creative-save]');
    if (new Set(active).size !== active.length) { if (message) message.textContent = 'Each name slot can be assigned only once.'; return; }
    const result = saveCreativeSettings(account, { separator: data.get('separator'), slots, configured: data.get('configured') === 'on',
      concentrationPct: data.get('concentrationPct'), minVariants: data.get('minVariants'), minSpend: data.get('minSpend'), minSales: data.get('minSales') });
    settings = result.settings;
    if (message) message.textContent = result.persisted ? 'Saved in this browser for this account.' : 'Browser storage unavailable; settings kept for this session only.';
    redraw();
  });
  find('[data-creative-export]')?.addEventListener?.('click', () => {
    downloadCsv(`creative-${rangeKey}.csv`, ['Checked at', 'Stale', 'Account', 'Demo', 'Start', 'End', 'Model', 'Currency', 'Group', 'Grouping basis', 'Platform', 'Ad ID', 'Ad', ...SLOTS, 'Spend', 'Revenue', 'ROAS', 'Revenue share', 'Concentrated', 'ROAS change %', 'Comparison status', 'Settings', 'Issues'],
      visible().flatMap((group) => group.variants.map((item) => [block.checkedAt, Boolean(block.stale), account ?? 'default', Boolean(ctx.demo), range?.start, range?.end, block.model, block.currency, group.name, group.basis, group.platform, item.row.id, item.name, ...SLOTS.map((slot) => item.slots[slot]), item.spend, item.revenue, item.roas, item.share, group.concentrated, group.trend.delta, group.trend.reason, JSON.stringify(settings), [...item.issues, ...(range?.errors || [])].join(' ')])));
  });
}

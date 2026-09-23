import { ATTRIBUTION_MODELS, computeAttribution, computeCallAttribution, finiteAmount, getTouchCredits, uniqueConversions } from '../../shared/attribution.js';

const LABELS = { first: 'First touch', last: 'Last touch', linear: 'Linear', position: 'Position', decay: 'Time decay' };
const PAGE_SIZE = 20;
const number = (value) => Number(value || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

function cell(value) {
  const text = String(value ?? '');
  const safe = typeof value === 'string' && /^[\s]*[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function comparisonCsv({ rows, a, b, state, window, coverage, currency }) {
  const columns = ['source_id', 'source', 'conversion_type', 'currency', 'from', 'to', 'model_a', 'model_b',
    'revenue_a', 'revenue_b', 'credit_a', 'credit_b', 'touches', 'half_life_days', 'window_days', 'include_organic',
    'position_first', 'position_middle', 'position_last', 'sampled', 'with_paths', 'complete', 'truncated', 'selected_conversions', 'unknown_sale_amounts'];
  const metadata = [state.halfLifeDays, state.windowDays, state.includeOrganic, state.positionWeights.first,
    state.positionWeights.middle, state.positionWeights.last, coverage?.sampled, coverage?.withPaths, coverage?.complete, coverage?.truncated,
    state.cohortSize, state.kind === 'SALE' ? state.unknownAmounts : ''];
  const hasRevenue = state.kind === 'SALE' && state.revenueAvailable !== false;
  const records = rows.map((row) => [row.sourceId, row.name, state.kind, currency, window.start, window.end, state.modelA, state.modelB,
    hasRevenue ? row.a.revenue : '', hasRevenue ? row.b.revenue : '', row.a.conversions, row.b.conversions, row.a.touches || row.b.touches, ...metadata]);
  records.push(['', 'Unattributed', state.kind, currency, window.start, window.end, state.modelA, state.modelB,
    hasRevenue ? a.unattributedRevenue : '', hasRevenue ? b.unattributedRevenue : '',
    state.cohortAvailable === false ? '' : Math.max(0, state.cohortSize - a.rows.reduce((sum, row) => sum + row.conversions, 0)),
    state.cohortAvailable === false ? '' : Math.max(0, state.cohortSize - b.rows.reduce((sum, row) => sum + row.conversions, 0)), '', ...metadata]);
  return [columns, ...records].map((record) => record.map(cell).join(',')).join('\r\n');
}

function pairedRows(a, b, kind) {
  const pairs = new Map();
  for (const [side, result] of [['a', a], ['b', b]]) {
    for (const row of result.rows) {
      if (!pairs.has(row.sourceId)) pairs.set(row.sourceId, { sourceId: row.sourceId, name: row.name,
        a: { revenue: 0, conversions: 0, touches: 0 }, b: { revenue: 0, conversions: 0, touches: 0 } });
      pairs.get(row.sourceId)[side] = row;
    }
  }
  const metric = kind === 'SALE' ? 'revenue' : 'conversions';
  return [...pairs.values()].sort((left, right) => Math.max(right.a[metric], right.b[metric]) - Math.max(left.a[metric], left.b[metric]));
}

export function render(ctx) {
  const { root } = ctx;
  if (!root) return;
  const esc = ctx.esc || escape;
  const block = ctx.block;
  if (!block || !Array.isArray(block.conversions)) {
    const status = block?.error ? `Error: ${block.error}` : block?.skipped
      ? `${block.stale ? 'Previous result unavailable. ' : ''}Skipped (${block.skipped}). Nothing computed yet; refresh to retry.`
      : 'No conversion paths in this snapshot. Refresh to load Attribution Lab.';
    root.innerHTML = `<div class="attribution"><div class="empty" role="status">${esc(status)}</div></div>`;
    return;
  }
  const money = (value) => esc(ctx.fmt?.money ? ctx.fmt.money(value) : number(value));
  const date = (value) => value ? esc(ctx.fmt?.datetime ? ctx.fmt.datetime(value) : value) : 'Unknown';
  const baseWindow = block.window || {};
  const selected = ctx.snapshot?.ranges?.[ctx.range];
  const narrowed = selected?.start && selected?.end && selected.start >= baseWindow.start && selected.end <= baseWindow.end;
  const window = narrowed ? { start: selected.start, end: selected.end } : baseWindow;
  const differentWindow = window.start !== baseWindow.start || window.end !== baseWindow.end;
  const records = block.conversions.filter((conversion) => conversion && (!differentWindow
    || (conversion.date && conversion.date.slice(0, 10) >= window.start.slice(0, 10) && conversion.date.slice(0, 10) <= window.end.slice(0, 10))));
  const state = { kind: 'SALE', modelA: 'first', modelB: 'last', windowDays: 0, halfLifeDays: 7,
    includeOrganic: true, positionWeights: { first: 40, middle: 20, last: 40 }, page: 0, cohortSize: 0 };
  const accountCurrency = ctx.snapshot?.account?.currency || null;
  const options = (model) => ({ model, windowDays: state.windowDays, halfLifeDays: state.halfLifeDays,
    includeOrganic: state.includeOrganic, positionWeights: state.positionWeights });
  const menu = (name, label) => `<label>${label}<select data-setting="${name}" aria-label="${label}">${ATTRIBUTION_MODELS.map((model) => `<option value="${model}" ${state[name] === model ? 'selected' : ''}>${LABELS[model]}</option>`).join('')}</select></label>`;

  function draw() {
    const cohort = uniqueConversions(records, state.kind);
    state.cohortSize = cohort.length;
    const compute = state.kind === 'SALE' ? computeAttribution : computeCallAttribution;
    const a = compute(cohort, options(state.modelA));
    const b = compute(cohort, options(state.modelB));
    const rows = pairedRows(a, b, state.kind);
    const metric = state.kind === 'SALE' ? 'revenue' : 'conversions';
    const credited = a.rows.reduce((sum, row) => sum + row.conversions, 0);
    const withPaths = cohort.filter((conversion) => conversion.path?.length).length;
    const missingAmount = cohort.filter((conversion) => finiteAmount(conversion.amount) === null).length;
    const unknownDates = block.conversions.filter((conversion) => !conversion?.date).length;
    const first = cohort.filter((conversion) => conversion.firstSale === true).length;
    const repeat = cohort.filter((conversion) => conversion.firstSale === false).length;
    const complete = block.coverage?.complete === true && !block.coverage?.truncated;
    const cohortUnavailable = !cohort.length && !complete;
    const amountsUnavailable = state.kind === 'SALE' && (cohortUnavailable || (cohort.length > 0 && missingAmount === cohort.length));
    state.cohortAvailable = !cohortUnavailable;
    state.revenueAvailable = !amountsUnavailable;
    state.unknownAmounts = missingAmount;
    const format = (value) => cohortUnavailable || amountsUnavailable ? 'Unknown' : state.kind === 'SALE' ? money(value) : number(value);
    const max = Math.max(1, ...rows.flatMap((row) => [Math.abs(row.a[metric]), Math.abs(row.b[metric])]));
    const pages = Math.max(1, Math.ceil(cohort.length / PAGE_SIZE));
    state.page = Math.min(state.page, pages - 1);
    const coreRange = narrowed ? selected : ctx.snapshot?.ranges?.['30d'];
    const coreModel = ctx.snapshot?.attributionModel || ctx.snapshot?.settings?.model || 'Unknown';
    const coreTotal = finiteAmount(coreRange?.totals?.[state.kind === 'SALE' ? 'revenue' : 'calls']);
    const weightControls = state.modelA === 'position' || state.modelB === 'position';
    const decayControls = state.modelA === 'decay' || state.modelB === 'decay';
    const errors = Array.isArray(block.errors) ? block.errors : [];
    const note = [
      block.stale ? `Showing the previous result (${ctx.fmt?.datetime ? ctx.fmt.datetime(block.checkedAt || baseWindow.end) : block.checkedAt || baseWindow.end || 'unknown date'}). ${block.skipped || ''}` : '',
      block.error ? `Error: ${block.error}` : '',
      ctx.demo ? 'Illustrative demo cohort; seeded paths are not observed journeys.' : '',
      !complete ? 'Sampled cohort; incomplete pagination can omit conversions. This is not a random sample or an account total.' : '',
      missingAmount && state.kind === 'SALE' ? `${missingAmount} sales have unknown account-currency amounts; revenue totals include known amounts only.` : '',
      differentWindow && unknownDates ? `${unknownDates} conversions with unknown dates cannot be assigned to this range.` : '',
      ...errors,
    ].filter(Boolean);
    const tiles = [
      { label: state.kind === 'SALE' ? 'Sampled sales' : 'Sampled calls', value: number(cohort.length), sub: `${number(withPaths)} with recorded paths` },
      { label: 'Eligible conversion credit', value: cohortUnavailable ? 'Unknown' : number(credited), sub: cohortUnavailable ? 'Cohort incomplete' : `${number(Math.max(0, cohort.length - credited))} unattributed` },
      ...(state.kind === 'SALE' ? [
        { label: 'Known SALE revenue', value: amountsUnavailable ? 'Unknown' : ctx.fmt?.money ? ctx.fmt.money(a.totalRevenue) : number(a.totalRevenue), sub: accountCurrency || 'Currency unknown' },
        { label: 'Unattributed revenue', value: amountsUnavailable ? 'Unknown' : ctx.fmt?.money ? ctx.fmt.money(a.unattributedRevenue) : number(a.unattributedRevenue), sub: 'No eligible touch' },
      ] : [{ label: 'First / repeat calls', value: `${first} / ${repeat}`, sub: `${cohort.length - first - repeat} unknown` }]),
    ];
    const kpis = ctx.kpis ? ctx.kpis(tiles) : tiles.map((tile) => `<div class="kpi"><div class="kpi-label">${esc(tile.label)}</div><div class="kpi-value">${esc(tile.value)}</div><div class="sub">${esc(tile.sub)}</div></div>`).join('');
    const evidence = (conversion) => {
      const ca = getTouchCredits(conversion, options(state.modelA));
      const cb = getTouchCredits(conversion, options(state.modelB));
      return `<tr><td colspan="4"><details><summary><span>${esc(conversion.id || 'Unknown conversion')}</span><span>${date(conversion.date)}</span><span>${state.kind === 'SALE' ? (finiteAmount(conversion.amount) === null ? 'Amount unknown' : money(conversion.amount)) : 'CALL'}</span><span>${conversion.firstSale === true ? 'First' : conversion.firstSale === false ? 'Repeat' : 'First/repeat unknown'}</span></summary>
        <div class="attribution-evidence-meta">Lead ID: ${esc(conversion.leadId || 'Unknown')}</div>
        ${ca.length ? `<div class="attribution-scroll"><table class="attribution-touches"><thead><tr><th>Source / ad</th><th>Touch date</th><th>${LABELS[state.modelA]}</th><th>${LABELS[state.modelB]}</th><th>Status</th></tr></thead><tbody>${ca.map((entry, index) => `<tr><td>${esc(entry.touch?.name || entry.touch?.id || 'Unknown source')}${entry.touch?.adName ? `<span class="sub">${esc(entry.touch.adName)}</span>` : ''}</td><td>${date(entry.touch?.date)}</td><td>${number(entry.weight * 100)}%</td><td>${number(cb[index]?.weight * 100)}%</td><td>${esc(entry.reason || (entry.touch?.organic === true ? 'Organic' : entry.touch?.organic === false ? 'Paid' : 'Organic status unknown'))}</td></tr>`).join('')}</tbody></table></div>` : '<div class="attribution-empty">No recorded path; unattributed.</div>'}</details></td></tr>`;
    };
    root.innerHTML = `<div class="attribution">
      <header class="attribution-heading"><h2>Attribution Lab</h2><div class="attribution-context">${esc(window.start || 'Unknown')} to ${esc(window.end || 'Unknown')} <span class="pill ${complete ? 'ok' : 'warn'}">${complete ? 'Complete pagination' : 'Sampled'}</span></div></header>
      ${note.length ? `<div class="note" role="status">${note.map(esc).join('<br>')}</div>` : ''}
      <div class="attribution-toolbar">
        <div class="attribution-segment" role="group" aria-label="Conversion type">${['SALE', 'CALL'].map((kind) => `<button type="button" data-kind="${kind}" aria-pressed="${state.kind === kind}">${kind === 'SALE' ? 'Sales' : 'Calls'}</button>`).join('')}</div>
        ${menu('modelA', 'Model A')}${menu('modelB', 'Model B')}
        <label>Touch window<select data-setting="windowDays" aria-label="Touch window">${[0, 1, 7, 14, 30, 60, 90, 365].map((days) => `<option value="${days}" ${state.windowDays === days ? 'selected' : ''}>${days ? `${days} days` : 'All recorded'}</option>`).join('')}</select></label>
        <label class="attribution-check"><input type="checkbox" data-setting="includeOrganic" ${state.includeOrganic ? 'checked' : ''}> Include organic</label>
        <button type="button" class="attribution-export" data-export title="Export comparison CSV" aria-label="Export comparison CSV"><span aria-hidden="true">&darr;</span> CSV</button>
      </div>
      ${weightControls || decayControls ? `<div class="attribution-weights">${weightControls ? ['first', 'middle', 'last'].map((key) => `<label>${key === 'middle' ? 'Middle total' : key === 'first' ? 'First' : 'Last'} weight<input type="number" min="0" max="100" step="1" data-weight="${key}" value="${state.positionWeights[key]}"></label>`).join('') : ''}${decayControls ? `<label>Half-life (days)<input type="number" min="0.1" max="365" step="0.1" data-setting="halfLifeDays" value="${state.halfLifeDays}"></label>` : ''}</div>` : ''}
      <div class="kpis">${kpis}</div>
      <section class="attribution-section"><div class="attribution-section-head"><h3>Source credit</h3><span class="sub">${state.kind === 'SALE' ? 'Known account-currency amounts; native sale price, before refund adjustments' : 'Fractional CALL counts; no SALE revenue'}</span></div>
        <div class="attribution-scroll"><table><thead><tr><th>Source</th><th>${LABELS[state.modelA]}<span class="sub">Model A</span></th><th>${LABELS[state.modelB]}<span class="sub">Model B</span></th><th>B - A</th><th>Conversion credit A / B</th><th>Touches</th><th>Credit share</th></tr></thead><tbody>
        ${rows.map((row) => `<tr><td><details><summary>${esc(row.name)}</summary><span class="sub">Source ID: ${esc(row.sourceId)}</span><span class="sub">${number(row.a.touches || row.b.touches)} eligible touches</span></details></td><td>${format(row.a[metric])}</td><td>${format(row.b[metric])}</td><td>${format(row.b[metric] - row.a[metric])}</td><td>${number(row.a.conversions)} / ${number(row.b.conversions)}</td><td>${number(row.a.touches || row.b.touches)}</td><td><div class="attribution-bars" aria-label="Model A ${esc(number(row.a[metric]))}; Model B ${esc(number(row.b[metric]))}"><span style="width:${Math.abs(row.a[metric]) / max * 100}%"></span><span style="width:${Math.abs(row.b[metric]) / max * 100}%"></span></div></td></tr>`).join('')}
        <tr class="attribution-total"><td>Unattributed</td><td>${format(state.kind === 'SALE' ? a.unattributedRevenue : Math.max(0, cohort.length - credited))}</td><td>${format(state.kind === 'SALE' ? b.unattributedRevenue : Math.max(0, cohort.length - credited))}</td><td>${format(0)}</td><td>${cohortUnavailable ? 'Unknown' : `${number(Math.max(0, cohort.length - credited))} / ${number(Math.max(0, cohort.length - credited))}`}</td><td></td><td></td></tr>
        </tbody></table></div>${!cohort.length ? '<div class="attribution-empty">No conversions of this type in the fetched cohort.</div>' : ''}
      </section>
      <section class="attribution-section"><h3>Current core model: ${esc(coreModel)}</h3><div class="attribution-core"><strong>${coreTotal === null ? 'Unavailable' : state.kind === 'SALE' ? money(coreTotal) : number(coreTotal)}</strong><span>${esc(coreRange?.start || 'Unknown')} to ${esc(coreRange?.end || 'Unknown')}</span><span>${state.kind === 'SALE' ? 'Core report revenue' : 'Core report calls'}</span></div><p class="sub">Separate report cohort and settings; totals are not a same-conversion comparison. Native Scientific is supplied by the core server report only.</p></section>
      <section class="attribution-section"><details><summary class="attribution-summary">Coverage and model rules</summary><dl class="attribution-facts"><dt>Fetched conversions / with paths</dt><dd>${esc(block.coverage?.sampled ?? 'Unknown')} / ${esc(block.coverage?.withPaths ?? 'Unknown')}</dd><dt>Selected ${state.kind === 'SALE' ? 'sales' : 'calls'} / with paths</dt><dd>${cohort.length} / ${withPaths}</dd><dt>First / repeat / unknown</dt><dd>${first} / ${repeat} / ${cohort.length - first - repeat}</dd><dt>Checked</dt><dd>${date(block.checkedAt)}</dd><dt>Pagination</dt><dd>${complete ? 'Completed for SALE and CALL' : 'Incomplete; see status above'}</dd><dt>Credit</dt><dd>First / last: 100% to the selected touch. Linear: equal per eligible touch. Position: normalized first / middle-total / last weights; two touches split endpoint weights. Decay: relative age with the selected half-life.</dd><dt>Exclusions</dt><dd>Disregarded, future, undated and out-of-window touches. Organic off also excludes unknown organic status. Repeated touches share one conversion amount; repeated conversion IDs count once.</dd><dt>Recorded history</dt><dd>The native tracking timeframe may already limit each path. A wider local window cannot recover missing history.</dd></dl></details></section>
      <section class="attribution-section"><div class="attribution-section-head"><h3>Conversion evidence</h3><div class="attribution-pagination"><button type="button" data-page="-1" aria-label="Previous evidence page" title="Previous evidence page" ${state.page === 0 ? 'disabled' : ''}>&larr;</button><span>${state.page + 1} / ${pages}</span><button type="button" data-page="1" aria-label="Next evidence page" title="Next evidence page" ${state.page + 1 >= pages ? 'disabled' : ''}>&rarr;</button></div></div><div class="attribution-scroll"><table class="attribution-evidence"><thead><tr><th>Conversion</th><th>Date</th><th>${state.kind === 'SALE' ? 'Amount' : 'Type'}</th><th>First / repeat</th></tr></thead><tbody>${cohort.slice(state.page * PAGE_SIZE, (state.page + 1) * PAGE_SIZE).map(evidence).join('')}</tbody></table></div></section>
    </div>`;

    const bind = (selector, event, handler) => {
      for (const element of root.querySelectorAll?.(selector) || []) element.addEventListener?.(event, handler);
    };
    bind('[data-kind]', 'click', (event) => { state.kind = event.currentTarget.dataset.kind; state.page = 0; draw(); });
    bind('[data-setting]', 'change', (event) => {
      const element = event.currentTarget;
      const key = element.dataset.setting;
      if (key === 'includeOrganic') state[key] = element.checked;
      else if (key === 'modelA' || key === 'modelB') state[key] = ATTRIBUTION_MODELS.includes(element.value) ? element.value : 'first';
      else if (key === 'halfLifeDays') state[key] = Math.min(365, Math.max(0.1, Number(element.value) || 7));
      else state[key] = Math.min(365, Math.max(0, Number(element.value) || 0));
      state.page = 0;
      draw();
    });
    bind('[data-weight]', 'change', (event) => {
      state.positionWeights[event.currentTarget.dataset.weight] = Math.min(100, Math.max(0, Number(event.currentTarget.value) || 0));
      draw();
    });
    bind('[data-page]', 'click', (event) => { state.page = Math.max(0, Math.min(pages - 1, state.page + Number(event.currentTarget.dataset.page))); draw(); });
    bind('[data-export]', 'click', () => {
      const document = root.ownerDocument;
      if (!document?.createElement || typeof URL?.createObjectURL !== 'function') return;
      const csv = comparisonCsv({ rows, a, b, state, window, coverage: block.coverage, currency: accountCurrency });
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `attribution-${state.kind.toLowerCase()}-${window.end || 'snapshot'}.csv`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }
  draw();
}

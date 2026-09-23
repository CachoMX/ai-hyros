import { finite, positive, observedPoints, attributionRole, historicalScenario, curveAssessment } from './analysis.js';

const LEVEL_WORD = { ACCOUNT: 'Ad account', CAMPAIGN: 'Campaign', SOURCE_LINK: 'Ad set', AD: 'Ad' };
const BASIS_WORD = { CALLER_PROVIDED: 'caller provided', LTV_BREAKEVEN: 'LTV breakeven', REALIZED_LTV_90_DAYS: 'realized LTV 90 days' };
const NOTE_WORD = {
  NO_SPEND_DATA: 'No spend history in the window', NO_CUSTOMERS: 'No customers attributed in the window',
  INSUFFICIENT_DATA: 'Not enough spend history to build a curve', LTV_CEILING_UNAVAILABLE: 'No LTV ceiling available for this entity',
  UNEXPECTED_REPLY: 'The curve reply could not be read', CURVE_TRUNCATED: 'Only the first 120 spend buckets are shown',
  INVALID_POINTS_OMITTED: 'Invalid spend buckets were omitted',
};
const words = (value) => String(value || '').toLowerCase().replace(/_/g, ' ');
const states = new WeakMap();

function stateFor(ctx) {
  const scope = `${ctx.account || ''}:${Boolean(ctx.demo)}`;
  let state = states.get(ctx.root);
  if (!state || state.scope !== scope || state.block !== ctx.block) {
    state = { scope, block: ctx.block, ceiling: '', indices: new Map() };
    states.set(ctx.root, state);
  }
  return state;
}

/** Missing samples split paths; they must not look like measured intermediate data. */
export function curveSvg(c, fmt, comparisonCeiling = null) {
  const W = 520, H = 170, T = 8, B = 4;
  const pts = observedPoints(c);
  if (pts.length < 2) return '';
  const xs = pts.map((p) => p.spend);
  const ys = pts.flatMap((p) => [p.avgCac, p.marginalCac]).filter(finite);
  if (!ys.length) return '';
  if (positive(c.ceiling)) ys.push(c.ceiling);
  if (positive(comparisonCeiling)) ys.push(comparisonCeiling);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const yMin = Math.min(0, ...ys), yMax = Math.max(0, ...ys) * 1.1 || 1;
  const X = (value) => ((value - xMin) / (xMax - xMin || 1)) * W;
  const Y = (value) => T + (1 - (value - yMin) / (yMax - yMin || 1)) * (H - T - B);
  const path = (key) => {
    let connected = false;
    return pts.map((p) => {
      if (!finite(p[key])) { connected = false; return ''; }
      const command = connected ? 'L' : 'M';
      connected = true;
      return `${command}${X(p.spend).toFixed(1)},${Y(p[key]).toFixed(1)}`;
    }).join(' ');
  };
  const ticksY = [yMin, (yMin + yMax) / 2, yMax];
  const money = (value) => (fmt.money0 || fmt.money)(value);
  const line = (value, cls) => `<line class="${cls}" vector-effect="non-scaling-stroke" x1="0" x2="${W}" y1="${Y(value)}" y2="${Y(value)}"/>`;
  const sat = c.saturationSpend;
  return `<div class="scale-plot">
    <div class="scale-ylabels">${[...ticksY].reverse().map((value) => `<span>${money(value)}</span>`).join('')}</div>
    <svg class="scale-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Historical average and marginal CAC by daily spend">
      ${ticksY.map((value) => line(value, 'grid')).join('')}${line(0, 'axis')}
      ${positive(c.ceiling) ? line(c.ceiling, 'ceil') : ''}${positive(comparisonCeiling) ? line(comparisonCeiling, 'comparison') : ''}
      ${finite(sat) && sat >= xMin && sat <= xMax ? `<line class="sat" vector-effect="non-scaling-stroke" x1="${X(sat)}" x2="${X(sat)}" y1="0" y2="${H}"/>` : ''}
      <path class="avg" vector-effect="non-scaling-stroke" d="${path('avgCac')}"/>
      <path class="marg" vector-effect="non-scaling-stroke" d="${path('marginalCac')}"/>
    </svg>
    <div class="scale-xlabels">${[xMin, (xMin + xMax) / 2, xMax].map((value) => `<span>${money(value)}/day</span>`).join('')}</div>
  </div><div class="scale-legend"><span><i></i>Average CAC</span><span><i class="marg"></i>Marginal CAC</span>
    ${positive(c.ceiling) ? '<span><i class="ceil"></i>HYROS ceiling</span>' : ''}${positive(comparisonCeiling) ? '<span><i class="comparison"></i>Comparison ceiling</span>' : ''}${finite(sat) ? '<span><i class="sat"></i>Reported saturation</span>' : ''}</div>`;
}

function unavailableCard(curves, esc) {
  const messages = [...new Set(curves.map((c) => String(c.error || '').trim()).filter(Boolean))];
  const transient = curves.some((c) => ['timeout', 'rate_limited'].includes(c.errorCode));
  return `<section class="scale-unavailable"><h3>Curves unavailable</h3>
    <div class="note err"><b>HYROS did not answer the CAC curve tool</b> (${esc(messages[0] || 'no reply')}).
      ${transient ? 'Retry on the next refresh. No new curve was verified.' : 'Ask HYROS support whether the marginal CAC curve is enabled for this account.'}
      ${messages.length > 1 ? `<br>${esc(messages.slice(1).join(' / '))}` : ''}</div>
    <div class="sub">${curves.length} requested entities returned errors.</div></section>`;
}

function scenarioMarkup(c, index, userCeiling, ctx) {
  const { fmt, esc } = ctx;
  const points = observedPoints(c);
  const scenario = historicalScenario(c, index, userCeiling);
  const p = scenario.bucket;
  if (!p) return '';
  const money = (value) => finite(value) ? fmt.money(value) : 'Unavailable';
  const comparison = scenario.status === 'unknown' ? 'Cannot compare: marginal CAC or ceiling unavailable.'
    : scenario.status === 'above' ? 'Observed marginal CAC above ceiling.' : 'Observed marginal CAC within ceiling.';
  return `<div class="scale-scenario">
    <label>Historical spend bucket<select data-scale-bucket aria-label="Historical daily spend bucket">${points.map((point, i) => `<option value="${i}" ${i === index ? 'selected' : ''}>${esc(fmt.money(point.spend))}/day</option>`).join('')}</select></label>
    <dl><div><dt>Average CAC</dt><dd>${money(p.avgCac)}</dd></div><div><dt>Marginal CAC</dt><dd>${money(p.marginalCac)}</dd></div><div><dt>Sample</dt><dd>${finite(p.days) ? `${fmt.int(p.days)} days` : 'days unavailable'} / ${finite(p.customers) ? `${fmt.int(p.customers)} customers` : 'customers unavailable'}</dd></div></dl>
    <p class="${scenario.status === 'above' ? 'bad' : ''}">${esc(comparison)} ${scenario.ceiling !== null ? `${esc(fmt.money(scenario.ceiling))} (${esc(scenario.source)}).` : ''}</p>
    <div class="sub">${ctx.demo ? 'Illustrative demo scenario' : 'Observed historical scenario'}; not a prediction. No extrapolation beyond sampled spend.</div>
  </div>`;
}

function curveCard(c, index, state, ctx) {
  const { fmt, esc } = ctx;
  const userCeiling = positive(Number(state.ceiling)) ? Number(state.ceiling) : null;
  const v = curveAssessment(c, userCeiling);
  const points = observedPoints(c);
  const last = points.at(-1);
  const basis = [BASIS_WORD[c.ceilingBasis] || words(c.ceilingBasis), words(c.ltvWindow)].filter(Boolean).join(' / ');
  const selection = Math.min(state.indices.get(index) || 0, Math.max(0, points.length - 1));
  const notes = (Array.isArray(c.notes) ? c.notes : []).map((note) => NOTE_WORD[note] || String(note));
  return `<article class="scale-card" data-scale-curve="${index}">
    <div class="scale-head"><span class="pill">${esc(LEVEL_WORD[c.level] || c.level || 'Entity')}</span><b>${esc(c.name || c.id || 'Unnamed')}</b>
      <span class="sub">${esc(attributionRole(c.attributionModel))}${c.attributionModel ? ` / ${esc(words(c.attributionModel))}` : ''}${c.category ? ` / ${esc(c.category)}` : ''}${c.daysSampled ? ` / ${esc(c.daysSampled)} days sampled` : ''}</span>
      <span class="scale-verdict ${v.cls}">${esc(v.text)}</span></div>
    ${c.stale ? `<p class="scale-caveat">Previous curve${c.checkedAt ? ` from ${esc(fmt.datetime(c.checkedAt))}` : ''}${c.window ? `; ${esc(c.window.start)} to ${esc(c.window.end)}` : ''}.</p>` : ''}
    ${c.error || c.skipped ? `<p class="scale-caveat">${esc(c.error || c.skipped)}${c.retry ? ` Retry: ${esc(c.retry)}.` : ''}</p>` : ''}
    ${notes.length ? `<ul class="scale-caveat">${notes.map((note) => `<li>${esc(note)}</li>`).join('')}</ul>` : ''}
    ${points.length ? `<div class="scale-body"><div>${curveSvg(c, fmt, userCeiling) || '<div class="empty">Not enough CAC samples to draw a curve.</div>'}</div>
      <dl class="scale-stats"><div class="scale-stat"><dt>HYROS CAC ceiling</dt><dd>${positive(c.ceiling) ? fmt.money(c.ceiling) : 'Unavailable'}</dd><span class="sub">${esc(basis || 'No ceiling returned')}</span></div>
      <div class="scale-stat"><dt>Reported saturation</dt><dd>${finite(c.saturationSpend) ? `${fmt.money(c.saturationSpend)}/day` : 'Not reported'}</dd>${finite(c.efficientSpend) ? `<span class="sub">Reported efficient bound ${fmt.money(c.efficientSpend)}/day</span>` : ''}${c.saturationReason ? `<span class="sub">${esc(words(c.saturationReason))}</span>` : ''}</div>
      <div class="scale-stat"><dt>Marginal CAC at highest spend</dt><dd>${finite(last?.marginalCac) ? fmt.money(last.marginalCac) : 'Unavailable'}</dd><span class="sub">${fmt.money(last.spend)}/day sampled</span></div></dl></div>
      ${scenarioMarkup(c, selection, userCeiling, ctx)}
      <details class="scale-history"><summary>Observed buckets (${points.length})</summary><div class="scale-table-wrap"><table><thead><tr><th>Spend / day</th><th>Days</th><th>Customers</th><th>Average CAC</th><th>Marginal CAC</th></tr></thead><tbody>${points.map((p) => `<tr><td>${fmt.money(p.spend)}</td><td>${finite(p.days) ? fmt.int(p.days) : 'Unknown'}</td><td>${finite(p.customers) ? fmt.int(p.customers) : 'Unknown'}</td><td>${finite(p.avgCac) ? fmt.money(p.avgCac) : 'Unknown'}</td><td>${finite(p.marginalCac) ? fmt.money(p.marginalCac) : 'Unknown'}</td></tr>`).join('')}</tbody></table></div></details>` : '<div class="empty">No curve points returned.</div>'}
  </article>`;
}

export function render(ctx) {
  const { fmt, esc, kpis } = ctx;
  const sc = ctx.block;
  if (!sc || typeof sc !== 'object') { ctx.root.innerHTML = '<div class="note">No curves in this snapshot. Refresh to request them.</div>'; return; }
  const state = stateFor(ctx);
  const curves = (Array.isArray(sc.curves) ? sc.curves : []).filter((c) => c && typeof c === 'object');
  const analyzed = curves.filter((c) => !c.skipped && !c.error && !c.stale);
  const withData = analyzed.filter((c) => observedPoints(c).length);
  const saturated = withData.filter((c) => finite(c.saturationSpend));
  const allFailed = curves.length > 0 && curves.every((c) => c.error && !observedPoints(c).length);
  const when = sc.checkedAt || sc.window?.end;
  const status = sc.error ? `<br><b>Error:</b> ${esc(sc.error)}`
    : sc.stale ? `<br>Showing curves from a previous refresh${when ? ` (${esc(fmt.datetime(when))})` : ''}. ${esc(sc.skipped || '')}`
      : sc.skipped ? `<br>Skipped this refresh (${esc(sc.skipped)}). No curves were computed yet.` : '';
  const comparison = Number(state.ceiling);
  const requestCeiling = positive(sc.configuredCeiling) ? `Account request ceiling: ${fmt.money(sc.configuredCeiling)}.`
    : sc.configuredCeiling === null ? 'No account request ceiling configured.' : 'Account request ceiling not recorded in this snapshot.';
  ctx.root.innerHTML = `<div class="note"><b>Scale Advisor.</b> ${sc.window ? `${esc(sc.window.start)} to ${esc(sc.window.end)}.` : ''}
    Historical observations, not predictions.${ctx.demo ? ' <span class="pill warn">demo sample</span>' : ''}${status}</div>
    ${allFailed ? '' : `<div class="kpis">${kpis([
      { label: 'Entities analyzed', value: fmt.int(analyzed.length), sub: `${curves.filter((c) => c.skipped).length} skipped / ${curves.filter((c) => c.error).length} failed` },
      { label: 'With spend history', value: fmt.int(withData.length), sub: 'fresh curves only' },
      { label: 'Saturation found', value: fmt.int(saturated.length), sub: 'reported by HYROS' },
      { label: 'Ceiling unavailable', value: fmt.int(withData.filter((c) => !positive(c.ceiling)).length), sub: 'efficiency unassessed' },
    ])}</div>`}
    ${(Array.isArray(sc.notes) ? sc.notes : []).map((note) => `<p class="scale-caveat">${esc(note)}</p>`).join('')}
    ${curves.some((c) => observedPoints(c).length) ? `<form class="scale-controls" data-scale-form><label>Comparison CAC ceiling<input data-scale-ceiling type="number" min="0.01" step="any" inputmode="decimal" value="${esc(state.ceiling)}" placeholder="Use HYROS ceiling" aria-describedby="scale-ceiling-note"></label><button type="submit">Compare</button><button type="button" data-scale-reset ${state.ceiling ? '' : 'disabled'}>Reset comparison</button><span class="sub" id="scale-ceiling-note">${positive(comparison) ? `Local ceiling: ${esc(fmt.money(comparison))}. ` : ''}Local comparison only. ${esc(requestCeiling)}</span></form>` : ''}
    ${allFailed ? unavailableCard(curves, esc) : curves.length ? curves.map((curve, index) => curveCard(curve, index, state, ctx)).join('') : '<div class="empty">No curves to show.</div>'}`;
  const root = ctx.root;
  root.querySelector?.('[data-scale-form]')?.addEventListener?.('submit', (event) => {
    event.preventDefault();
    const input = root.querySelector?.('[data-scale-ceiling]');
    if (!input) return;
    if (input.value !== '' && !positive(Number(input.value))) { input.setCustomValidity?.('Enter a positive CAC ceiling.'); input.reportValidity?.(); return; }
    input.setCustomValidity?.('');
    state.ceiling = input.value;
    render(ctx);
  });
  root.querySelector?.('[data-scale-ceiling]')?.addEventListener?.('input', (event) => event.currentTarget.setCustomValidity?.(''));
  root.querySelector?.('[data-scale-reset]')?.addEventListener?.('click', () => { state.ceiling = ''; render(ctx); });
  for (const node of root.querySelectorAll?.('[data-scale-bucket]') || []) node.addEventListener?.('change', (event) => {
    const index = Number(event.currentTarget.closest?.('[data-scale-curve]')?.dataset.scaleCurve);
    if (!Number.isInteger(index)) return;
    state.indices.set(index, Number(event.currentTarget.value));
    render(ctx);
  });
}

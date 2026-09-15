/** Scale Advisor — marginal CAC curves. Renders ctx.block into ctx.root. */
const LEVEL_WORD = { ACCOUNT: 'Ad account', CAMPAIGN: 'Campaign', SOURCE_LINK: 'Ad set', AD: 'Ad' };
const BASIS_WORD = { CALLER_PROVIDED: 'caller provided', LTV_BREAKEVEN: 'LTV breakeven', REALIZED_LTV_90_DAYS: 'realized LTV 90 days' };
const NOTE_WORD = {
  NO_SPEND_DATA: 'No spend history in the window',
  NO_CUSTOMERS: 'No customers attributed in the window',
  INSUFFICIENT_DATA: 'Not enough spend history to build a curve',
  LTV_CEILING_UNAVAILABLE: 'No LTV ceiling available for this entity',
};

const words = (s) => String(s || '').toLowerCase().replace(/_/g, ' ');
const ltvWindowWord = (w) => (w ? words(w).replace(/^(\d+) (\w+)$/, '$1 $2') : '');

/** Inline SVG: average + marginal CAC vs daily spend, ceiling and saturation lines. */
function curveSvg(c) {
  const W = 520, H = 180, L = 46, R = 12, T = 12, B = 26;
  const pts = c.points.filter((p) => p.spend !== null);
  if (pts.length < 2) return '';
  const xs = pts.map((p) => p.spend);
  const ys = pts.flatMap((p) => [p.avgCac, p.marginalCac]).filter((v) => v !== null);
  if (c.ceiling) ys.push(c.ceiling);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const yMax = Math.max(...ys) * 1.1 || 1;
  const X = (v) => L + ((v - xMin) / ((xMax - xMin) || 1)) * (W - L - R);
  const Y = (v) => T + (1 - v / yMax) * (H - T - B);
  const path = (key) => pts.filter((p) => p[key] !== null)
    .map((p, i) => `${i ? 'L' : 'M'}${X(p.spend).toFixed(1)},${Y(p[key]).toFixed(1)}`).join(' ');
  const ticksY = [0, 0.5, 1].map((f) => f * yMax);
  const ticksX = [xMin, (xMin + xMax) / 2, xMax];
  const sat = c.saturationSpend;
  return `<svg class="scale-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="CAC curve">
    ${ticksY.map((v) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}"/>
      <text x="${L - 4}" y="${Y(v) + 3}" text-anchor="end">$${Math.round(v)}</text>`).join('')}
    ${ticksX.map((v, i) => `<text x="${X(v)}" y="${H - 8}" text-anchor="${i === 0 ? 'start' : i === 2 ? 'end' : 'middle'}">$${Math.round(v)}/day</text>`).join('')}
    <line class="axis" x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}"/>
    ${c.ceiling ? `<line class="ceil" x1="${L}" x2="${W - R}" y1="${Y(c.ceiling)}" y2="${Y(c.ceiling)}"/>` : ''}
    ${sat !== null && sat !== undefined && sat >= xMin && sat <= xMax
      ? `<line class="sat" x1="${X(sat)}" x2="${X(sat)}" y1="${T}" y2="${H - B}"/>` : ''}
    <path class="avg" d="${path('avgCac')}"/>
    <path class="marg" d="${path('marginalCac')}"/>
  </svg>
  <div class="scale-legend"><span><i></i>Average CAC</span><span><i class="marg"></i>Marginal CAC (next customer)</span>
    ${c.ceiling ? '<span><i class="ceil"></i>CAC ceiling</span>' : ''}${sat !== null && sat !== undefined ? '<span><i class="sat"></i>Saturation</span>' : ''}</div>`;
}

function curveVerdict(c, fmt) {
  if (c.error) return { cls: 'bad', text: 'Curve unavailable' };
  if (c.skipped) return { cls: '', text: 'Skipped — refresh time budget' };
  const points = c.points || [];
  if (!points.length) {
    const note = (c.notes || []).find((n) => NOTE_WORD[n]);
    return { cls: '', text: note ? NOTE_WORD[note] : 'Not enough data yet' };
  }
  const last = points[points.length - 1];
  const current = points.reduce((m, p) => (p.customers !== null && p.customers > (m?.customers ?? -1) ? p : m), null);
  const sat = c.saturationSpend ?? null;
  if (sat === null) {
    const why = c.ceiling === null || c.ceiling === undefined ? ' (no CAC ceiling at this level)' : ' — no saturation found';
    return { cls: 'good', text: `Still efficient at ${fmt.money(last.spend)}/day${why}` };
  }
  const headroom = sat - (current?.spend ?? last.spend);
  return headroom > 0
    ? { cls: 'good', text: `Saturates at ${fmt.money(sat)}/day` }
    : { cls: 'bad', text: `Past saturation (${fmt.money(sat)}/day) — next dollar costs more than the ceiling` };
}

/** One card for the "HYROS did not answer" case (e.g. the tool returns HTTP 404 on this account). */
function unavailableCard(curves, esc) {
  const messages = [...new Set(curves.map((c) => String(c.error || '').trim()).filter(Boolean))];
  return `<div class="fpanel scale-card"><h3>Curves unavailable</h3>
    <div class="note err"><b>HYROS did not answer the CAC curve tool</b> (${esc(messages[0] || 'no reply')}).
      Ask HYROS support whether the marginal CAC curve is enabled for this account.
      ${messages.length > 1 ? `<br><span class="sub">Other replies: ${esc(messages.slice(1).join(' · '))}</span>` : ''}</div>
    <div class="sub">${esc(String(curves.length))} entities were requested (<code>hyros_get_marginal_cac_curve</code>); every call failed.</div>
  </div>`;
}

function curveCard(c, fmt, esc) {
  const v = curveVerdict(c, fmt);
  const points = c.points || [];
  const last = points[points.length - 1];
  const basis = BASIS_WORD[c.ceilingBasis] || words(c.ceilingBasis);
  const ceilingSub = [basis, c.ltvWindow ? ltvWindowWord(c.ltvWindow) : ''].filter(Boolean).join(' · ') || '—';
  const sat = c.saturationSpend ?? null;
  return `<div class="fpanel scale-card">
    <div class="scale-head">
      <span class="pill">${esc(LEVEL_WORD[c.level] || c.level)}</span>
      <b>${esc(c.name || c.id)}</b>
      <span class="sub">${c.category ? esc(c.category) + ' · ' : ''}${c.daysSampled ? `${esc(String(c.daysSampled))} days sampled` : ''}</span>
      <span class="scale-verdict ${v.cls}">${esc(v.text)}</span>
    </div>
    ${points.length >= 2 ? `<div class="scale-body">
      <div>${curveSvg(c)}</div>
      <div class="scale-stats">
        <div class="scale-stat"><div class="kpi-label">CAC ceiling</div><b>${c.ceiling !== null && c.ceiling !== undefined ? fmt.money(c.ceiling) : '—'}</b>
          <div class="sub">${esc(ceilingSub)}</div></div>
        <div class="scale-stat"><div class="kpi-label">Saturation spend</div><b>${sat !== null ? `${fmt.money(sat)}/day` : '—'}</b>
          ${c.efficientSpend !== null && c.efficientSpend !== undefined ? `<div class="sub">efficient up to ${fmt.money(c.efficientSpend)}/day</div>` : ''}
          ${c.saturationReason ? `<div class="sub">${esc(words(c.saturationReason))}</div>` : ''}</div>
        <div class="scale-stat"><div class="kpi-label">Marginal CAC at top of range</div><b>${last?.marginalCac !== null && last?.marginalCac !== undefined ? fmt.money(last.marginalCac) : '—'}</b>
          <div class="sub">at ${fmt.money(last?.spend)}/day</div></div>
      </div>
    </div>` : `<div class="sub">${esc(c.error || c.skipped || (c.notes || []).map((n) => NOTE_WORD[n] || n).join(', ') || 'No curve points returned.')}</div>`}
  </div>`;
}

export function render(ctx) {
  const { fmt, esc, kpis } = ctx;
  const sc = ctx.block;
  if (!sc || typeof sc !== 'object') { ctx.root.innerHTML = '<div class="fpanel"><div class="empty">No curves in this snapshot — hit Refresh.</div></div>'; return; }
  const curves = Array.isArray(sc.curves) ? sc.curves : [];
  const analyzed = curves.filter((c) => !c.skipped);
  const withData = analyzed.filter((c) => c.points?.length);
  const saturated = withData.filter((c) => c.saturationSpend !== null && c.saturationSpend !== undefined);
  const allFailed = curves.length > 0 && curves.every((c) => c.error);
  const when = sc.checkedAt || sc.window?.end;

  // Status: fresh / stale (previous curves shown again) / bare skipped / error.
  const status = sc.error ? `<br><b>Error:</b> ${esc(sc.error)}`
    : sc.skipped && sc.stale ? `<br><b>Showing curves from a previous refresh</b>${when ? ` (${esc(fmt.datetime(when))})` : ''} — skipped this refresh: ${esc(sc.skipped)}.`
      : sc.skipped ? `<br>Skipped this refresh (${esc(sc.skipped)}) — no curves were computed yet. Hit Refresh again.`
        : '';

  const cards = allFailed ? unavailableCard(curves, esc)
    : curves.length ? curves.map((c) => curveCard(c, fmt, esc)).join('')
      : `<div class="fpanel"><div class="empty">${sc.skipped || sc.error ? 'No curves to show.' : 'No curves in this snapshot — hit Refresh.'}</div></div>`;

  ctx.root.innerHTML = `
    <div class="note"><b>Scale Advisor.</b> How the cost of the <i>next</i> customer
      changes as daily spend rises, computed by HYROS from this account's own spend history
      (<code>hyros_get_marginal_cac_curve</code>, first-click credit, rebills included). The saturation
      point is where the next dollar costs more than the CAC ceiling.
      ${sc.window ? `Window ${esc(sc.window.start)} → ${esc(sc.window.end)}.` : ''}${status}
      ${ctx.demo ? ' <span class="pill warn">demo</span>' : ''}</div>
    ${allFailed ? '' : `<div class="kpis">${kpis([
      { label: 'Entities analyzed', value: fmt.int(analyzed.length), sub: curves.length > analyzed.length ? `${fmt.int(curves.length - analyzed.length)} skipped (time budget)` : 'ad accounts + top ad sets by spend' },
      { label: 'With spend history', value: fmt.int(withData.length) },
      { label: 'Saturation found', value: fmt.int(saturated.length), sub: 'a budget ceiling exists' },
      { label: 'Room to scale', value: fmt.int(withData.length - saturated.length), cls: 'good', sub: 'no saturation in range' },
    ])}</div>`}
    ${cards}`;
}

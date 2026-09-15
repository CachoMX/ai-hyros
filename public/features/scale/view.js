/** Scale Advisor — marginal CAC curves. Renders ctx.block into ctx.root. */
const LEVEL_WORD = { ACCOUNT: 'Ad account', CAMPAIGN: 'Campaign', SOURCE_LINK: 'Ad set', AD: 'Ad' };

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
  return `<svg class="scale-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="CAC curve">
    ${ticksY.map((v) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}"/>
      <text x="${L - 4}" y="${Y(v) + 3}" text-anchor="end">$${Math.round(v)}</text>`).join('')}
    ${ticksX.map((v, i) => `<text x="${X(v)}" y="${H - 8}" text-anchor="${i === 0 ? 'start' : i === 2 ? 'end' : 'middle'}">$${Math.round(v)}/day</text>`).join('')}
    <line class="axis" x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}"/>
    ${c.ceiling ? `<line class="ceil" x1="${L}" x2="${W - R}" y1="${Y(c.ceiling)}" y2="${Y(c.ceiling)}"/>` : ''}
    ${c.saturationSpend !== null && c.saturationSpend >= xMin && c.saturationSpend <= xMax
      ? `<line class="sat" x1="${X(c.saturationSpend)}" x2="${X(c.saturationSpend)}" y1="${T}" y2="${H - B}"/>` : ''}
    <path class="avg" d="${path('avgCac')}"/>
    <path class="marg" d="${path('marginalCac')}"/>
  </svg>
  <div class="scale-legend"><span><i></i>Average CAC</span><span><i class="marg"></i>Marginal CAC (next customer)</span>
    ${c.ceiling ? '<span><i class="ceil"></i>CAC ceiling</span>' : ''}${c.saturationSpend !== null ? '<span><i class="sat"></i>Saturation</span>' : ''}</div>`;
}

function curveVerdict(c, fmt) {
  if (c.error) return { cls: 'bad', text: 'Curve unavailable' };
  if (c.skipped) return { cls: '', text: 'Skipped — refresh time budget' };
  if (!c.points?.length) return { cls: '', text: c.notes?.includes('NO_SPEND_DATA') ? 'No spend history in the window' : 'Not enough data yet' };
  const last = c.points[c.points.length - 1];
  const current = c.points.reduce((m, p) => (p.customers !== null && p.customers > (m?.customers ?? -1) ? p : m), null);
  if (c.saturationSpend === null) return { cls: 'good', text: `Still efficient at ${fmt.money(last.spend)}/day — no saturation found` };
  const headroom = c.saturationSpend - (current?.spend ?? last.spend);
  return headroom > 0
    ? { cls: 'good', text: `Saturates at ${fmt.money(c.saturationSpend)}/day` }
    : { cls: 'bad', text: `Past saturation (${fmt.money(c.saturationSpend)}/day) — next dollar costs more than the ceiling` };
}

export function render(ctx) {
  const { fmt, esc, kpis } = ctx;
  const sc = ctx.block;
  if (!sc) { ctx.root.innerHTML = '<div class="fpanel"><div class="empty">No curves in this snapshot — hit Refresh.</div></div>'; return; }
  const curves = sc.curves || [];
  const withData = curves.filter((c) => c.points?.length);
  const saturated = withData.filter((c) => c.saturationSpend !== null);

  const cards = curves.length ? curves.map((c) => {
    const v = curveVerdict(c, fmt);
    const last = c.points?.[c.points.length - 1];
    return `<div class="fpanel scale-card">
      <div class="scale-head">
        <span class="pill">${esc(LEVEL_WORD[c.level] || c.level)}</span>
        <b>${esc(c.name || c.id)}</b>
        <span class="sub">${c.category ? esc(c.category) + ' · ' : ''}${c.daysSampled ? `${c.daysSampled} days sampled` : ''}</span>
        <span class="scale-verdict ${v.cls}">${esc(v.text)}</span>
      </div>
      ${c.points?.length >= 2 ? `<div class="scale-body">
        <div>${curveSvg(c)}</div>
        <div class="scale-stats">
          <div class="scale-stat"><div class="kpi-label">CAC ceiling</div><b>${fmt.money(c.ceiling)}</b>
            <div class="sub">${esc((c.ceilingBasis || '').toLowerCase().replace(/_/g, ' ') || '—')}</div></div>
          <div class="scale-stat"><div class="kpi-label">Saturation spend</div><b>${c.saturationSpend !== null ? `${fmt.money(c.saturationSpend)}/day` : '—'}</b></div>
          <div class="scale-stat"><div class="kpi-label">Marginal CAC at top of range</div><b>${fmt.money(last?.marginalCac)}</b>
            <div class="sub">at ${fmt.money(last?.spend)}/day</div></div>
        </div>
      </div>` : `<div class="sub">${esc(c.error || (c.notes || []).join(', ') || 'No curve points returned.')}</div>`}
    </div>`;
  }).join('') : '<div class="fpanel"><div class="empty">No curves in this snapshot — hit Refresh.</div></div>';

  ctx.root.innerHTML = `
    <div class="note"><b>Scale Advisor.</b> How the cost of the <i>next</i> customer
      changes as daily spend rises, computed by HYROS from this account's own spend history
      (<code>hyros_get_marginal_cac_curve</code>, first-click credit, rebills included). The saturation
      point is where the next dollar costs more than the CAC ceiling.
      ${sc.window ? `Window ${esc(sc.window.start)} → ${esc(sc.window.end)}.` : ''}
      ${sc.error ? `<br><b>Error:</b> ${esc(sc.error)}` : ''}${sc.skipped ? `<br>Skipped this refresh: ${esc(sc.skipped)}.` : ''}
      ${ctx.demo ? ' <span class="pill warn">demo</span>' : ''}</div>
    <div class="kpis">${kpis([
      { label: 'Entities analyzed', value: fmt.int(curves.length), sub: 'ad accounts + top ad sets by spend' },
      { label: 'With spend history', value: fmt.int(withData.length) },
      { label: 'Saturation found', value: fmt.int(saturated.length), sub: 'a budget ceiling exists' },
      { label: 'Room to scale', value: fmt.int(withData.length - saturated.length), cls: 'good', sub: 'no saturation in range' },
    ])}</div>
    ${cards}`;
}

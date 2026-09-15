/** Funnel & Journey — renders the feature's block (ctx.block) into ctx.root. */
export function render(ctx) {
  const { fmt, esc, kpis } = ctx;
  const f = ctx.block;
  if (!f) { ctx.root.innerHTML = '<div class="fpanel"><div class="empty">No funnel data in this snapshot.</div></div>'; return; }
  const top = f.stages[0].value || 1;
  const customers = f.stages[f.stages.length - 1].value;

  const stages = f.stages.map((s, i) => {
    const prev = i ? f.stages[i - 1].value : s.value;
    const stepPct = prev ? (s.value / prev) * 100 : 0;
    const width = Math.max(7, (s.value / top) * 100);
    return `<div class="fstage">
      <div class="fstage-info"><b>${esc(s.label)}</b><span class="sub">${esc(s.sub)}</span></div>
      <div class="fstage-bar"><div class="fstage-fill" style="width:${width}%">${fmt.int(s.value)}</div></div>
      <div class="fstage-pcts">
        ${i ? `<span class="pill stage">${stepPct.toFixed(1)}% of previous</span>` : '<span class="pill">100%</span>'}
        <span class="sub">${((s.value / top) * 100).toFixed(2)}% of visitors</span>
      </div>
    </div>`;
  }).join('');

  const shareList = (rows, unit) => rows.map((r) => `
    <div class="fshare">
      <div class="fshare-head">
        <span class="clip clip-l" title="${esc(r.name)}">${esc(r.name)}</span>
        <b>${(r.share * 100).toFixed(0)}%</b>
      </div>
      <div class="fshare-bar"><div style="width:${Math.max(2, r.share * 100)}%"></div></div>
      <div class="sub">${fmt.int(r.value)} ${unit}${r.cvr != null ? ` · ${r.cvr.toFixed(1)}% lead → customer` : ''}</div>
    </div>`).join('');

  ctx.root.innerHTML = `
    <div class="note"><b>Demo feature.</b> Funnel breakdown and customer journeys assembled from
      the tracked click stream — shown with demo data as an example of what the HYROS data can
      power. Window: last 30 days.</div>
    <div class="kpis">${kpis([
      { label: 'Visitors → Customers', value: `${((customers / top) * 100).toFixed(2)}%`, sub: 'end-to-end conversion' },
      { label: 'Avg touches to convert', value: f.avgTouches.toFixed(1), sub: 'ad + organic clicks per customer' },
      { label: 'Avg days to convert', value: f.avgDaysToConvert.toFixed(1), sub: 'first click → purchase' },
      { label: 'Customers (30d)', value: fmt.int(customers), cls: 'good' },
    ])}</div>
    <div class="fpanel"><h3>Funnel</h3>${stages}</div>
    <div class="fcols">
      <div class="fpanel"><h3>Where customers enter</h3>
        <div class="fhint">share of new leads by campaign</div>${shareList(f.entering, 'leads')}</div>
      <div class="fpanel"><h3>Where customers convert</h3>
        <div class="fhint">share of customers by credited campaign</div>${shareList(f.converting, 'customers')}</div>
    </div>
    <div class="fpanel"><h3>Typical customer journeys</h3>
      <div class="fhint">share of customers by most common path — assembled from tracked click history</div>
      ${f.paths.map((p) => `
        <div class="jpath">
          <span class="jpath-pct">${p.pct}%</span>
          <div class="jpath-steps">${p.steps.map((s) => `<span class="jstep">${esc(s)}</span>`).join('<span class="jarrow">→</span>')}</div>
        </div>`).join('')}
    </div>`;
}

/** Funnel & Journey — renders the feature's block (ctx.block) into ctx.root. */
import { renderLive } from './live-view.js';

export function render(ctx) {
  const { fmt, esc, kpis } = ctx;
  const f = ctx.block;
  if (f?.mode === 'paths') { renderLive(ctx); return; }
  // Preserve the original demo and older snapshot shape.
  if (!f || typeof f !== 'object' || !Array.isArray(f.stages) || !f.stages.length) {
    const why = f?.error ? `Error: ${esc(f.error)}`
      : f?.skipped ? `${f.stale ? 'Showing nothing from the previous refresh — ' : ''}skipped this refresh (${esc(f.skipped)}).`
        : 'No funnel data in this snapshot.';
    ctx.root.innerHTML = `<div class="fpanel"><div class="empty">${f?.stale ? 'Showing the previous result. ' : ''}${why}</div></div>`;
    return;
  }
  const when = f.checkedAt || f.window?.end;
  const status = f.stale ? `<br><b>Showing the previous result</b>${when ? ` (${esc(fmt.datetime(when))})` : ''}${f.skipped ? ` - skipped this refresh: ${esc(f.skipped)}` : ''}.` : '';
  const top = f.stages[0].value || 1;
  const customers = f.stages[f.stages.length - 1].value;

  const v = f.value || null;
  const isCart = (s) => /cart/i.test(s.unit || s.label);
  const stages = f.stages.map((s, i) => {
    const prev = i ? f.stages[i - 1].value : s.value;
    const stepPct = prev ? (s.value / prev) * 100 : 0;
    const width = Math.max(7, (s.value / top) * 100);
    const per = s.netPer ?? null;
    return `<div class="fstage ${v ? 'has-val' : ''}">
      <div class="fstage-info"><b>${esc(s.label)}</b><span class="sub">${esc(s.sub)}</span></div>
      <div class="fstage-bar"><div class="fstage-fill" style="width:${width}%">${fmt.int(s.value)}</div></div>
      <div class="fstage-pcts">
        ${i ? `<span class="pill stage">${stepPct.toFixed(1)}% of previous</span>` : '<span class="pill">100%</span>'}
        <span class="sub">${((s.value / top) * 100).toFixed(2)}% of visitors</span>
      </div>
      ${v ? `<div class="fstage-val ${isCart(s) ? 'hot' : ''}">
        <b>${per == null ? '—' : fmt.money(per)}</b>
        <span class="sub">net per ${esc(s.unit || s.label.toLowerCase())}</span>
      </div>` : ''}
    </div>`;
  }).join('');

  // Order value ledger: gross → refunds → net → net AOV → the add-to-cart figure.
  const ledger = v ? `<div class="fledger">
      <div><span class="kpi-label">Orders</span><b>${fmt.int(v.orders)}</b><span class="sub">purchases in the window</span></div>
      <div><span class="kpi-label">Gross order value</span><b>${fmt.money(v.gross)}</b><span class="sub">AOV ${v.aovGross == null ? '—' : fmt.money(v.aovGross)} before refunds</span></div>
      <div class="neg"><span class="kpi-label">Refunds</span><b>−${fmt.money(v.refunds)}</b><span class="sub">${fmt.int(v.refundCount)} refunded order${v.refundCount === 1 ? '' : 's'}${v.gross ? ` · ${((v.refunds / v.gross) * 100).toFixed(1)}% of gross` : ''}</span></div>
      <div><span class="kpi-label">Net order value</span><b>${fmt.money(v.net)}</b><span class="sub">gross minus refunds</span></div>
      <div class="good"><span class="kpi-label">Net AOV</span><b>${v.aov == null ? '—' : fmt.money(v.aov)}</b><span class="sub">net value of each order</span></div>
      <div class="hot"><span class="kpi-label">Value of an add to cart</span><b>${v.perCart == null ? '—' : fmt.money(v.perCart)}</b><span class="sub">net order value ÷ add-to-carts</span></div>
    </div>` : '';

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
      power. Window: last 30 days.${status}</div>
    <div class="kpis">${kpis([
      { label: 'Visitors → Customers', value: `${((customers / top) * 100).toFixed(2)}%`, sub: 'end-to-end conversion' },
      { label: 'Avg touches to convert', value: f.avgTouches.toFixed(1), sub: 'ad + organic clicks per customer' },
      { label: 'Avg days to convert', value: f.avgDaysToConvert.toFixed(1), sub: 'first click → purchase' },
      ...(v ? [
        { label: 'Net AOV', value: v.aov == null ? '—' : fmt.money(v.aov), cls: 'good', sub: `${fmt.int(v.orders)} orders · refunds taken off` },
        { label: 'Value of an add to cart', value: v.perCart == null ? '—' : fmt.money(v.perCart), cls: 'good', sub: 'net order value ÷ add-to-carts' },
      ] : [{ label: 'Customers (30d)', value: fmt.int(customers), cls: 'good' }]),
    ])}</div>
    <div class="fpanel"><h3>Funnel</h3>
      <div class="fhint">counts per stage, with the net order value (after refunds) spread over each stage's units</div>
      ${stages}${ledger}</div>
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

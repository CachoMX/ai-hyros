/** Ad LTV — renders ctx.block into ctx.root. */
const KIND_LABEL = { email: 'email', organic: 'organic', ads: 'paid' };

export function render(ctx) {
  const { fmt, esc, kpis } = ctx;
  const d = ctx.block;
  // Demo-only feature: a block without rows ({ error }, { skipped }, {}) renders a status, never throws.
  if (!d || typeof d !== 'object' || !Array.isArray(d.rows) || !d.rows.length || !Array.isArray(d.callLeaders)) {
    const why = d?.error ? `Error: ${esc(d.error)}`
      : d?.skipped ? `Skipped this refresh (${esc(d.skipped)}).`
        : 'No Ad LTV data in this snapshot.';
    ctx.root.innerHTML = `<div class="fpanel"><div class="empty">${why}</div></div>`;
    return;
  }
  const status = d.stale && d.skipped ? `<br><b>Showing the previous result</b> — skipped this refresh: ${esc(d.skipped)}.` : '';

  const topAd = [...d.rows].sort((a, b) => b.ltv60 - a.ltv60)[0];
  const avgMult = d.rows.reduce((s, r) => s + (r.mult || 0), 0) / d.rows.length;
  const totCustomers = d.rows.reduce((s, r) => s + r.customers, 0);
  const totAssistCalls = d.callLeaders.reduce((s, x) => s + x.closedCalls, 0);

  const cards = d.rows.map((row) => {
    const maxCalls = Math.max(...row.assists.map((a) => a.closedCalls));
    return `<div class="fpanel ltv-card">
      <div class="ltv-head">
        <span class="ltv-rank">#${row.rank}</span>
        <div class="ltv-title">
          <b>${esc(row.name)}</b>
          <span class="sub">${esc(row.adset)}${row.campaign ? ` · ${esc(row.campaign)}` : ''}</span>
        </div>
        <div class="ltv-headstats">
          <span><b>${fmt.int(row.customers)}</b> customers</span>
          <span><b class="good">${fmt.money(row.revenue60)}</b> 2-mo revenue</span>
        </div>
      </div>
      <div class="ltv-steps">
        <div class="ltv-step"><span class="sub">First purchase</span><b>${fmt.money(row.ltv0)}</b></div>
        <span class="jarrow">→</span>
        <div class="ltv-step"><span class="sub">LTV 30 days</span><b>${fmt.money(row.ltv30)}</b></div>
        <span class="jarrow">→</span>
        <div class="ltv-step"><span class="sub">LTV 60 days</span><b class="good">${fmt.money(row.ltv60)}</b></div>
        <span class="ltv-mult">${row.mult ? `${row.mult.toFixed(2)}×` : '—'}</span>
      </div>
      <div class="ltv-assist-head">Other sources these customers also clicked
        <span class="sub">· % of the ad's customers · closed calls in the window</span></div>
      ${row.assists.map((a) => `
        <div class="ltv-assist">
          <span class="ltv-assist-name clip clip-l" title="${esc(a.name)}">${esc(a.name)}</span>
          <span class="pill">${KIND_LABEL[a.kind] || a.kind}</span>
          <div class="fshare-bar ltv-assist-bar"><div style="width:${Math.max(3, a.pct * 100)}%"></div></div>
          <span class="ltv-assist-pct">${(a.pct * 100).toFixed(0)}%</span>
          <span class="sub">${fmt.int(a.touched)} customers</span>
          <span class="ltv-assist-calls ${a.closedCalls === maxCalls ? 'good' : ''}">${fmt.int(a.closedCalls)} closed calls</span>
          ${a.closedCalls === maxCalls ? '<span class="pill stage">most closed calls</span>' : ''}
        </div>`).join('')}
    </div>`;
  }).join('');

  const maxLeader = d.callLeaders[0]?.closedCalls || 1;
  ctx.root.innerHTML = `
    <div class="note"><b>Demo feature.</b> Long-term value of the customers each top ad created,
      followed for 2 months after the click — plus the other traffic sources those same customers
      clicked along the way, and which of them closed the most calls. Window: ${esc(d.window?.start)} → ${esc(d.window?.end)}.${status}</div>
    <div class="kpis">${kpis([
      { label: 'Highest 60-day LTV', value: fmt.money(topAd.ltv60), cls: 'good', sub: topAd.name },
      { label: 'Avg LTV growth (60d)', value: `${avgMult.toFixed(2)}×`, sub: 'vs first-purchase AOV, top 5 ads' },
      { label: 'Customers followed', value: fmt.int(totCustomers), sub: 'created by the top 5 ads' },
      { label: 'Closed calls via assists', value: fmt.int(totAssistCalls), sub: 'booked & closed through other sources' },
    ])}</div>
    ${cards}
    <div class="fpanel"><h3>Closed calls by assisting source</h3>
      <div class="fhint">across all customers of the top 5 ads, ${esc(d.window?.start)} → ${esc(d.window?.end)}</div>
      ${d.callLeaders.map((x, i) => `
        <div class="fshare">
          <div class="fshare-head">
            <span>${esc(x.name)} <span class="pill">${KIND_LABEL[x.kind] || x.kind}</span>
              ${i === 0 ? '<span class="pill stage">most closed calls</span>' : ''}</span>
            <b>${fmt.int(x.closedCalls)}</b>
          </div>
          <div class="fshare-bar"><div style="width:${Math.max(3, (x.closedCalls / maxLeader) * 100)}%"></div></div>
          <div class="sub">${fmt.int(x.touched)} of these ads' customers touched this source</div>
        </div>`).join('')}
    </div>`;
}

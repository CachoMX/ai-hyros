/**
 * view.js — the tab. Export render(ctx); build HTML into ctx.root.innerHTML.
 * ctx (see FEATURES.md): root, snapshot, block, demo, account, range, level,
 *   fmt (money/int/pct/date/datetime), esc (HTML-escape — use it on EVERY
 *   string from data), kpis(list) -> KPI tiles HTML, formatCell, note(msg,
 *   isErr), openJourney(email), api(path, opts), selectView(id).
 * Rules: no imports from app.js; no fetch to HYROS (the server step does
 * that); render must be pure (idempotent) and tolerate a missing block.
 */
export function render(ctx) {
  const { fmt, esc, kpis } = ctx;
  const b = ctx.block;
  if (!b) {
    ctx.root.innerHTML = '<div class="fpanel"><div class="empty">No data for this feature in the current snapshot — hit Refresh.</div></div>';
    return;
  }
  ctx.root.innerHTML = `
    <div class="note"><b>${esc(ctx.manifest.name)}.</b> ${esc(ctx.manifest.description)}${ctx.demo ? ' <span class="pill warn">demo</span>' : ''}</div>
    <div class="kpis">${kpis([
      { label: 'Rows', value: fmt.int(b.rows.length) },
      { label: 'Total', value: fmt.money(b.rows.reduce((s, r) => s + r.value, 0)), cls: 'good' },
    ])}</div>
    <div class="fpanel"><h3>${esc(ctx.manifest.name)}</h3>
      <div class="fhint">${esc(b.window?.start || '')} → ${esc(b.window?.end || '')}</div>
      ${b.rows.map((r) => `<div class="fshare">
        <div class="fshare-head"><span class="clip clip-l" title="${esc(r.name)}">${esc(r.name)}</span><b>${fmt.money(r.value)}</b></div>
      </div>`).join('')}
    </div>`;
}

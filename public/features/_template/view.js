/**
 * view.js — the tab. Export render(ctx); build HTML into ctx.root.innerHTML.
 * ctx (see FEATURES.md): root, snapshot, block, demo, account, range, level,
 *   fmt (money/int/pct/date/datetime), esc (HTML-escape — use it on EVERY
 *   string from data), kpis(list) -> KPI tiles HTML, formatCell, note(msg,
 *   isErr), openJourney(email), api(path, opts), selectView(id).
 * Rules: no imports from app.js; no fetch to HYROS (the server step does
 * that); render must be pure (idempotent) and must never throw.
 *
 * The block arrives in one of four states (FEATURES.md "The block"):
 *   fresh            { window, rows, errors }
 *   stale            { ...previous data, stale: true, skipped: 'time budget' }
 *   bare skipped     { skipped: 'time budget' }         (nothing to show yet)
 *   error            { error: 'message' }
 * plus `null` (no block in the snapshot) and `{}` (defensive). Read every
 * field with a fallback (`b.rows || []`) so a marker block cannot throw.
 */

/** The status line for the note bar: says what the numbers are (or why there are none). */
function statusLine(b, fmt, esc) {
  if (b.error) return `<br><b>Error:</b> ${esc(b.error)}`;
  if (b.skipped && b.stale) {
    const when = b.checkedAt || b.window?.end;
    return `<br><b>Showing the previous result</b>${when ? ` (${esc(fmt.datetime(when))})` : ''} — skipped this refresh: ${esc(b.skipped)}.`;
  }
  if (b.skipped) return `<br>Skipped this refresh (${esc(b.skipped)}) — nothing was computed yet. Hit Refresh again.`;
  return '';
}

export function render(ctx) {
  const { fmt, esc, kpis } = ctx;
  const b = ctx.block;
  if (!b || typeof b !== 'object') {
    ctx.root.innerHTML = '<div class="fpanel"><div class="empty">No data for this feature in the current snapshot — hit Refresh.</div></div>';
    return;
  }
  const rows = Array.isArray(b.rows) ? b.rows : [];
  const errors = Array.isArray(b.errors) ? b.errors : [];
  const hasData = rows.length > 0;
  ctx.root.innerHTML = `
    <div class="note"><b>${esc(ctx.manifest.name)}.</b> ${esc(ctx.manifest.description)}${statusLine(b, fmt, esc)}
      ${ctx.demo ? ' <span class="pill warn">demo</span>' : ''}</div>
    <div class="kpis">${kpis([
      { label: 'Rows', value: hasData ? fmt.int(rows.length) : '—' },
      { label: 'Total', value: hasData ? fmt.money(rows.reduce((s, r) => s + (Number(r.value) || 0), 0)) : '—', cls: hasData ? 'good' : '' },
    ])}</div>
    <div class="fpanel"><h3>${esc(ctx.manifest.name)}</h3>
      <div class="fhint">${esc(b.window?.start || '')} → ${esc(b.window?.end || '')}</div>
      ${hasData ? rows.map((r) => `<div class="fshare">
        <div class="fshare-head"><span class="clip clip-l" title="${esc(r.name)}">${esc(r.name)}</span><b>${fmt.money(r.value)}</b></div>
      </div>`).join('') : `<div class="empty">${b.skipped || b.error ? 'No rows to show.' : 'No rows in this window.'}</div>`}
      ${errors.length ? `<div class="sub" style="margin-top:8px">${esc(errors.join(' · '))}</div>` : ''}
    </div>`;
}

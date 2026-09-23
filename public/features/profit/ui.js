export function statusMarkup(ctx, block) {
  const esc = ctx.esc;
  if (!block || !Object.keys(block).length) return '<div class="note">No data yet. Hit Refresh.</div>';
  if (block.error) return `<div class="note err">${esc(block.error)}</div>`;
  if (block.stale) {
    const when = block.checkedAt ? ctx.fmt.datetime(block.checkedAt) : 'unknown time';
    return `<div class="note">Showing the previous result (${esc(when)}). ${esc(block.skipped || 'Refresh pending')}.</div>`;
  }
  if (block.skipped) return `<div class="note">Skipped (${esc(block.skipped)}); nothing computed yet. Hit Refresh.</div>`;
  return '';
}

export function csvText(headers, rows) {
  const cell = (value) => {
    let text = value == null ? '' : String(value);
    if (typeof value === 'string' && /^[\s]*[=+@-]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  return [headers, ...rows].map((row) => row.map(cell).join(',')).join('\r\n');
}

export function downloadCsv(name, headers, rows) {
  if (!globalThis.document?.createElement || !globalThis.URL?.createObjectURL) return false;
  const url = URL.createObjectURL(new Blob([csvText(headers, rows)], { type: 'text/csv;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

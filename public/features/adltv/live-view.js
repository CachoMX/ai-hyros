const list = (v) => Array.isArray(v) ? v : [];
const money = (v, code) => {
  if (!Number.isFinite(v)) return 'Unknown';
  if (!/^[A-Z]{3}$/.test(String(code))) return `${v.toFixed(2)} (currency unknown)`;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: code, currencyDisplay: 'code' }).format(v);
};

export function renderLive(ctx, state = {}) {
  const { esc, fmt, kpis } = ctx;
  const dateLabel = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : fmt.date(v);
  const b = ctx.block || {};
  const summary = b.summary || {};
  const code = state.currency || 'ALL';
  const order = ['sales', 'repeat', 'name'].includes(state.order) ? state.order : 'sales';
  const accepts = (r) => code === 'ALL' || (r.currency || 'UNKNOWN') === code;
  const rows = list(b.rows).filter(accepts).sort((a, z) => order === 'name' ? a.name.localeCompare(z.name) : (z[order] || 0) - (a[order] || 0));
  const query = String(state.query || '').toLowerCase();
  const leads = list(b.leads).filter((r) => accepts(r) && `${r.leadId || ''} ${r.source}`.toLowerCase().includes(query));
  const candidates = list(b.candidates);
  const num = (v) => Number.isFinite(v) ? fmt.int(v) : 'Unknown';
  const option = (v, label, current) => `<option value="${esc(v)}"${v === current ? ' selected' : ''}>${esc(label)}</option>`;
  const stamp = b.checkedAt || b.window?.end;
  const stale = b.stale ? `Showing the previous result${stamp ? ` (${fmt.datetime(stamp)})` : ''}. ${b.skipped || ''}` : '';
  const pathStatus = b.pathStatus === 'ready' ? `${num(summary.sales)} observed sales. ${b.coverage?.complete && !b.coverage?.truncated ? 'Path sample complete.' : 'Partial path sample.'}` : `Conversion paths ${b.pathStatus || 'unavailable'}. ${b.pathReason || 'Refresh to check again.'}`;
  const sourceRows = rows.map((r) => `<tr><th scope="row">${esc(r.name)}<span class="sub">${esc(r.currency || 'Currency unknown')}</span></th>
    <td>${num(r.leads)}</td><td>${num(r.sales)}</td><td>${num(r.first)}</td><td>${num(r.repeat)}</td><td>${num(r.unknown)}</td>
    <td>${esc(money(r.unknownAmounts === r.sales ? null : r.revenue, r.currency))}${r.unknownAmounts ? `<span class="sub">${num(r.unknownAmounts)} amount(s) unknown</span>` : ''}</td></tr>`).join('');
  const leadRows = leads.map((r) => `<tr><th scope="row">${esc(r.leadId || 'Unlinked sale')}</th><td>${esc(r.source)}</td><td>${num(r.sales)}</td><td>${num(r.repeat)}</td><td>${esc(money(r.unknownAmounts === r.sales ? null : r.revenue, r.currency))}${r.unknownAmounts ? '<span class="sub">Incomplete amounts</span>' : ''}</td></tr>`).join('');
  const cohortCell = (h, currency) => !h ? '<td>Unknown</td>' : `<td>${h.value == null ? esc(h.status === 'immature' ? 'Immature' : 'Unknown') : esc(money(h.value, currency))}
    <span class="sub">${num(h.mature)} mature / ${num(h.immature)} immature / ${num(h.unknown)} unknown</span></td>`;
  const cohortRows = list(b.cohorts?.rows).filter(accepts).map((r) => `<tr><th scope="row">${esc(r.name)}<span class="sub">${num(r.customers)} observed customers / ${esc(r.currency || 'currency unknown')}</span></th>${[0, 30, 60, 90].map((days) => cohortCell(list(r.horizons).find((h) => h.days === days), r.currency)).join('')}</tr>`).join('');
  const chosen = candidates.find((c) => c.key === state.candidate) || candidates[0];
  const candidateDetail = chosen ? `<dl class="adltv-evidence"><div><dt>Observed conversions</dt><dd>${num(chosen.conversions)}</dd></div>
    <div><dt>7+ day delay</dt><dd>${num(chosen.late)}</dd></div><div><dt>Multiple touches</dt><dd>${num(chosen.multiTouch)}</dd></div>
    <div><dt>Native 60-day LTV</dt><dd>${esc(money(chosen.native?.ltv60, chosen.native?.currency))}</dd></div></dl>
    <p class="sub">Sale evidence: ${esc(list(chosen.examples).join(', ') || 'No sale IDs available')}.</p>` : '<div class="empty">No candidate meets the observed delay or multiple-touch criteria.</div>';
  ctx.root.innerHTML = `<div class="adltv-live">
    <div class="note${b.pathStatus === 'error' ? ' err' : ''}">${esc([stale, pathStatus, b.window?.start ? `${dateLabel(b.window.start)} to ${dateLabel(b.window.end)}.` : ''].filter(Boolean).join(' '))}
      <div class="sub">Observed path-date revenue is not a full acquisition cohort. Currencies remain separate; refunds are not reconciled here.</div></div>
    <div class="kpis">${kpis([
      { label: 'Observed purchases', value: b.pathStatus === 'ready' ? num(summary.sales) : 'Unknown' },
      { label: 'First purchases', value: b.pathStatus === 'ready' ? num(summary.first) : 'Unknown', sub: 'confirmed first purchase' },
      { label: 'Repeat purchases', value: b.pathStatus === 'ready' ? num(summary.repeat) : 'Unknown', sub: 'confirmed repeat purchase' },
      { label: 'Purchase type unknown', value: b.pathStatus === 'ready' ? num(summary.unclassified) : 'Unknown', sub: `${num(summary.unlinked)} sales without a lead ID` },
    ])}</div>
    <section class="adltv-section"><div class="adltv-heading"><h3>Observed revenue by opening source</h3>
      <div class="adltv-controls"><label>Currency <select data-adltv-currency>${option('ALL', 'All currencies', code)}${[...new Set([...list(b.rows), ...list(b.native), ...list(b.cohorts?.rows)].map((r) => r.currency || 'UNKNOWN'))].sort().map((c) => option(c, c === 'UNKNOWN' ? 'Unknown currency' : c, code)).join('')}</select></label>
      <label>Sort <select data-adltv-order>${[['sales', 'Purchases'], ['repeat', 'Repeats'], ['name', 'Source']].map(([v, label]) => option(v, label, order)).join('')}</select></label></div></div>
      <p class="sub">Each sale belongs to its first eligible path touch. A lead can appear under several sources.</p>
      <div class="adltv-scroll"><table class="adltv-table"><thead><tr><th scope="col">Opening source</th><th scope="col">Leads</th><th scope="col">Purchases</th><th scope="col">First</th><th scope="col">Repeat</th><th scope="col">Unknown</th><th scope="col">Observed revenue</th></tr></thead><tbody>${sourceRows || '<tr><td colspan="7" class="empty">No observed sales for this selection.</td></tr>'}</tbody></table></div>
    </section>
    <section class="adltv-section"><div class="adltv-heading"><h3>Observed revenue by lead</h3><label>Lead or source <input data-adltv-search type="search" value="${esc(state.query || '')}" autocomplete="off"></label></div>
      <div class="adltv-scroll"><table class="adltv-table"><thead><tr><th scope="col">Lead ID</th><th scope="col">Opening source</th><th scope="col">Purchases</th><th scope="col">Repeat</th><th scope="col">Observed revenue</th></tr></thead><tbody>${leadRows || '<tr><td colspan="5" class="empty">No lead rows match this selection.</td></tr>'}</tbody></table></div>
    </section>
    <section class="adltv-section"><h3>Observed first-purchase cohorts</h3>
      <p class="sub">Per-customer value from confirmed first purchases. Each horizon includes only customers with complete sales history through that day; denominators can differ.
      ${esc(b.cohorts?.reason || '')}
      ${b.cohorts?.window?.start ? esc(`History: ${dateLabel(b.cohorts.window.start)} to ${dateLabel(b.cohorts.window.end)}.`) : ''}</p>
      <div class="adltv-scroll"><table class="adltv-table"><thead><tr><th scope="col">First source</th><th scope="col">Time 0</th><th scope="col">30 days</th><th scope="col">60 days</th><th scope="col">90 days</th></tr></thead><tbody>${cohortRows || '<tr><td>History unavailable</td><td>Unknown</td><td>Unknown</td><td>Unknown</td><td>Unknown</td></tr>'}</tbody></table></div>
    </section>
    <section class="adltv-section"><h3>Native HYROS LTV</h3><p class="sub">Native report values; acquisition and observation windows are not verified by the conversion-path sample.</p>
      <div class="adltv-scroll"><table class="adltv-table"><thead><tr><th scope="col">Ad</th><th scope="col">30 days</th><th scope="col">60 days</th><th scope="col">90 days</th></tr></thead><tbody>${list(b.native).filter(accepts).map((r) => `<tr><th scope="row">${esc(r.name)}<span class="sub">${r.stale ? 'Previous report / ' : ''}${esc(r.window?.start ? `${dateLabel(r.window.start)} to ${dateLabel(r.window.end)}` : 'Report window unknown')}</span></th><td>${esc(money(r.ltv30, r.currency))}</td><td>${esc(money(r.ltv60, r.currency))}</td><td>${esc(money(r.ltv90, r.currency))}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">Native ad LTV is unavailable in this report.</td></tr>'}</tbody></table></div>
    </section>
    <section class="adltv-section"><h3>Hidden-winner candidates</h3><p class="sub">Across all currencies: opening or pre-close sources with a 7+ day conversion delay or multiple touches. These are investigation candidates, not measured lift or budget recommendations.</p>
      <label class="adltv-candidate">Source <select data-adltv-candidate${candidates.length ? '' : ' disabled'}>${candidates.map((c) => option(c.key, c.name, chosen?.key)).join('') || '<option>No candidates</option>'}</select></label>${candidateDetail}
    </section>
    ${list(b.errors).length ? `<div class="note">${esc(b.errors.join(' '))}</div>` : ''}</div>`;
  const bind = (selector, fn) => ctx.root.querySelector?.(selector)?.addEventListener?.('change', fn);
  bind('[data-adltv-currency]', (event) => renderLive(ctx, { ...state, currency: event.target.value }));
  bind('[data-adltv-order]', (event) => renderLive(ctx, { ...state, order: event.target.value }));
  bind('[data-adltv-search]', (event) => renderLive(ctx, { ...state, query: event.target.value }));
  bind('[data-adltv-candidate]', (event) => renderLive(ctx, { ...state, candidate: event.target.value }));
}

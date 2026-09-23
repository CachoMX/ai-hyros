const list = (v) => Array.isArray(v) ? v : [];
const money = (v, code) => {
  if (!Number.isFinite(v)) return 'Unknown';
  if (!/^[A-Z]{3}$/.test(String(code))) return `${v.toFixed(2)} (currency unknown)`;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: code, currencyDisplay: 'code' }).format(v);
};

export function renderLive(ctx, state = {}) {
  const { esc, fmt, kpis } = ctx;
  const dateLabel = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : fmt.date(v);
  const timeLabel = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : fmt.datetime(v);
  const b = ctx.block || {};
  const s = b.summary || {};
  const crm = b.crm || {};
  const metric = ['opening', 'closing', 'assists'].includes(state.metric) ? state.metric : 'opening';
  const kind = ['SALE', 'CALL'].includes(state.kind) ? state.kind : 'ALL';
  const journeys = list(b.journeys).filter((j) => kind === 'ALL' || j.kind === kind);
  const selected = journeys.find((j) => `${j.kind}:${j.id}` === state.selected) || journeys[0];
  const sources = [...list(b.sources)].sort((a, z) => (z[metric] || 0) - (a[metric] || 0));
  const stamp = b.checkedAt || b.window?.end;
  const stale = b.stale ? `Showing the previous result${stamp ? ` (${timeLabel(stamp)})` : ''}. ${b.skipped || ''}` : '';
  const window = b.window?.start && b.window?.end ? `${dateLabel(b.window.start)} to ${dateLabel(b.window.end)}` : 'Window unavailable';
  const coverage = b.pathStatus !== 'ready' ? b.pathReason || 'Path data unavailable. Refresh to check again.'
    : `${b.coverage?.analyzed ?? 0} observed conversions. ${b.coverage?.complete && !b.coverage?.truncated ? 'Path sample complete.' : 'Partial path sample.'} ${window}.`;
  const num = (v) => Number.isFinite(v) ? fmt.int(v) : 'Unknown';
  const option = (value, label, current) => `<option value="${esc(value)}"${value === current ? ' selected' : ''}>${esc(label)}</option>`;
  const detail = selected ? `<div class="funnel-evidence-meta">
      <span>${esc(selected.kind === 'SALE' ? 'Sale' : 'Call')} ${esc(selected.id)}</span>
      <span>Lead ${esc(selected.leadId || 'unknown')}</span><span>${esc(timeLabel(selected.date))}</span>
      ${selected.kind === 'SALE' ? `<span>${esc(money(selected.amount, selected.currency))}</span>` : ''}
      <span>${selected.days == null ? 'Delay unknown' : `${selected.days.toFixed(1)} days from first eligible touch`}</span>
    </div>
    <ol class="funnel-chain">${list(selected.path).map((t) => `<li${t.exclusion || t.disregarded ? ' class="funnel-disregarded"' : ''}>
      <div><b>${esc(t.name)}</b> ${t.exclusion || t.disregarded ? `<span class="pill warn">${esc(t.exclusion || 'disregarded')}</span>` : ''}
      ${t.organic ? '<span class="pill">organic</span>' : ''}</div>
      <span class="sub">${esc([t.platform, t.adName, t.date ? timeLabel(t.date) : 'Touch date unknown'].filter(Boolean).join(' / '))}</span>
    </li>`).join('') || '<li>No recorded touches.</li>'}
      <li class="funnel-conversion"><b>${esc(selected.kind === 'SALE' ? 'Sale' : 'Call')}</b><span class="sub">${esc(timeLabel(selected.date))}</span></li>
    </ol>` : '<div class="empty">No conversion chains match this selection.</div>';
  ctx.root.innerHTML = `<div class="funnel-live">
    <div class="note${b.pathStatus === 'error' ? ' err' : ''}">${esc([stale, coverage].filter(Boolean).join(' '))}
      <div class="sub">Path-date sample; results describe observed conversions. Source roles use dated touches at or before conversion, excluding disregarded touches.</div></div>
    <div class="kpis">${kpis([
      { label: 'Observed sales', value: b.pathStatus === 'ready' ? num(s.sales) : 'Unknown' },
      { label: 'Observed calls', value: b.pathStatus === 'ready' ? num(s.calls) : 'Unknown' },
      { label: 'With eligible paths', value: b.pathStatus === 'ready' ? num(s.withPaths) : 'Unknown', sub: `${num(s.noTouch)} without eligible touches` },
      { label: 'Multiple touches', value: b.pathStatus === 'ready' ? num(s.multiTouch) : 'Unknown' },
      { label: 'Delay of 7+ days', value: b.pathStatus === 'ready' ? num(s.late) : 'Unknown', sub: s.avgDays == null ? 'Delay unknown' : `${s.avgDays.toFixed(1)} days average when dated` },
    ])}</div>
    <section class="funnel-section"><h3>CRM activity</h3>
      <p class="sub">Independent period counts; these are different populations, so no stage conversion rate is calculated.
      ${esc(crm.window?.start ? `${dateLabel(crm.window.start)} to ${dateLabel(crm.window.end)}.` : 'CRM window unavailable.')}
      ${crm.partial ? 'Partial CRM lists.' : ''} ${crm.stale ? `Previous CRM refresh${crm.checkedAt ? ` (${esc(timeLabel(crm.checkedAt))})` : ''}.` : ''}</p>
      <dl class="funnel-crm">${[['Leads in CRM list', crm.leads], ['Calls in CRM list', crm.calls], ['Qualified calls', crm.qualifiedCalls], ['Sales in CRM list', crm.sales]].map(([label, value]) => `<div><dt>${label}</dt><dd>${num(value)}</dd></div>`).join('')}</dl>
    </section>
    <section class="funnel-section"><div class="funnel-heading"><h3>Source roles</h3>
      <label>Sort by <select data-funnel-role>${[['opening', 'Opening'], ['closing', 'Closing'], ['assists', 'Assists']].map(([v, label]) => option(v, label, metric)).join('')}</select></label></div>
      <p class="sub">One count per source per conversion in each role. Assists are interior touches; roles can overlap.</p>
      <div class="funnel-table-scroll"><table class="funnel-table"><thead><tr><th scope="col">Source</th><th scope="col">Opening</th><th scope="col">Closing</th><th scope="col">Assists</th><th scope="col">Sales touched</th><th scope="col">Calls touched</th></tr></thead>
      <tbody>${sources.map((r) => `<tr><th scope="row">${esc(r.name)}<span class="sub">${esc(r.platform)}${r.organic ? ' / organic' : ''}</span></th><td>${num(r.opening)}</td><td>${num(r.closing)}</td><td>${num(r.assists)}</td><td>${num(r.sales)}</td><td>${num(r.calls)}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">No eligible source touches in this sample.</td></tr>'}</tbody></table></div>
    </section>
    <section class="funnel-section"><h3>Observed path flows</h3>
      ${list(b.flows).map((flow) => `<div class="funnel-flow"><span class="funnel-flow-count">${num(flow.count)} <span class="sub">${s.conversions ? (100 * flow.count / s.conversions).toFixed(1) : '0'}%</span></span>
        <div class="funnel-flow-steps">${list(flow.steps).map((step) => `<span>${esc(step)}</span>`).join('<span class="funnel-arrow" aria-hidden="true">&rarr;</span>')}</div></div>`).join('') || '<div class="empty">No conversion paths in this snapshot.</div>'}
    </section>
    <section class="funnel-section"><h3>Conversion evidence</h3>
      <div class="funnel-controls"><label>Kind <select data-funnel-kind>${[['ALL', 'All conversions'], ['SALE', 'Sales'], ['CALL', 'Calls']].map(([v, label]) => option(v, label, kind)).join('')}</select></label>
      <label class="funnel-sample">Sample <select data-funnel-sample${journeys.length ? '' : ' disabled'}>${journeys.map((j) => option(`${j.kind}:${j.id}`, `${j.kind} ${j.id || '(no ID)'} / ${j.date ? dateLabel(j.date) : 'date unknown'}`, selected ? `${selected.kind}:${selected.id}` : '')).join('') || '<option>No samples</option>'}</select></label></div>
      ${detail}</section>
    ${list(b.errors).length ? `<div class="note">${esc(b.errors.join(' '))}</div>` : ''}</div>`;
  const bind = (selector, fn) => ctx.root.querySelector?.(selector)?.addEventListener?.('change', fn);
  bind('[data-funnel-role]', (event) => renderLive(ctx, { ...state, metric: event.target.value }));
  bind('[data-funnel-kind]', (event) => renderLive(ctx, { ...state, kind: event.target.value, selected: null }));
  bind('[data-funnel-sample]', (event) => renderLive(ctx, { ...state, selected: event.target.value }));
}

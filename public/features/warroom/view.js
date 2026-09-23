import { decisionBrief, loadDecisions, saveDecision, evidencePack, downloadFile } from '../../shared/decisions.js';

export function render(ctx) {
  const { root, esc, fmt } = ctx;
  const brief = decisionBrief(ctx.snapshot, ctx.range);
  const account = ctx.demo ? 'demo' : ctx.account;
  const journal = loadDecisions(account);
  const filter = root.dataset.filter || 'active';
  const status = id => journal[id]?.status || 'open';
  const visible = brief.issues.filter(x => filter === 'all' || (filter === 'active' ? ['open', 'monitoring'].includes(status(x.id)) : status(x.id) === filter));
  const totals = brief.totals;
  root.innerHTML = `<div class="wr-head"><div><h2>Decision War Room</h2><p class="muted">${esc(ctx.range)} · ${esc(brief.currency)} · ${esc(brief.attributionModel || 'Model unavailable')}</p></div><div class="wr-tools"><label>Evidence <select data-export-mode><option value="public">Redacted</option><option value="private">Internal</option></select></label><button class="btn" data-export>Export evidence</button></div></div>
    ${ctx.block?.stale || brief.stale ? '<p class="wr-warning">Showing a previous snapshot, or its timestamp is unavailable. Refresh before making decisions.</p>' : ''}
    <div class="wr-metrics">${ctx.kpis([{ label: 'Total revenue', value: fmt.money(totals?.revenue), sub: 'Including rebills' }, { label: 'Ad spend', value: fmt.money(totals?.cost), sub: brief.incomplete ? 'Partial coverage' : 'Selected period' }, { label: 'ROAS', value: fmt.ratio(totals?.roas), sub: 'Revenue / ad spend' }, { label: 'Open findings', value: String(brief.issues.filter(x => ['open', 'monitoring'].includes(status(x.id))).length), sub: 'Rule-based review queue' }])}</div>
    <div class="wr-toolbar"><h3>Review queue</h3><label>Status <select data-filter>${[['active','Active'],['all','All'],['monitoring','Monitoring'],['resolved','Resolved'],['dismissed','Dismissed']].map(([v,l]) => `<option value="${v}" ${filter === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label></div>
    <div class="wr-list">${visible.map(x => `<article class="wr-finding"><div class="wr-priority ${x.priority}">${x.priority}</div><div class="wr-detail"><h3>${esc(x.title)}</h3><p>${esc(x.reason)}</p><p class="wr-action">${esc(x.action)}</p><details><summary>Evidence</summary><dl>${x.evidence.map(e => `<dt>${esc(e.label)}</dt><dd>${esc(typeof e.value === 'number' ? e.value.toLocaleString('en-US', {maximumFractionDigits:2}) : e.value ?? 'Unavailable')}</dd>`).join('')}</dl><p class="muted">Snapshot: ${esc(fmt.datetime(brief.generatedAt))}</p></details></div><div class="wr-controls"><button class="btn" data-view="${esc(x.view)}">Review</button><label class="sr-only" for="wr-${esc(x.id)}">Decision status</label><select id="wr-${esc(x.id)}" data-status="${esc(x.id)}">${['open','monitoring','resolved','dismissed'].map(s => `<option ${status(x.id) === s ? 'selected' : ''}>${s}</option>`).join('')}</select></div></article>`).join('') || '<p class="wr-empty">No findings in this view.</p>'}</div>
    <p class="muted wr-foot">Decisions: this browser only. ${brief.incomplete ? 'Report coverage is partial. ' : ''}Observational attribution; no campaign changes executed.</p>`;
  const selectedId = brief.issues.some(x => x.id === root.dataset.decision) ? root.dataset.decision : brief.issues[0]?.id;
  const entry = journal[selectedId] || {};
  if (selectedId) root.innerHTML += `<details class="wr-journal"><summary>Decision journal</summary><form data-journal><label>Finding<select name="finding">${brief.issues.map(x => `<option value="${esc(x.id)}" ${x.id === selectedId ? 'selected' : ''}>${esc(x.title)}</option>`).join('')}</select></label><label>Owner<input name="owner" maxlength="80" value="${esc(entry.owner || '')}"></label><label>Review date<input type="date" name="reviewDate" value="${esc(entry.reviewDate || '')}"></label><label class="wr-wide">Hypothesis and action taken<textarea name="hypothesis" maxlength="1200" rows="3">${esc(entry.hypothesis || '')}</textarea></label><button class="btn" type="submit">Save decision</button><span class="muted" data-journal-status>${entry.changedAt ? `Saved ${esc(fmt.datetime(entry.changedAt))}` : 'This browser only'}</span></form></details>`;
  root.querySelector('.wr-tools')?.insertAdjacentHTML('afterbegin', `<label>Period<select data-range>${Object.entries(ctx.snapshot?.ranges || {}).map(([key,value]) => `<option value="${esc(key)}" ${key === ctx.range ? 'selected' : ''} ${value.skipped ? 'disabled' : ''}>${esc(value.label || key)}</option>`).join('')}</select></label>`);
  root.querySelector('[data-range]')?.addEventListener('change', e => ctx.setRange?.(e.target.value));
  root.querySelector('[name="finding"]')?.addEventListener('change', e => { root.dataset.decision = e.target.value; render(ctx); root.querySelector('.wr-journal').open = true; });
  root.querySelector('[data-journal]')?.addEventListener('submit', e => {
    e.preventDefault();
    const form = e.currentTarget;
    const saved = saveDecision(account, selectedId, status(selectedId), { owner: form.elements.owner.value, reviewDate: form.elements.reviewDate.value, hypothesis: form.elements.hypothesis.value });
    root.querySelector('[data-journal-status]').textContent = saved ? 'Saved in this browser' : 'Could not save in this browser';
  });
  root.querySelector('[data-filter]')?.addEventListener('change', e => { root.dataset.filter = e.target.value; render(ctx); });
  root.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => ctx.selectView(b.dataset.view)));
  root.querySelectorAll('[data-status]').forEach(s => s.addEventListener('change', () => {
    if (!saveDecision(account, s.dataset.status, s.value)) ctx.note('Decision could not be saved in this browser.');
    render(ctx);
  }));
  root.querySelector('[data-export]')?.addEventListener('click', () => downloadFile(`hyros-evidence-${ctx.range}.json`, JSON.stringify(evidencePack(brief, { redact: root.querySelector('[data-export-mode]').value === 'public' }), null, 2)));
}

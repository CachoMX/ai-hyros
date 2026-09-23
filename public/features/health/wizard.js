import { diagnose, assessRecheck, remediationNote } from './diagnostics.js';

const sessions = new WeakMap();
const scopes = new WeakMap();
const result = (status, message) => ({ status, message });

export async function recheck(ctx, selected, current = () => true) {
  if (ctx.demo) return result('demo', 'Demo sample. A live recheck requires a connected account.');
  if (typeof ctx.api !== 'function') return result('unavailable', 'Refresh is unavailable in this host.');
  try {
    const response = await ctx.api('/api/refresh', { method: 'POST' });
    if (!current()) return result('superseded', 'The account or snapshot changed during this recheck.');
    const body = response?.body;
    if (!body?.ok || (response.status && response.status >= 400)) {
      return result('failed', body?.message || body?.error || `Refresh failed${response?.status ? ` (HTTP ${response.status})` : ''}.`);
    }
    if (body.account && ctx.account && body.account !== ctx.account) return result('inconclusive', 'Refresh returned a different account. No issue was verified.');
    if (body.persisted !== true) return result('not-persisted', 'Refresh completed, but the new snapshot was not confirmed stored. No correction was verified.');
    if (typeof ctx.reload === 'function') {
      try {
        await ctx.reload();
        return result('reloaded', 'Refresh completed and the current snapshot was loaded.');
      } catch {
        return result('reload-required', 'Refresh completed and stored, but the snapshot could not be loaded. Reload to inspect the new checks.');
      }
    }
    // Optional host bridge must both install and return the refreshed snapshot.
    if (typeof ctx.reloadSnapshot !== 'function') return result('reload-required', 'Refresh completed and stored. Reload the snapshot to inspect the new checks; no correction is verified yet.');
    try {
      const snapshot = await ctx.reloadSnapshot();
      return assessRecheck(selected, snapshot?.health, snapshot);
    } catch {
      return result('reload-required', 'Refresh completed and stored, but the snapshot could not be loaded. Reload to inspect the new checks.');
    }
  } catch (error) {
    return result('failed', error?.message || 'Refresh did not complete. No correction was verified.');
  }
}

function sessionFor(ctx) {
  const scope = `${ctx.account || ''}:${Boolean(ctx.demo)}`;
  if (scopes.get(ctx.root) !== scope) {
    scopes.set(ctx.root, scope);
    sessions.delete(ctx.root);
  }
  let state = sessions.get(ctx.root);
  if (!state) {
    state = { selected: null, step: 0, checked: new Map(), result: null, pending: false, block: ctx.block };
    sessions.set(ctx.root, state);
  } else if (state.block !== ctx.block) {
    state = { selected: state.selected, step: 0, checked: new Map(), result: null, pending: false, block: ctx.block };
    sessions.set(ctx.root, state);
  }
  state.ctx = ctx;
  return state;
}

export function wizardMarkup(ctx) {
  const state = sessionFor(ctx);
  const issues = diagnose(ctx.block, ctx.snapshot);
  const selected = issues.find((x) => x.id === state.selected) || issues[0];
  state.selected = selected?.id || null;
  const { esc, fmt } = ctx;
  const checked = state.checked.get(selected?.id) || [];
  const steps = ['Diagnosis', 'Correction proposal', 'Recheck'];
  return `<section class="health-wizard" aria-label="Tracking fix wizard">
    <div class="health-wizard-heading"><h3>Tracking fixes</h3><span class="pill">${issues.length} ${issues.length === 1 ? 'item' : 'items'}</span></div>
    <div class="health-result" role="status" aria-live="polite" aria-busy="${state.pending}">${esc(state.pending ? 'Account refresh pending. Existing evidence is still shown.' : state.result?.message || '')}</div>
    ${state.result?.status === 'reload-required' ? '<button type="button" data-health-reload>Reload snapshot</button>' : ''}
    ${state.report ? '<button type="button" data-health-export-result>Export recheck note</button><span class="sub" data-health-result-export-status role="status"></span>' : ''}
    ${selected ? `<div class="health-workflow">
      <div class="health-issues" role="group" aria-label="Issues">${issues.map((item, index) => `<button type="button" class="health-issue" data-health-issue="${index}" aria-pressed="${item.id === selected.id}" ${state.pending ? 'disabled' : ''}>
        <span class="pill ${item.severity === 'coverage' ? '' : 'warn'}">${item.severity === 'coverage' ? 'coverage' : 'review'}</span><span>${esc(item.title)}</span>${item.stale ? '<span class="sub">previous result</span>' : ''}</button>`).join('')}</div>
      <div class="health-detail">
        <div class="health-steps" role="group" aria-label="Remediation steps">${steps.map((name, index) => `<button type="button" data-health-step="${index}" aria-pressed="${state.step === index}">${index + 1}. ${name}</button>`).join('')}</div>
        <h4>${esc(selected.title)}</h4>
        <div class="sub">${selected.stale ? 'Previous evidence' : 'Evidence'}: ${esc(selected.checkedAt ? fmt.datetime(selected.checkedAt) : 'not checked')}${ctx.demo ? ' / demo sample' : ''}</div>
        ${state.step === 0 ? `<ul class="health-evidence">${selected.evidence.map((line) => `<li>${esc(line)}</li>`).join('')}</ul>${selected.impact ? `<p>${esc(selected.impact)}</p>` : ''}<button type="button" data-health-step="1">Review correction</button>` : ''}
        ${state.step === 1 ? `<div class="health-checklist">${selected.steps.map((line, index) => `<label><input type="checkbox" data-health-check="${index}" ${checked.includes(index) ? 'checked' : ''}><span>${esc(line)}</span></label>`).join('')}</div><p class="sub">Proposed steps only. Checklist completion is self-reported.</p><button type="button" data-health-step="2">Continue to recheck</button>` : ''}
        ${state.step === 2 ? `<p>Verification requires a fresh positive result for this site or ad. A missing row or a completed checklist cannot confirm a repair.</p><button type="button" data-health-recheck ${state.pending || ctx.demo || typeof ctx.api !== 'function' ? 'disabled' : ''}>${state.pending ? 'Rechecking...' : 'Recheck account'}</button>${ctx.demo ? '<p class="sub">Demo sample. Live recheck unavailable.</p>' : ''}` : ''}
        <div class="health-actions"><button type="button" data-health-export>Export remediation note</button><span class="sub" data-health-export-status role="status"></span></div>
      </div></div>` : '<div class="empty">No issues identified in the returned checks. Unchecked pages and ads remain outside this coverage.</div>'}
  </section>`;
}

export function wireWizard(ctx, rerender) {
  const state = sessionFor(ctx);
  state.rerender = rerender;
  const issues = diagnose(ctx.block, ctx.snapshot);
  const selected = issues.find((x) => x.id === state.selected);
  const root = ctx.root;
  const all = (selector) => root.querySelectorAll?.(selector) || [];
  const listen = (selector, event, handler) => { for (const node of all(selector)) node.addEventListener?.(event, handler); };
  listen('[data-health-issue]', 'click', (event) => {
    if (state.pending) return;
    state.selected = issues[Number(event.currentTarget.dataset.healthIssue)]?.id;
    state.step = 0;
    state.result = null;
    state.report = null;
    rerender();
  });
  listen('[data-health-step]', 'click', (event) => { state.step = Number(event.currentTarget.dataset.healthStep); rerender(); });
  listen('[data-health-check]', 'change', (event) => {
    if (!selected) return;
    const index = Number(event.currentTarget.dataset.healthCheck);
    const checked = new Set(state.checked.get(selected.id) || []);
    if (event.currentTarget.checked) checked.add(index); else checked.delete(index);
    state.checked.set(selected.id, [...checked]);
  });
  listen('[data-health-recheck]', 'click', async () => {
    if (!selected || state.pending || ctx.demo) return;
    state.pending = true;
    state.result = null;
    state.report = null;
    rerender();
    const outcome = await recheck(ctx, selected, () => sessions.get(root) === state);
    if (outcome.status === 'reloaded') {
      const next = sessions.get(root);
      if (!next || scopes.get(root) !== `${ctx.account || ''}:${Boolean(ctx.demo)}`) return;
      const assessment = assessRecheck(selected, next.ctx.block, next.ctx.snapshot);
      next.pending = false;
      next.result = { ...assessment, message: `Recheck for ${selected.title}: ${assessment.message}` };
      next.report = remediationNote(selected, { account: ctx.account, demo: ctx.demo,
        checked: state.checked.get(selected.id), result: next.result });
      // The host installed a new context; keep its snapshot when rendering the outcome.
      next.rerender?.();
      return;
    }
    // An old account's completion must not overwrite a newly rendered account.
    if (sessions.get(root) !== state || (state.block !== ctx.block)) return;
    state.pending = false;
    state.result = outcome;
    rerender();
  });
  listen('[data-health-reload]', 'click', () => globalThis.location?.reload?.());
  listen('[data-health-export], [data-health-export-result]', 'click', (event) => {
    const exportingResult = event.currentTarget.hasAttribute?.('data-health-export-result');
    if (!selected && !exportingResult) return;
    const doc = root.ownerDocument;
    const message = root.querySelector?.(exportingResult ? '[data-health-result-export-status]' : '[data-health-export-status]');
    if (!doc?.createElement || typeof URL.createObjectURL !== 'function') {
      if (message) message.textContent = 'File export is unavailable in this host.';
      return;
    }
    let url;
    try {
      const note = exportingResult ? state.report : remediationNote(selected, { account: ctx.account || ctx.snapshot?.account?.company, demo: ctx.demo,
        checked: state.checked.get(selected.id), result: state.pending ? result('pending', 'Account refresh pending; no correction verified.') : state.result });
      url = URL.createObjectURL(new Blob([note], { type: 'text/markdown;charset=utf-8' }));
      const anchor = doc.createElement('a');
      anchor.href = url;
      anchor.download = `tracking-remediation-${String(selected?.checkedAt || ctx.block?.checkedAt || 'undated').slice(0, 10).replace(/[^a-z0-9-]/gi, '')}.md`;
      anchor.click();
      if (message) message.textContent = 'Remediation note exported.';
    } catch {
      if (message) message.textContent = 'The note could not be exported.';
    } finally {
      if (url) setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  });
}

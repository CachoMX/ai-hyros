import { decisionBrief, answerQuestion, downloadFile } from '../../shared/decisions.js';

const sessions = new Map();
const roots = new WeakMap();
const VIEWS = new Set(['report', 'health', 'profit', 'creative', 'attribution', 'scale']);
const REASONS = {
  provider_disabled: 'Provider is not configured.', not_opted_in: 'Local answer selected.',
  rate_limited: 'Provider request limit reached.', rate_guard_unavailable: 'Provider rate guard unavailable.',
  provider_timeout: 'Provider timed out.', provider_error: 'Provider request failed.',
  provider_schema: 'Provider response could not be validated.', unsupported_citations: 'Unsupported provider citations were suppressed.',
  provider_refused: 'Provider did not answer.', evidence_too_large: 'Evidence exceeds the provider input limit.',
  request_failed: 'Provider request unavailable.', snapshot_changed: 'Snapshot changed; answer uses the current local snapshot.',
};
const html = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

export function render(ctx) {
  const root = ctx.root;
  if (!root) return;
  const esc = ctx.esc || html;
  const key = `${ctx.demo ? 'demo' : ctx.account || 'default'}:${ctx.range}`;
  const prior = roots.get(root);
  prior?.controller?.abort();
  prior?.capabilityController?.abort();
  if (!sessions.has(key)) sessions.set(key, []);
  if (sessions.size > 40) sessions.delete(sessions.keys().next().value);
  const history = sessions.get(key);
  const binding = { configured: false, capability: ctx.demo ? 'demo' : 'checking', useProvider: false,
    pending: false, draft: '', controller: null, capabilityController: null, sequence: 0 };
  roots.set(root, binding);
  const current = () => roots.get(root) === binding;
  const local = (question, reason = null) => {
    let answer;
    try { answer = answerQuestion(question, decisionBrief(ctx.snapshot || {}, ctx.range)); }
    catch { answer = { text: 'No verified answer is available in this snapshot. Review report coverage.', citations: [] }; }
    return { engine: 'snapshot-rules', fallbackReason: reason, answer };
  };
  const add = (question, result) => {
    history.push({ question, ...result, generatedAt: ctx.snapshot?.generatedAt || null });
    if (history.length > 30) history.shift();
  };
  const query = (selector) => root.querySelector?.(selector);
  const bind = (selector, event, handler) => {
    for (const element of root.querySelectorAll?.(selector) || []) element.addEventListener?.(event, handler);
  };

  async function ask(raw) {
    const question = String(raw || '').trim();
    if (!question || question.length > 2000 || binding.pending || !current()) return;
    const useProvider = binding.configured && binding.useProvider && !ctx.demo;
    binding.draft = '';
    binding.useProvider = false;
    if (!useProvider) { add(question, local(question)); draw(); query('[name="question"]')?.focus?.(); return; }
    binding.pending = true;
    const controller = new AbortController();
    binding.controller = controller;
    const sequence = ++binding.sequence;
    draw();
    let result;
    let timer;
    try {
      const response = await Promise.race([
        ctx.api('/api/copilot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
          body: JSON.stringify({ question, range: ctx.range, useProvider: true }) }),
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, 18000); }),
      ]);
      if (!current() || sequence !== binding.sequence) return;
      const body = response?.body;
      if (response.status !== 200 || !body?.ok || !['openai', 'snapshot-rules'].includes(body.engine)
        || typeof body.answer?.text !== 'string' || body.answer.text.length > 3000 || !Array.isArray(body.answer.citations)
        || body.answer.citations.length > 8 || body.range !== ctx.range) throw new Error('invalid_response');
      if (body.account !== ctx.account || body.generatedAt !== (ctx.snapshot?.generatedAt || null)) result = local(question, 'snapshot_changed');
      else result = { engine: body.engine, fallbackReason: REASONS[body.fallbackReason] ? body.fallbackReason : null,
        answer: { text: body.answer.text, citations: body.answer.citations.filter((citation) => citation && VIEWS.has(citation.view)
          && typeof citation.title === 'string' && citation.title.length <= 500) } };
    } catch { result = local(question, 'request_failed'); }
    finally { clearTimeout(timer); }
    if (!current() || sequence !== binding.sequence) return;
    binding.pending = false;
    binding.controller = null;
    add(question, result);
    draw();
    query('[name="question"]')?.focus?.();
  }

  function draw() {
    if (!current()) return;
    const engine = binding.useProvider ? 'OpenAI selected for next question' : 'Snapshot rules';
    const capability = ctx.demo ? 'Demo: local snapshot rules.' : binding.capability === 'checking' ? 'Checking provider availability.'
      : binding.configured ? 'OpenAI available. Question and redacted aggregate evidence leave this app only when selected.'
        : binding.capability === 'unavailable' ? 'Provider availability could not be checked. Local snapshot rules remain available.'
          : 'No generative provider configured.';
    const when = ctx.snapshot?.generatedAt;
    root.innerHTML = `<div class="cp-header"><div><h2>Evidence Copilot</h2><p class="muted">${esc(engine)} &middot; ${esc(ctx.range)} &middot; ${esc(when ? ctx.fmt?.datetime?.(when) || when : 'Snapshot date unavailable')}</p></div><div><button class="btn" data-export ${history.length ? '' : 'disabled'}>Export transcript</button> <button class="btn" data-clear ${history.length || binding.pending ? '' : 'disabled'}>Clear</button></div></div>
      ${ctx.block?.stale ? '<p class="muted">Showing the previous refresh.</p>' : ''}
      <div class="cp-header"><label><input type="checkbox" data-provider ${binding.useProvider ? 'checked' : ''} ${!binding.configured || binding.pending ? 'disabled' : ''}> Use OpenAI for next question</label><span class="muted">No external actions enabled.</span></div>
      <p class="muted" role="status">${esc(capability)}</p>
      <div class="cp-suggestions">${['Review priorities', 'Revenue summary', 'Tracking health', 'Profit and margins', 'Attribution winners', 'Scaling budget'].map((question) => `<button class="btn" data-question="${esc(question)}" ${binding.pending ? 'disabled' : ''}>${esc(question)}</button>`).join('')}</div>
      <div class="cp-messages" aria-live="polite">${history.map((turn) => `<article class="cp-turn"><p class="cp-question" style="overflow-wrap:anywhere">${esc(turn.question)}</p><p class="muted">${turn.engine === 'openai' ? 'OpenAI generated; verify cited evidence.' : 'Snapshot rules'}${turn.fallbackReason ? ` &middot; ${esc(REASONS[turn.fallbackReason] || 'Local fallback.')}` : ''}</p><p class="cp-answer">${esc(turn.answer.text)}</p>${turn.answer.citations.length ? `<div class="cp-sources">${turn.answer.citations.map((citation) => `<button class="btn" data-view="${esc(citation.view)}">${esc(citation.title)}</button>`).join('')}</div>` : ''}</article>`).join('') || '<div class="cp-empty"><h3>Account brief</h3><p>Evidence source: the current snapshot.</p></div>'}${binding.pending ? '<p role="status">Waiting for OpenAI...</p>' : ''}</div>
      <form class="cp-form"><input id="cp-input" name="question" aria-label="Question" placeholder="What needs review?" maxlength="2000" required autocomplete="off" value="${esc(binding.draft)}" ${binding.pending ? 'disabled' : ''}><button class="btn primary" type="submit" ${binding.pending ? 'disabled' : ''}>Ask</button></form>`;
    query('form')?.addEventListener?.('submit', (event) => { event.preventDefault(); void ask(query('[name="question"]')?.value); });
    query('[name="question"]')?.addEventListener?.('input', (event) => { binding.draft = event.currentTarget.value; });
    query('[data-provider]')?.addEventListener?.('change', (event) => {
      if (!current() || !binding.configured || binding.pending) return;
      binding.draft = query('[name="question"]')?.value || binding.draft;
      binding.useProvider = event.currentTarget.checked;
      draw();
    });
    bind('[data-question]', 'click', (event) => { void ask(event.currentTarget.dataset.question); });
    bind('[data-view]', 'click', (event) => { if (VIEWS.has(event.currentTarget.dataset.view)) ctx.selectView?.(event.currentTarget.dataset.view); });
    query('[data-clear]')?.addEventListener?.('click', () => {
      binding.controller?.abort(); binding.sequence += 1; binding.pending = false; binding.useProvider = false;
      history.length = 0; draw();
    });
    query('[data-export]')?.addEventListener?.('click', () => downloadFile('hyros-copilot-transcript.json',
      JSON.stringify({ range: ctx.range, generatedAt: ctx.snapshot?.generatedAt, history }, null, 2)));
  }
  draw();
  // A capability GET contains no prompt. Never issue it in demo or fake-DOM checks.
  if (!ctx.demo && root.ownerDocument && typeof ctx.api === 'function') {
    const controller = new AbortController();
    binding.capabilityController = controller;
    let timer;
    Promise.race([
      Promise.resolve().then(() => current() ? ctx.api('/api/copilot', { method: 'GET', signal: controller.signal }) : null),
      new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, 6000); }),
    ]).then((response) => {
      if (!current()) return;
      binding.configured = response?.status === 200 && response.body?.configured === true && response.body?.provider === 'openai';
      binding.capability = response?.status === 200 ? 'checked' : 'unavailable';
      draw();
    }).catch(() => { if (current()) { binding.capability = 'unavailable'; draw(); } }).finally(() => clearTimeout(timer));
  } else if (!ctx.demo) { binding.capability = 'unavailable'; draw(); }
}

/**
 * Tracking Health — server step. Returns the block stored as snapshot.health.
 *
 * Three independent checks, run cheapest first so a slow HYROS answer can
 * never starve the others: the verified-domain list, the two Google
 * tracking-parameter checks, and LAST the script-presence check, which
 * fetches every domain live and regularly needs more than the 15 s per-call
 * contract — it gets the runner's slow lane (`ctx.timeouts.slow`) when one
 * is offered.
 *
 * Every check records what happened in `checks.<name>`:
 *   { status: 'ok' | 'empty' | 'skipped' | 'failed', reason?, ms? }
 * so the view can say "skipped: time budget" or "HYROS did not answer" in
 * the tile itself instead of a grey footnote. `errors[]` keeps the failed
 * checks as strings for older readers of the block; skips are not errors.
 *
 * Neither tool has a documented argument or reply schema (FINDINGS.md), so
 * replies are read tolerantly, and a reply the code cannot read is a failed
 * check ("unexpected reply shape") rather than a silently empty result.
 */
const DEFAULT_TIMEOUT_MS = 15000;        // FEATURES.md: the per-call contract
const SLOW_TIMEOUT_FALLBACK_MS = 45000;  // the slow lane when a runner offers `timeouts` without `slow`
const SLOW_MIN_LEFT_MS = 8000;           // below this the script check is skipped, not started
const SLOW_MARGIN_MS = 2000;             // the slow call must end this long before the step deadline
const MIN_CALL_BUDGET_MS = 3000;         // do not start a cheap call with less than this left
const MAX_DOMAINS = 20;
const MAX_SCRIPT_CHECKS = 5;
const MAX_PARAM_ROWS = 50;
const GOOGLE_CHANNELS = ['SEARCH', 'PERFORMANCE_MAX'];
const MARKERS = ['skipped', 'error', 'stale'];
const COMPLETED = new Set(['ok', 'empty']);

const isMap = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** The data keys of a block, without the runner's markers. */
const dataOf = (block) => (isMap(block) ? Object.fromEntries(Object.entries(block).filter(([k]) => !MARKERS.includes(k))) : {});

/** Out of time before the first call: previous data marked stale, or a bare marker. */
const skippedBlock = (previous, reason) => (Object.keys(dataOf(previous)).length
  ? { ...dataOf(previous), stale: true, skipped: reason }
  : { skipped: reason });

// --- per-check status records -------------------------------------------------
const ok = (ms) => ({ status: 'ok', ms });
const empty = (ms) => ({ status: 'empty', ms });
const skipped = (reason) => ({ status: 'skipped', reason });
const failed = (reason, ms) => (ms === undefined ? { status: 'failed', reason } : { status: 'failed', reason, ms });

// --- timeouts -----------------------------------------------------------------
/** The per-call timeout for the cheap checks: the runner's default, else the 15 s contract. */
const defaultTimeout = (ctx) => Math.min(ctx.timeouts?.default ?? DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);

/**
 * The script check's timeout. A runner that exposes `ctx.timeouts` has
 * declared a slow lane (`slow`, 45 s when unset); one that does not is still
 * on the 15 s contract, which the conformance stub enforces. Either way the
 * call ends before the step deadline.
 */
function slowTimeout(ctx) {
  const lane = ctx.timeouts ? (ctx.timeouts.slow ?? SLOW_TIMEOUT_FALLBACK_MS) : defaultTimeout(ctx);
  return Math.min(lane, ctx.timeLeft() - SLOW_MARGIN_MS);
}

const isTimeout = (err) => err?.code === 'timeout' || /timed out/i.test(err?.message || '');

/** A tool call with a stopwatch: { value, ms } or { error, ms } — never throws. */
async function timed(callTool, name, args, timeoutMs) {
  const started = Date.now();
  try { return { value: await callTool(name, args, { timeoutMs }), ms: Date.now() - started }; }
  catch (error) { return { error, ms: Date.now() - started }; }
}

// --- reply readers (undocumented shapes, read tolerantly) ----------------------
/** hyros_get_domains: string[] | { result | domains: [string | { domain | name | url }] }. */
function readDomains(d) {
  const list = Array.isArray(d) ? d : (Array.isArray(d?.result) ? d.result : (Array.isArray(d?.domains) ? d.domains : []));
  return list.map((x) => (typeof x === 'string' ? x : x?.domain || x?.name || x?.url)).filter(Boolean).slice(0, MAX_DOMAINS);
}

/**
 * hyros_assert_script_presence_on_domain: { url: status } (possibly under
 * `result`), or [{ url | domain, status | result | present }]. Anything else
 * is "unexpected": returns null so the caller can record it.
 */
function readScripts(r) {
  const map = isMap(r?.result) ? r.result : r;
  if (isMap(map)) return Object.fromEntries(Object.entries(map).map(([k, v]) => [k, typeof v === 'string' ? v : (v?.status ?? v?.result ?? String(v))]));
  if (Array.isArray(map) && map.length && map.every(isMap)) {
    const entries = map.map((row) => [row.url || row.domain, row.status ?? row.result ?? (row.present === undefined ? undefined : (row.present ? 'SCRIPT_FOUND' : 'SCRIPT_NOT_FOUND'))])
      .filter(([k, v]) => k && v !== undefined);
    return entries.length ? Object.fromEntries(entries) : null;
  }
  return null;
}

/** hyros_check_tracking_parameters_for_integrations: rows under result | ads, a bare array, or one object. */
function readParamRows(r) {
  const rows = Array.isArray(r) ? r : (Array.isArray(r?.result) ? r.result : (Array.isArray(r?.ads) ? r.ads : (isMap(r) ? [r] : [])));
  return rows.slice(0, MAX_PARAM_ROWS);
}

const toUrl = (dom) => (/^https?:\/\//.test(dom) ? dom : `https://${dom}/`);

// --- the three checks ---------------------------------------------------------
async function checkDomains(ctx) {
  ctx.log('health domains');
  const r = await timed(ctx.callTool, 'hyros_get_domains', {}, defaultTimeout(ctx));
  if (r.error) return { domains: [], check: failed(r.error.message, r.ms) };
  const domains = readDomains(r.value);
  return { domains, check: domains.length ? ok(r.ms) : empty(r.ms) };
}

/** One channel of the parameter check: { type, rows?, status, error? }. */
async function checkChannel(ctx, type) {
  if (ctx.timeLeft() < MIN_CALL_BUDGET_MS) return { type, status: 'skipped', ms: 0 };
  ctx.log(`health params ${type}`);
  const r = await timed(ctx.callTool, 'hyros_check_tracking_parameters_for_integrations', { request: { type } }, defaultTimeout(ctx));
  if (r.error) return { type, status: 'failed', error: `params ${type}: ${r.error.message}`, ms: r.ms };
  const rows = readParamRows(r.value);
  return { type, rows, status: rows.length ? 'ok' : 'empty', ms: r.ms };
}

/** The overall params status from its channels: any rows → ok; ran but nothing → empty; else failed before skipped. */
function paramsStatus(results) {
  const statuses = results.map((c) => c.status);
  if (statuses.includes('ok')) return { status: 'ok' };
  if (statuses.includes('empty')) return { status: 'empty' };
  if (statuses.includes('failed')) return { status: 'failed', reason: results.filter((c) => c.error).map((c) => c.error.replace(/^params /, '')).join(' · ') };
  return { status: 'skipped', reason: 'time budget' };
}

async function checkParams(ctx, hasGoogle) {
  if (!hasGoogle) return { trackingParams: [], errors: [], check: skipped('no Google ad accounts connected') };
  const results = [];
  for (const type of GOOGLE_CHANNELS) results.push(await checkChannel(ctx, type));   // sequential: one rate limit per account
  const channels = Object.fromEntries(results.map((c) => [c.type, c.status]));
  const ms = results.reduce((sum, c) => sum + c.ms, 0);
  return {
    trackingParams: results.filter((c) => c.rows).map(({ type, rows }) => ({ type, rows })),
    errors: results.filter((c) => c.error).map((c) => c.error),
    check: { ...paramsStatus(results), ms, channels },
  };
}

const scriptFailure = (err, timeoutMs) => (isTimeout(err)
  ? `HYROS did not answer within ${Math.round(timeoutMs / 1000)}s (the check fetches every domain live)`
  : err.message);

async function checkScript(ctx, domains, domainsCheck) {
  if (domainsCheck.status === 'failed') return { scripts: {}, check: skipped('domains check failed') };
  if (!domains.length) return { scripts: {}, check: skipped('no verified domains') };
  if (ctx.timeLeft() < SLOW_MIN_LEFT_MS) return { scripts: {}, check: skipped('time budget') };
  const timeoutMs = slowTimeout(ctx);
  ctx.log('health script');
  const r = await timed(ctx.callTool, 'hyros_assert_script_presence_on_domain', { domains: domains.slice(0, MAX_SCRIPT_CHECKS).map(toUrl) }, timeoutMs);
  if (r.error) return { scripts: {}, check: failed(scriptFailure(r.error, timeoutMs), r.ms) };
  const scripts = readScripts(r.value);
  if (!scripts) return { scripts: {}, check: failed('unexpected reply shape', r.ms) };
  return { scripts, check: Object.keys(scripts).length ? ok(r.ms) : empty(r.ms) };
}

/**
 * The script check is the expensive one, so when it could not run this
 * refresh the panel still shows the last known per-URL results: the
 * previous block's `scripts`, with the check marked `stale` and dated by the
 * refresh that produced them (kept through repeated carry-forwards). Only a
 * previous check that completed — or was itself carried forward — counts; a
 * block from before `checks` existed counts when it has results.
 */
function carryScripts(previous, check) {
  const prev = dataOf(previous);
  const scripts = isMap(prev.scripts) ? prev.scripts : {};
  const prevCheck = prev.checks?.script;
  const usable = Object.keys(scripts).length && (!prevCheck || COMPLETED.has(prevCheck.status) || prevCheck.stale === true);
  if (!usable) return null;
  const checkedAt = prevCheck?.checkedAt || prev.checkedAt;
  return { scripts, check: { ...check, stale: true, ...(checkedAt ? { checkedAt } : {}) } };
}

export async function build(ctx) {
  if (ctx.timeLeft() < MIN_CALL_BUDGET_MS) return skippedBlock(ctx.previous, 'time budget');
  const now = ctx.now instanceof Date ? ctx.now : new Date();
  const hasGoogle = (ctx.snapshot?.adAccounts || []).some((a) => /GOOGLE/.test(a.type || ''));

  const dom = await checkDomains(ctx);
  const params = await checkParams(ctx, hasGoogle);
  const script = await checkScript(ctx, dom.domains, dom.check);
  const carried = COMPLETED.has(script.check.status) ? null : carryScripts(ctx.previous, script.check);

  return {
    checkedAt: now.toISOString(),
    domains: dom.domains,
    scripts: carried ? carried.scripts : script.scripts,
    trackingParams: params.trackingParams,
    errors: [
      ...(dom.check.status === 'failed' ? [`domains: ${dom.check.reason}`] : []),
      ...params.errors,
      ...(script.check.status === 'failed' ? [`script: ${script.check.reason}`] : []),
    ],
    checks: { domains: dom.check, params: params.check, script: carried ? carried.check : script.check },
  };
}

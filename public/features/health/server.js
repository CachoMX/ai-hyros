/**
 * Tracking Health — server step. Returns the block stored as snapshot.health.
 *
 * Neither tool has a documented argument or reply schema (FINDINGS.md), so
 * replies are read tolerantly, and a reply the code cannot read is recorded
 * in `errors` rather than silently turned into an empty result.
 */
const PER_CALL_TIMEOUT_MS = 15000;   // FEATURES.md: per-call timeouts <= 15 s
const MIN_CALL_BUDGET_MS = 3000;     // do not start a call with less than this left
const MAX_DOMAINS = 20;
const MAX_SCRIPT_CHECKS = 5;
const MAX_PARAM_ROWS = 50;
const GOOGLE_CHANNELS = ['SEARCH', 'PERFORMANCE_MAX'];
const MARKERS = ['skipped', 'error', 'stale'];

const isMap = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** Out of time before the first call: previous data marked stale, or a bare marker. */
function skippedBlock(previous, reason) {
  const data = isMap(previous) ? Object.fromEntries(Object.entries(previous).filter(([k]) => !MARKERS.includes(k))) : {};
  return Object.keys(data).length ? { ...data, stale: true, skipped: reason } : { skipped: reason };
}

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

export async function build(ctx) {
  const { callTool, snapshot, log } = ctx;
  if (ctx.timeLeft() < MIN_CALL_BUDGET_MS) return skippedBlock(ctx.previous, 'time budget');
  const now = ctx.now instanceof Date ? ctx.now : new Date();
  const out = { checkedAt: now.toISOString(), domains: [], scripts: {}, trackingParams: [], errors: [] };

  log('health domains');
  try {
    out.domains = readDomains(await callTool('hyros_get_domains', {}, { timeoutMs: PER_CALL_TIMEOUT_MS }));
  } catch (err) { out.errors.push(`domains: ${err.message}`); }

  if (out.domains.length) {
    if (ctx.timeLeft() < MIN_CALL_BUDGET_MS) out.errors.push('script: skipped (time budget)');
    else {
      log('health script');
      try {
        const urls = out.domains.slice(0, MAX_SCRIPT_CHECKS).map((dom) => (/^https?:\/\//.test(dom) ? dom : `https://${dom}/`));
        const scripts = readScripts(await callTool('hyros_assert_script_presence_on_domain', { domains: urls }, { timeoutMs: PER_CALL_TIMEOUT_MS }));
        if (scripts) out.scripts = scripts;
        else out.errors.push('script: unexpected reply shape');
      } catch (err) { out.errors.push(`script: ${err.message}`); }
    }
  }

  // Google ad links need their tracking parameters; check the common channels.
  if ((snapshot.adAccounts || []).some((a) => /GOOGLE/.test(a.type || ''))) {
    for (const type of GOOGLE_CHANNELS) {
      if (ctx.timeLeft() < MIN_CALL_BUDGET_MS) { out.errors.push(`params ${type}: skipped (time budget)`); continue; }
      log(`health params ${type}`);
      try {
        const r = await callTool('hyros_check_tracking_parameters_for_integrations', { request: { type } }, { timeoutMs: PER_CALL_TIMEOUT_MS });
        out.trackingParams.push({ type, rows: readParamRows(r) });
      } catch (err) { out.errors.push(`params ${type}: ${err.message}`); }
    }
  }
  return out;
}

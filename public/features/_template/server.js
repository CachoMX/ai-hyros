/**
 * server.js — the live data step, run by /api/refresh AFTER the core
 * snapshot exists. Export build(ctx) and return the block for snapshot[id].
 *
 * ctx: { id, manifest, callTool(name, args, {timeoutMs}), callToolPaged,
 *        snapshot (core: account, adAccounts, ranges, crm, settings, warnings),
 *        previous (this feature's block from the last snapshot, or null),
 *        deadline, timeLeft() ms, log(step), env: { HYROS_CAC_CEILING }, now }
 *
 * Rules (FEATURES.md "server.js"):
 * - `ctx.timeLeft()` governs. Check it BEFORE THE FIRST call and before
 *   every call after it; a spent budget must mean ZERO MCP calls.
 * - Never throw for a partial result — put errors INSIDE the block. Out of
 *   time before the first call: return the previous data marked stale
 *   (`{ ...data, stale: true, skipped }`) or a bare `{ skipped }`.
 * - `previous` may itself carry `stale` / `skipped` markers from the last
 *   run: strip them (see `dataOf`) before syncing incrementally from it.
 * - MCP limits: 50 ids / emails / tags per call, pageSize <= 250, per-call
 *   timeouts <= 15 s, one rate limit per HYROS account (every key of the
 *   account shares it), `accessible_account_id` is already applied — never
 *   pass it yourself. List every tool you call in the manifest `tools`.
 * - No Node built-ins, no packages, no env vars for setup.
 */
const PER_CALL_TIMEOUT_MS = 15000;
const MIN_CALL_BUDGET_MS = 3000;
const MARKERS = ['skipped', 'error', 'stale'];

/** The data keys of a block, without the runner's markers. */
const dataOf = (block) => (block && typeof block === 'object'
  ? Object.fromEntries(Object.entries(block).filter(([k]) => !MARKERS.includes(k))) : {});

/** Out of time: previous data marked stale, or a bare marker when there is none. */
const skippedBlock = (previous, reason) => (Object.keys(dataOf(previous)).length
  ? { ...dataOf(previous), stale: true, skipped: reason }
  : { skipped: reason });

export async function build(ctx) {
  const { callTool, snapshot, log } = ctx;
  if (ctx.timeLeft() < MIN_CALL_BUDGET_MS) return skippedBlock(ctx.previous, 'time budget');
  const range = snapshot.ranges['30d'];
  const rows = [];
  const errors = [];
  for (const c of [...range.levels.campaign].slice(0, 5)) {
    if (ctx.timeLeft() < MIN_CALL_BUDGET_MS) { errors.push(`${c.name}: skipped (time budget)`); continue; }
    log(`fetch ${c.name}`);
    try {
      // Example: a real call would go here, e.g.
      //   const r = await callTool('hyros_get_attribution_report', { request: { ... } }, { timeoutMs: PER_CALL_TIMEOUT_MS });
      // This template just echoes the core snapshot.
      rows.push({ name: c.name, value: c.revenue || 0 });
    } catch (err) { errors.push(`${c.name}: ${err.message}`); }
  }
  void callTool; void PER_CALL_TIMEOUT_MS; // remove once you make a real call
  return { window: { start: range.start, end: range.end }, rows, errors };
}

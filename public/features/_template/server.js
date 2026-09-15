/**
 * server.js — the live data step, run by /api/refresh AFTER the core
 * snapshot exists. Export build(ctx) and return the block for snapshot[id].
 *
 * ctx: { id, manifest, callTool(name, args, {timeoutMs}), callToolPaged,
 *        snapshot (core: account, adAccounts, ranges, crm, settings),
 *        previous (this feature's block from the last snapshot, or null),
 *        deadline, timeLeft() ms, log(step), env: { HYROS_CAC_CEILING }, now }
 * Rules: check ctx.timeLeft() before each MCP call (the whole refresh has
 * ~50s); never throw for a partial result — put errors INSIDE the block;
 * keep MCP calls small (page sizes ≤250, timeouts ≤15s); no node modules.
 */
export async function build(ctx) {
  const { callTool, snapshot, log } = ctx;
  const range = snapshot.ranges['30d'];
  const rows = [];
  const errors = [];
  for (const c of [...range.levels.campaign].slice(0, 5)) {
    if (ctx.timeLeft() < 5000) { errors.push(`${c.name}: skipped (time budget)`); continue; }
    log(`fetch ${c.name}`);
    try {
      // Example: a real call would go here. This template just echoes the core snapshot.
      rows.push({ name: c.name, value: c.revenue || 0 });
    } catch (err) { errors.push(`${c.name}: ${err.message}`); }
  }
  void callTool; // remove once you make a real call
  return { window: { start: range.start, end: range.end }, rows, errors };
}

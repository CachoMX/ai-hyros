import { nativeLtv, observedRevenue, salesHistory, cohortLtv } from './analytics.js';

export async function build(ctx) {
  if (ctx.timeLeft?.() <= 0) {
    const previous = Object.fromEntries(Object.entries(ctx.previous || {}).filter(([k]) => !['stale', 'error', 'skipped'].includes(k)));
    return Object.keys(previous).length ? { ...previous, stale: true, skipped: 'time budget' } : { skipped: 'time budget' };
  }
  try {
    const snapshot = ctx.snapshot || {};
    const attribution = snapshot.attribution;
    const native = nativeLtv(snapshot);
    const observed = observedRevenue(attribution, native);
    const block = {
      mode: 'observed', checkedAt: attribution?.checkedAt || ctx.now?.toISOString() || null,
      window: { start: attribution?.window?.start || null, end: attribution?.window?.end || null },
      pathStatus: Array.isArray(attribution?.conversions) ? 'ready' : attribution?.error ? 'error' : attribution?.skipped ? 'skipped' : 'unavailable',
      pathReason: attribution?.error || attribution?.skipped ? String(attribution.error || attribution.skipped).slice(0, 600) : null,
      ...observed, native, cohorts: cohortLtv(salesHistory(snapshot), ctx.now?.toISOString()),
      coverage: { sampled: attribution?.coverage?.sampled ?? null, complete: attribution?.coverage?.complete === true, truncated: Boolean(attribution?.coverage?.truncated) },
      errors: (Array.isArray(attribution?.errors) ? attribution.errors.map((e) => String(e).slice(0, 600)) : []).slice(0, 15),
    };
    if (observed.truncated) block.errors.push('Some observed source, lead or candidate rows were omitted to fit this snapshot.');
    if (attribution?.stale) { block.stale = true; block.skipped = attribution.skipped || 'attribution data from previous refresh'; }
    const size = () => new TextEncoder().encode(JSON.stringify(block)).length;
    if (size() > 180000) {
      block.errors.push('Additional detail rows omitted to keep the snapshot below 180 KB.');
      block.truncated = true;
      const groups = [block.leads, block.rows, block.candidates, block.native, block.cohorts.rows];
      while (size() > 180000 && groups.some((rows) => rows.length)) groups.find((rows) => rows.length).pop();
    }
    return block;
  } catch (err) { return { error: err.message }; }
}

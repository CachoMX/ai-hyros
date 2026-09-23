import { captureEconomicsSnapshot, skippedEconomics } from '../../shared/profit.js';
import { comparablePeriods } from './analysis.js';

export function creativeBlock(snapshot, previous) {
  const block = captureEconomicsSnapshot(snapshot, 'ad');
  block.comparison = null;
  if (previous?.error || previous?.stale || previous?.skipped) return block;
  // Retain at most one actual previous window to stay within the block size budget.
  for (const key of ['30d', '7d', 'yesterday']) {
    const current = { ...block.ranges[key], model: block.model, currency: block.currency, context: block.context };
    const prior = { ...previous?.ranges?.[key], model: previous?.model, currency: previous?.currency, context: previous?.context };
    const retained = previous?.comparison?.rangeKey === key ? previous.comparison : null;
    const candidate = comparablePeriods(current, prior, block.checkedAt) ? prior : retained;
    if (candidate && comparablePeriods(current, candidate, block.checkedAt)) {
      block.comparison = { ...candidate, rangeKey: key, checkedAt: candidate.checkedAt ?? previous.checkedAt };
      break;
    }
  }
  return block;
}

export async function build(ctx) {
  if (ctx.timeLeft() <= 0) return skippedEconomics(ctx.previous);
  try { return creativeBlock(ctx.snapshot, ctx.previous); }
  catch (error) { return { error: String(error.message || error) }; }
}

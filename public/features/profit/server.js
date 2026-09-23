import { captureEconomicsSnapshot, skippedEconomics } from '../../shared/profit.js';

export async function build(ctx) {
  if (ctx.timeLeft() <= 0) return skippedEconomics(ctx.previous);
  try { return captureEconomicsSnapshot(ctx.snapshot, 'adset'); }
  catch (error) { return { error: String(error.message || error) }; }
}

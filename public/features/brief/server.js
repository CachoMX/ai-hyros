import { buildBrief, sanitizeBrief } from './model.js';

export async function build(ctx) {
  if (typeof ctx.timeLeft === 'function' && ctx.timeLeft() <= 0) {
    const previous = sanitizeBrief(ctx.previous);
    return previous.current ? { ...previous, stale: true, skipped: 'time budget' } : { skipped: 'time budget' };
  }
  return buildBrief(ctx.snapshot || {}, ctx.previous, ctx.now);
}

import { RANGES, summarizeAccount } from './model.js';

export async function build(ctx) {
  if (typeof ctx.timeLeft === 'function' && ctx.timeLeft() <= 0) {
    const previous = Object.fromEntries(Object.entries(ctx.previous || {}).filter(([key]) => !['error', 'stale', 'skipped'].includes(key)));
    return Object.keys(previous).length ? { ...previous, stale: true, skipped: 'time budget' } : { skipped: 'time budget' };
  }
  const checkedAt = new Date(ctx.now || Date.now()).toISOString();
  const snapshot = { ...ctx.snapshot, generatedAt: ctx.snapshot?.generatedAt || checkedAt };
  const current = Object.fromEntries(RANGES.map((range) => [range, summarizeAccount({ id: '', company: 'Current account' }, snapshot, { range, now: checkedAt })]));
  return { checkedAt, current, accounts: [] };
}

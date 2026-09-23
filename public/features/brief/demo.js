import { buildBrief, timestamp } from './model.js';

export function demo(snapshot = {}) {
  const end = timestamp(snapshot.generatedAt) || '2026-09-23T12:00:00.000Z';
  const original = snapshot.ranges?.['7d'];
  const start = original?.start || '2026-09-17', to = original?.end || '2026-09-23';
  const base = original?.totals || {};
  const value = (key, fallback) => typeof base[key] === 'number' && Number.isFinite(base[key]) ? base[key] : fallback;
  let previous = null;
  for (let index = 0; index < 4; index += 1) {
    const generatedAt = new Date(Date.parse(end) - (3 - index) * 3600000).toISOString();
    const fresh = {
      generatedAt, account: { currency: 'USD', timezone: '+00:00' }, attributionModel: 'LAST_CLICK',
      settings: { windowDays: 0, leadStage: [] },
      ranges: { '7d': { start, end: to, totals: {
        cost: value('cost', 1400), totalRevenue: value('totalRevenue', 4200) * (0.85 + index * 0.05),
        calls: Math.max(0, value('calls', 36) - (3 - index)), sales: Math.max(0, value('sales', 24) - (3 - index)),
      } } },
      health: { checkedAt: generatedAt, checks: { script: { status: 'ok' }, params: { status: 'ok' }, domains: { status: 'ok' } },
        scripts: { 'demo-tracking-site': index >= 2 ? 'SCRIPT_NOT_FOUND' : 'SCRIPT_FOUND' }, trackingParams: [] },
      crm: { sync: { truncated: { leads: false, sales: index === 3 } } },
      attribution: { coverage: { sampled: 30, withPaths: 30, complete: true, truncated: false } },
    };
    previous = buildBrief(fresh, previous, generatedAt);
  }
  return { ...previous, demo: true };
}

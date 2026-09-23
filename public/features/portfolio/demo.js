import { RANGES, summarizeAccount } from './model.js';

export function demo(snapshot = {}) {
  const checkedAt = snapshot.generatedAt || '2026-09-01T12:00:00.000Z';
  const profiles = [
    { id: 'demo-portfolio-north', label: 'Demo / North Studio', currency: 'USD', factor: 1, hours: 0 },
    { id: 'demo-portfolio-field', label: 'Demo / Field Goods', currency: 'USD', factor: 0.56, hours: 49 },
    { id: 'demo-portfolio-form', label: 'Demo / Form Collective', currency: 'EUR', factor: 0.78, hours: 2 },
  ];
  const accounts = profiles.map((profile) => {
    const generatedAt = new Date(Date.parse(checkedAt) - profile.hours * 3600000).toISOString();
    const ranges = Object.fromEntries(RANGES.map((range) => {
      const original = snapshot.ranges?.[range] || {};
      const base = original.totals || {};
      const metric = (key, fallback) => Math.round((typeof base[key] === 'number' ? base[key] : fallback) * profile.factor * 100) / 100;
      return [range, { start: original.start || '2026-08-03', end: original.end || '2026-09-01', totals: {
        cost: metric('cost', 12000), totalRevenue: metric('totalRevenue', 35400), calls: Math.round(metric('calls', 74)), leads: Math.round(metric('leads', 612)),
      } }];
    }));
    const fixture = { generatedAt, ranges, account: { currency: profile.currency } };
    return { id: profile.id, ranges: Object.fromEntries(RANGES.map((range) => [range, summarizeAccount(profile, fixture, { range, now: checkedAt, demo: true })])) };
  });
  return { checkedAt, current: {}, accounts };
}

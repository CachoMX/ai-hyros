/**
 * Demo block for Scale Advisor: curves in the shape normalizeCurve() produces
 * from the documented hyros_get_marginal_cac_curve reply. Deterministic
 * (seeded rng); ad sets carry HYROS's LTV break-even ceiling, ad accounts
 * carry none (the documented account-level rule when the caller sets no
 * cacCeiling), so the demo never invents a saturation point HYROS would not.
 */
import { rng, jitter, round2, ymd, daysAgo } from '../../demo.js';

const POINTS = 8;
const LTV_WINDOW = '90_days';

function curvePoints(daily, base, steep, days) {
  const points = [];
  let prevSpend = 0; let prevCustomers = 0;
  for (let k = 1; k <= POINTS; k += 1) {
    const spend = Math.round(daily * (0.4 + k * 0.25));
    const ratio = spend / (daily || 1);
    const avgCac = round2(base * (1 + steep * 0.35 * (ratio - 0.65) * (ratio - 0.65)));
    const customers = Math.max(prevCustomers, Math.round((spend * days) / avgCac));
    // Marginal CAC = incremental spend per incremental customer vs the previous cheaper bucket; null on the first.
    const dCustomers = customers - prevCustomers;
    const marginalCac = k === 1 ? null : (dCustomers > 0 ? round2(((spend - prevSpend) * days) / dCustomers) : null);
    points.push({ spend, days, customers, avgCac, marginalCac });
    prevSpend = spend; prevCustomers = customers;
  }
  return points;
}

function saturation(points, ceiling) {
  if (ceiling === null) return { saturationSpend: null, efficientSpend: null, saturationReason: null };
  const idx = points.findIndex((p) => p.marginalCac !== null && p.marginalCac > ceiling);
  if (idx < 0) return { saturationSpend: null, efficientSpend: null, saturationReason: null };
  return { saturationSpend: points[idx].spend, efficientSpend: points[idx - 1]?.spend ?? null, saturationReason: 'MARGINAL_CAC_ABOVE_CEILING' };
}

export function demo(snapshot) {
  const r = rng(55);
  const block = snapshot.ranges['30d'];
  const targets = [
    ...snapshot.adAccounts.map((a) => ({ id: a.id, name: a.name, level: 'ACCOUNT', category: null, daily: 1400 })),
    ...[...block.levels.adset].sort((a, b) => b.cost - a.cost).slice(0, 6)
      .map((a) => ({ id: a.id, name: a.name, level: 'SOURCE_LINK', category: a._category, daily: a.cost / 30 })),
  ];
  const curves = targets.map((t) => {
    const account = t.level === 'ACCOUNT';
    const ceiling = account ? null : round2(jitter(r, 120, 0.15));
    const base = jitter(r, 55, 0.2);
    const steep = 0.35 + r() * 0.9;
    const days = 8 + Math.floor(r() * 4);
    const points = curvePoints(t.daily, base, steep, days);
    const sat = saturation(points, ceiling);
    return {
      id: t.id, name: t.name, level: t.level, category: t.category,
      attributionModel: 'FIRST_CLICK', daysSampled: POINTS * days,
      ceiling, ceilingBasis: account ? null : 'LTV_BREAKEVEN', ltvWindow: account ? null : LTV_WINDOW,
      ...sat, points, notes: [],
    };
  });
  const today = ymd(new Date());
  return { checkedAt: `${today}T08:00:00.000Z`, window: { start: ymd(daysAgo(89)), end: today }, configuredCeiling: null, curves, notes: [] };
}

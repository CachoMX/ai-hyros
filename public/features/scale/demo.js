/** Demo block for Scale Advisor: curves shaped like hyros_get_marginal_cac_curve output. */
import { rng, jitter, round2, ymd, daysAgo } from '../../demo.js';

export function demo(snapshot) {
  const r = rng(55);
  const block = snapshot.ranges['30d'];
  const targets = [
    ...snapshot.adAccounts.map((a) => ({ id: a.id, name: a.name, level: 'ACCOUNT', category: null, daily: 1400 })),
    ...[...block.levels.adset].sort((a, b) => b.cost - a.cost).slice(0, 6)
      .map((a) => ({ id: a.id, name: a.name, level: 'SOURCE_LINK', category: a._category, daily: a.cost / 30 })),
  ];
  const curves = targets.map((t, i) => {
    const ceiling = round2(jitter(r, 120, 0.15));
    const base = jitter(r, 55, 0.2);
    const steep = 0.35 + r() * 0.9;
    const points = [];
    let saturationSpend = null;
    for (let k = 1; k <= 8; k += 1) {
      const spend = Math.round(t.daily * (0.4 + k * 0.25));
      const ratio = spend / (t.daily || 1);
      const marginal = round2(base * (1 + steep * (ratio - 0.65) * (ratio - 0.65)));
      const avg = round2(base * (1 + steep * 0.35 * (ratio - 0.65) * (ratio - 0.65)));
      points.push({ spend, avgCac: avg, marginalCac: marginal, customers: Math.round(spend / avg) });
      if (saturationSpend === null && marginal > ceiling) saturationSpend = spend;
    }
    if (i % 3 === 1) saturationSpend = null; // a couple of prospecting sets keep scaling
    return {
      id: t.id, name: t.name, level: t.level, category: t.category,
      attributionModel: 'FIRST_CLICK', daysSampled: 60 + Math.floor(r() * 30),
      ceiling, ceilingBasis: t.level === 'ACCOUNT' ? 'CALLER_PROVIDED' : 'REALIZED_LTV_90_DAYS',
      saturationSpend, points, notes: [],
    };
  });
  return { window: { start: ymd(daysAgo(89)), end: ymd(new Date()) }, curves };
}

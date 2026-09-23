import { rng } from '../../demo.js';

const DAY_MS = 86400000;

export function demo(snapshot) {
  const random = rng([... 'attribution'].reduce((seed, character) => seed + character.charCodeAt(0), 0));
  const range = snapshot.ranges?.['30d'] || {};
  const start = range.start || '2026-01-01';
  const end = range.end || start;
  const endAt = Date.parse(`${end.slice(0, 10)}T18:00:00Z`);
  const currency = snapshot.account?.currency || null;
  const ads = (range.levels?.ad || []).slice(0, 10);
  const conversions = [];
  const touch = (ad, at, organic = false) => ({
    id: organic ? 'demo-organic' : ad?.parentId || ad?.id || 'demo-source',
    name: organic ? 'Organic search' : ad?.parentName || ad?.name || 'Demo source',
    date: new Date(at).toISOString(), platform: organic ? 'organic' : 'demo',
    organic, disregarded: false, adId: organic ? null : ad?.id || null, adName: organic ? null : ad?.name || null,
  });
  ads.forEach((ad, index) => {
    const count = Math.min(8, Math.max(1, Math.floor(ad.sales || 1)));
    const amount = ad.sales > 0 && Number.isFinite(ad.revenue) ? Math.round(ad.revenue / ad.sales * 100) / 100 : null;
    for (let sale = 0; sale < count; sale += 1) {
      const at = endAt - Math.floor(random() * 25) * DAY_MS;
      const path = sale === 0 && index % 3 === 0 ? [] : [
        touch(ad, at - (3 + Math.floor(random() * 18)) * DAY_MS),
        touch(ad, at - 2 * DAY_MS, true),
        touch(ads[(index + 1) % ads.length], at - 0.25 * DAY_MS),
      ];
      conversions.push({ id: `demo-sale-${index}-${sale}`, leadId: `demo-lead-${index}-${Math.floor(sale / 2)}`,
        kind: 'SALE', date: new Date(at).toISOString(), amount, currency, firstSale: sale % 2 === 0, path });
    }
    const at = endAt - (index + 1) * DAY_MS;
    conversions.push({ id: `demo-call-${index}`, leadId: `demo-lead-${index}-0`, kind: 'CALL',
      date: new Date(at).toISOString(), amount: null, currency, firstSale: true,
      path: [touch(ad, at - 3 * DAY_MS), touch(ad, at - DAY_MS, true)] });
  });
  return {
    checkedAt: snapshot.generatedAt || new Date(endAt).toISOString(), window: { start, end }, conversions,
    coverage: { sampled: conversions.length, withPaths: conversions.filter((conversion) => conversion.path.length).length, complete: false, truncated: true },
    errors: ['Illustrative cohort: seeded paths and repeat flags; SALE amounts use selected demo ads\' average order values. Counts and source credits do not reconcile to the full core report.'],
  };
}

/**
 * Demo block for Ad LTV: top 5 ads by credited revenue followed over a
 * 2-month window — LTV growth, assisting sources, closed calls per source.
 */
import { rng, jitter, round2, ymd, daysAgo } from '../../demo.js';

const ASSIST_SOURCES = [
  { name: 'Email — Klaviyo flows',   kind: 'email' },
  { name: 'Google Organic',          kind: 'organic' },
  { name: 'Retargeting — 7 Day',     kind: 'ads' },
  { name: 'Search — Brand',          kind: 'ads' },
  { name: 'Instagram Organic',       kind: 'organic' },
  { name: 'YouTube — Remarketing',   kind: 'ads' },
  { name: 'Affiliate — newsletters', kind: 'organic' },
];

export function demo(snapshot) {
  const block = snapshot.ranges['30d'];
  const catOfAdset = new Map(block.levels.adset.map((s) => [s.name, s._category]));
  // Top 5 by credited revenue, one row per distinct creative (the same ad
  // name can run in several ad sets — keep its best-earning instance).
  const seen = new Set();
  const topAds = [];
  for (const ad of [...block.levels.ad].sort((a, b) => (b.revenue || 0) - (a.revenue || 0))) {
    if (seen.has(ad.name)) continue;
    seen.add(ad.name);
    topAds.push(ad);
    if (topAds.length === 5) break;
  }

  const r = rng(77);
  const rows = topAds.map((ad, i) => {
    const campaign = catOfAdset.get(ad.parentName) || null;
    const customers = Math.max(8, Math.round((ad.uniqueCustomers || ad.sales || 12) * 2 * jitter(r, 1, 0.08)));
    const aov = ad.sales ? (ad.revenue || 0) / ad.sales : 145;
    const m30 = jitter(r, 1.34, 0.1);
    const m60 = m30 * jitter(r, 1.24, 0.07);
    const ltv0 = round2(aov);
    const ltv30 = round2(aov * m30);
    const ltv60 = round2(aov * m60);

    const pool = ASSIST_SOURCES.filter((s) => s.name !== campaign);
    const nSrc = 3 + Math.floor(r() * 2);
    const chosen = [];
    for (let k = 0; chosen.length < nSrc && k < pool.length; k += 1) {
      const cand = pool[(i * 2 + k) % pool.length];
      if (!chosen.includes(cand)) chosen.push(cand);
    }
    let share = 0.58 * jitter(r, 1, 0.12);
    const assists = chosen.map((s) => {
      const pct = Math.max(0.07, share);
      share *= 0.58 * jitter(r, 1, 0.15);
      const touched = Math.round(customers * pct);
      const callRate = s.kind === 'email' ? 0.17 : s.kind === 'ads' ? 0.12 : 0.08;
      const closedCalls = Math.max(1, Math.round(touched * callRate * jitter(r, 1, 0.25)));
      return { name: s.name, kind: s.kind, pct, touched, closedCalls };
    }).sort((a, b) => b.pct - a.pct);

    return {
      rank: i + 1,
      name: ad.name, adset: ad.parentName, campaign,
      customers,
      revenue60: round2((ad.revenue || 0) * 2 * jitter(r, m60 / 1.3, 0.05)),
      ltv0, ltv30, ltv60, mult: ltv0 ? ltv60 / ltv0 : null,
      assists,
    };
  });

  const bySource = new Map();
  for (const row of rows) {
    for (const a of row.assists) {
      const cur = bySource.get(a.name) || { name: a.name, kind: a.kind, closedCalls: 0, touched: 0 };
      cur.closedCalls += a.closedCalls;
      cur.touched += a.touched;
      bySource.set(a.name, cur);
    }
  }
  const callLeaders = [...bySource.values()].sort((a, b) => b.closedCalls - a.closedCalls);

  return { window: { start: ymd(daysAgo(59)), end: ymd(new Date()) }, rows, callLeaders };
}

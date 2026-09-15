/**
 * Verifies the metric engine against REAL numbers read off a live HYROS
 * Performance Report screen (2026-08-13..19, Traffic source
 * level, Last Click). If HYROS changes a definition, these fail loudly.
 */
import { readFile } from 'node:fs/promises';
import { CATALOG, ADDITIVE, DEFAULT_KEYS, derive, aggregate, rollup } from '../public/shared/metrics.js';

let failures = 0;
const approx = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;

function check(name, actual, expected, tol) {
  const ok = typeof expected === 'number' ? approx(actual, expected, tol) : actual === expected;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (got ${actual}, want ${expected})`}`);
  if (!ok) failures += 1;
}

console.log('\nHYROS UI parity — Total row (from the real report screen)');
{
  const total = derive({
    cost: 4129.58, revenue: 560291.77, reported: 900.00,
    clicks: 3054, impressions: 0, sales: 732, leads: 0, calls: 0,
  });
  check('Profit             = 556,162.19', total.profit, 556162.19);
  check('Reported Vs Rev    = 559,391.77', total.reportedVsRevenue, 559391.77);
  check('ROI                = 13,467.77%', total.roi, 13467.77, 0.02);
  check('ROAS               = 135.68', total.roas, 135.68, 0.005);
}

console.log('\nHYROS UI parity — "meta" row (zero attributed revenue)');
{
  const meta = derive({ cost: 4129.58, revenue: 0, reported: 0, clicks: 2378, impressions: 0 });
  check('Profit             = -4,129.58', meta.profit, -4129.58);
  check('ROI                = -100.00%', meta.roi, -100);
  check('ROAS               = 0', meta.roas, 0);
}

console.log('\nDivide-by-zero safety');
{
  const zero = derive({ cost: 0, revenue: 0, impressions: 0, clicks: 0, leads: 0, sales: 0 });
  check('ROAS null when cost 0', zero.roas, null);
  check('ROI  null when cost 0', zero.roi, null);
  check('CTR  null when imps 0', zero.ctr, null);
  check('CPL  null when leads 0', zero.cpl, null);
  check('Profit still computes', zero.profit, 0);
}

console.log('\nRollup: derived metrics are RE-derived, never averaged');
{
  const children = [
    derive({ cost: 100, revenue: 300, impressions: 1000, clicks: 10 }),
    derive({ cost: 300, revenue: 300, impressions: 1000, clicks: 90 }),
  ];
  const parent = aggregate(children);
  check('cost sums            = 400', parent.cost, 400);
  check('revenue sums         = 600', parent.revenue, 600);
  // Averaging the children's ROAS (3.0, 1.0) would give 2.0 — the wrong answer.
  check('ROAS re-derived      = 1.5', parent.roas, 1.5);
  check('CTR  re-derived      = 5.00%', parent.ctr, 5);
}

console.log('\nSeed snapshot integrity (synthetic, generated from public/demo.js)');
{
  const seed = JSON.parse(await readFile(new URL('../data/seed.json', import.meta.url), 'utf8'));
  const block = seed.ranges['7d'];
  const { adset, ad, campaign, traffic, account } = block.levels;

  check('schema 2', seed.schema, 2);
  check('adset rows present', adset.length > 0, true);
  check('ad rows present', ad.length > 0, true);
  check('campaign rows present', campaign.length > 0, true);
  check('two traffic sources', traffic.length, 2);
  check('two ad accounts', account.length, 2);
  check('ads carry parentId', ad.every((r) => r.parentId), true);

  const adsetCost = adset.reduce((s, r) => s + r.cost, 0);
  const campCost = campaign.reduce((s, r) => s + r.cost, 0);
  const trafficCost = traffic.reduce((s, r) => s + r.cost, 0);
  check('campaign rollup preserves total cost', campCost, adsetCost, 0.05);
  check('traffic rollup preserves total cost', trafficCost, adsetCost, 0.05);
  check('7d total cost = adset cost', block.totals.cost, adsetCost, 0.05);

  // Every ad-set must resolve to a real source category, or Campaign is wrong.
  const uncategorised = campaign.find((c) => c.id === 'Uncategorised');
  check('no uncategorised ad sets', uncategorised === undefined, true);

  const attributed = seed.crm.leads.filter((l) => l.hasAttribution).length;
  check('leads carry click attribution', attributed > 0, true);
  check('income joined from sales', seed.crm.totals.income > 0, true);

  // No real customer data may ever be baked in.
  const text = JSON.stringify(seed);
  check('seed carries no real-account markers', /camel@hyros|locafy|viralstocks/.test(text), false);
}

console.log('\nColumn catalog');
{
  const keys = CATALOG.map((c) => c.k);
  check('no duplicate keys', new Set(keys).size, keys.length);
  const fields = CATALOG.map((c) => c.f);
  check('no duplicate API fields', new Set(fields).size, fields.length);
  check('every default key exists in catalog', DEFAULT_KEYS.every((k) => keys.includes(k)), true);
  check('additive list matches catalog flags', ADDITIVE.length, CATALOG.filter((c) => c.a === 's').length);

  // Rollups: derived metrics compute, non-aggregatable stay absent
  const children = [
    derive({ cost: 100, revenue: 500, sales: 2, clicks: 40, newVisits: 10 }),
    derive({ cost: 100, revenue: 100, sales: 2, clicks: 10, newVisits: 10 }),
  ];
  const parent = aggregate(children);
  check('AOV re-derived at rollup   = 150', parent.averageOrderValue, 150);
  check('CVR re-derived at rollup   = 8%', parent.cvr, 8);
  check('Cost/New Visit re-derived  = 10', parent.costPerNewVisit, 10);
  check('LTV absent at rollup (non-agg)', parent.ltv90Days === undefined, true);
  check('native value survives derive', derive({ cost: 10, leads: 2, costPerLead: 99 }).costPerLead, 99);
}

console.log('\nDemo drills (client-side, public/demo.js)');
{
  const { demoCohort, demoRecords, demoJourney } = await import('../public/demo.js');
  const cohort = demoCohort({ id: 'adset-1', name: 'Broad — Prospecting', tag: '@broad' });
  check('demo cohort has leads', cohort.leads.length >= 8, true);
  const sales = demoRecords({ id: 'adset-1', name: 'Broad — Prospecting' }, 'sales');
  check('demo sales records carry amounts', sales.records.every((r) => r.amount > 0), true);
  const j = demoJourney('someone@example.test');
  check('demo journey has a sale', j.journey.sales[0].amount > 0, true);
}

console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nAll checks passed.\n');
process.exit(failures ? 1 : 0);

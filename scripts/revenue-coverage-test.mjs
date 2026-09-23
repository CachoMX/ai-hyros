import assert from 'node:assert/strict';
import { reportRevenue, derive, aggregate, rollup } from '../public/shared/metrics.js';
import { normalizeRow } from '../api/_snapshot.js';

let passed = 0;
function test(name, run) { run(); passed++; console.log(`PASS ${name}`); }
function unknownEconomics(row) {
  for (const key of ['totalRevenue', 'profit', 'roas', 'roi']) assert.equal(row[key], null, key);
}

test('missing, invalid, and recurring-only revenue remain unknown', () => {
  for (const row of [undefined, null, {}, { recurringRevenue: 30 }, { recurringRevenue: 0 },
    { totalRevenue: null, revenue: null }, { totalRevenue: NaN, revenue: Infinity },
    { totalRevenue: '100', revenue: '100' }, { totalRevenue: false, revenue: false }]) {
    assert.equal(reportRevenue(row), null);
  }
});

test('finite totals, including zero, take precedence without adding rebills twice', () => {
  assert.equal(reportRevenue({ totalRevenue: 0, revenue: 100, recurringRevenue: 30 }), 0);
  assert.equal(reportRevenue({ totalRevenue: 150, revenue: 100, recurringRevenue: 30 }), 150);
  assert.equal(reportRevenue({ totalRevenue: 150 }), 150);
  assert.equal(reportRevenue({ totalRevenue: -20, revenue: 100 }), -20);
});

test('known one-time revenue supports the legacy fallback without requiring rebills', () => {
  for (const recurringRevenue of [undefined, null, NaN, Infinity, '30']) {
    assert.equal(reportRevenue({ revenue: 100, recurringRevenue }), 100);
  }
  assert.equal(reportRevenue({ revenue: 0 }), 0);
  assert.equal(reportRevenue({ revenue: 0, recurringRevenue: 30 }), 30);
  assert.equal(reportRevenue({ totalRevenue: null, revenue: 100, recurringRevenue: 30 }), 130);
  assert.equal(reportRevenue({ totalRevenue: Infinity, revenue: 100 }), 100);
});

test('derived unknown revenue overrides misleading native profit and ratios', () => {
  for (const revenue of [undefined, null, NaN, Infinity, '100']) {
    const source = { cost: 100, revenue, sales: 10, recurringRevenue: 30, profit: 999, roas: 9, roi: 900 };
    const result = derive(source);
    unknownEconomics(result);
    assert.equal(result.reportedVsRevenue, null);
    assert.equal(result.averageOrderValue ?? null, null);
    assert.equal(source.profit, 999);
  }
  unknownEconomics(derive({ cost: 0 }));
});

test('explicit zero revenue retains valid loss and zero-spend behavior', () => {
  const zero = derive({ cost: 100, revenue: 0 });
  assert.equal(zero.totalRevenue, 0);
  assert.equal(zero.profit, -100);
  assert.equal(zero.roas, 0);
  assert.equal(zero.roi, -100);
  const noSpend = derive({ cost: 0, revenue: 40 });
  assert.equal(noSpend.profit, 40);
  assert.equal(noSpend.roas, null);
  assert.equal(noSpend.roi, null);
});

test('one unknown child makes aggregate revenue and economics unknown in either order', () => {
  const known = { totalRevenue: 100, revenue: 80, recurringRevenue: 20, cost: 10, sales: 2 };
  const unknown = { cost: 20, sales: 3, recurringRevenue: 5 };
  for (const rows of [[known, unknown], [unknown, known]]) {
    const result = aggregate(rows);
    unknownEconomics(result);
    assert.equal(result.revenue, null);
    assert.equal(result.cost, 30);
    assert.equal(result.sales, 5);
    assert.equal(result.reportedVsRevenue, null);
    assert.equal(result.averageOrderValue ?? null, null);
  }
});

test('all-known totals sum mixed native and legacy rows, independently of one-time coverage', () => {
  const result = aggregate([{ totalRevenue: 150, cost: 10 }, { revenue: 100, recurringRevenue: 30, cost: 10 }]);
  assert.equal(result.totalRevenue, 280);
  assert.equal(result.revenue, null);
  assert.equal(result.profit, 260);
  assert.equal(result.roas, 14);
  assert.equal(result.roi, 1300);
  assert.equal(result.reportedVsRevenue, null);
  const known = aggregate([{ revenue: 100, recurringRevenue: 30 }, { revenue: 50 }]);
  assert.equal(known.revenue, 150);
  assert.equal(known.totalRevenue, 180);
});

test('empty aggregates retain documented zero sums', () => {
  const result = aggregate([], { id: 'empty' });
  for (const key of ['revenue', 'totalRevenue', 'profit', 'cost', 'sales']) assert.equal(result[key], 0, key);
  assert.equal(result.roas, null);
  assert.equal(result.roi, null);
  assert.equal(result.id, 'empty');
});

test('unknown revenue survives serialization, re-derivation, and nested rollups', () => {
  const partial = aggregate([{ revenue: 80, cost: 10 }, { cost: 20 }]);
  const saved = JSON.parse(JSON.stringify(partial));
  unknownEconomics(derive(saved));
  unknownEconomics(aggregate([saved, { revenue: 50, cost: 10 }]));
  const groups = rollup([
    { group: 'partial', revenue: 80, cost: 10 }, { group: 'partial', cost: 20 },
    { group: 'complete', revenue: 50, cost: 10 },
  ], (row) => row.group, (id) => id);
  unknownEconomics(groups.find((row) => row.id === 'partial'));
  assert.equal(groups.find((row) => row.id === 'complete').totalRevenue, 50);
  unknownEconomics(aggregate(groups));
});

test('normalization preserves missing revenue without changing other core defaults', () => {
  for (const revenue of [undefined, null]) {
    const raw = { id: 12, cost: 100, sales: 10, revenue, totalRevenue: null, recurringRevenue: 30 };
    const result = normalizeRow(raw);
    unknownEconomics(result);
    assert.equal(result.revenue, undefined);
    assert.equal(result.id, '12');
    assert.equal(result.clicks, 0);
    assert.equal(result.reported, 0);
    assert.equal(raw.totalRevenue, null);
  }
});

test('normalized native totals and legacy revenue survive full aggregation', () => {
  const native = normalizeRow({ id: 'native', cost: 10, totalRevenue: 100 });
  const legacy = normalizeRow({ id: 'legacy', cost: 10, revenue: 50, recurringRevenue: 20 });
  assert.equal(native.revenue, undefined);
  assert.equal(native.totalRevenue, 100);
  assert.equal(legacy.totalRevenue, 70);
  const known = aggregate([native, legacy]);
  assert.equal(known.totalRevenue, 170);
  assert.equal(known.revenue, null);
  unknownEconomics(aggregate([native, legacy, normalizeRow({ id: 'unknown', cost: 10, sales: 3 })]));
  const zero = normalizeRow({ id: 'zero', cost: 10, revenue: 0, totalRevenue: 0, recurringRevenue: 20 });
  assert.equal(zero.totalRevenue, 0);
  assert.equal(zero.revenue, 0);
  assert.equal(zero.profit, -10);
});

console.log(`\n${passed} revenue coverage checks passed.`);

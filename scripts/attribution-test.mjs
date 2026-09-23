import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ATTRIBUTION_MODELS, computeAttribution, computeCallAttribution, getTouchCredits } from '../public/shared/attribution.js';
import { build, normalizeConversion } from '../public/features/attribution/server.js';
import { demo } from '../public/features/attribution/demo.js';
import { render, comparisonCsv } from '../public/features/attribution/view.js';
import { buildDemoSnapshot, rng } from '../public/demo.js';
import { validateManifest } from '../public/shared/features.js';

let passed = 0;
async function test(name, run) {
  await run();
  passed += 1;
  console.log(`PASS ${name}`);
}
const near = (actual, expected, epsilon = 1e-8) => assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);
const at = (day) => `2026-09-${String(day).padStart(2, '0')}T12:00:00Z`;
const touch = (id, day = 15, overrides = {}) => ({ id, name: id, date: at(day), organic: false, disregarded: false, ...overrides });
const sale = (id = 's1', path = [touch('A'), touch('B', 18), touch('C', 20)], overrides = {}) => ({ id, leadId: 'lead1', kind: 'SALE', date: at(20), amount: 100, currency: 'USD', firstSale: true, path, ...overrides });
const revenue = (result, source) => result.rows.find((row) => row.sourceId === source)?.revenue || 0;
const native = (id = 's1', overrides = {}) => ({ id, leadId: 'lead1', creationDate: at(20), price: { price: 100, currency: 'USD' }, firstSale: true,
  path: [{ sourceLinkId: 'A', name: 'Source A', clickDate: at(15), organic: false, disregarded: false,
    adSource: { platform: 'FACEBOOK', adSourceId: 'ad1' }, sourceLinkAd: { name: 'Product', adSourceId: 'ad1' } }], ...overrides });
const serverCtx = (overrides = {}) => ({ snapshot: { account: { currency: 'USD' }, ranges: { '30d': { start: '2026-09-01', end: '2026-09-23' } } },
  now: new Date('2026-09-23T12:00:00Z'), timeLeft: () => 60000, deadline: Date.now() + 60000, previous: null,
  callTool: async () => ({ result: [] }), ...overrides });

await test('manifest validates', async () => {
  const manifest = JSON.parse(await readFile(new URL('../public/features/attribution/feature.json', import.meta.url)));
  assert.deepEqual(validateManifest(manifest, 'attribution'), []);
});
await test('five models give expected ordered credit', () => {
  const input = [sale()];
  near(revenue(computeAttribution(input, { model: 'first' }), 'A'), 100);
  near(revenue(computeAttribution(input, { model: 'last' }), 'C'), 100);
  near(revenue(computeAttribution(input, { model: 'linear' }), 'B'), 100 / 3);
  const position = computeAttribution(input, { model: 'position' });
  near(revenue(position, 'A'), 40); near(revenue(position, 'B'), 20); near(revenue(position, 'C'), 40);
  const decay = computeAttribution([sale('decay', [touch('old', 13), touch('new', 20)])], { model: 'decay', halfLifeDays: 7 });
  near(revenue(decay, 'old'), 100 / 3); near(revenue(decay, 'new'), 200 / 3);
});
await test('chronology, future, disregarded and missing date filtering', () => {
  const input = sale('filters', [touch('future', 21), touch('late', 19), touch('ignored', 10, { disregarded: true }), touch('early', 11), touch('undated', 1, { date: null })]);
  near(revenue(computeAttribution([input]), 'early'), 100);
  assert.deepEqual(getTouchCredits(input).map((entry) => entry.reason), ['After conversion', null, 'Disregarded', null, 'Missing date']);
  near(computeAttribution([sale('unknown', input.path, { date: null })]).unattributedRevenue, 100);
});
await test('inclusive window boundary and offsets', () => {
  const input = sale('boundary', [touch('boundary', 13), touch('outside', 13, { date: '2026-09-13T11:59:59Z' }), touch('same-time', 20, { date: '2026-09-20T07:00:00-05:00' })]);
  const result = computeAttribution([input], { model: 'linear', windowDays: 7 });
  near(revenue(result, 'boundary'), 50); near(revenue(result, 'same-time'), 50); near(revenue(result, 'outside'), 0);
});
await test('empty and completely excluded paths stay unattributed', () => {
  for (const model of ATTRIBUTION_MODELS) {
    const result = computeAttribution([sale('empty', []), sale('excluded', [touch('organic', 19, { organic: true })])], { model, includeOrganic: false });
    near(result.totalRevenue, 200); near(result.unattributedRevenue, 200); assert.equal(result.rows.length, 0);
  }
});
await test('repeated touches combine but never multiply sale revenue', () => {
  const result = computeAttribution([sale('repeat', [touch('A', 15), touch('A', 16), touch('B', 17)])], { model: 'linear' });
  near(revenue(result, 'A'), 200 / 3); near(result.attributedRevenue, 100);
  assert.equal(result.rows.find((row) => row.sourceId === 'A').touches, 2);
  near(result.rows.reduce((sum, row) => sum + row.conversions, 0), 1);
});
await test('duplicate sale IDs dedupe; same-lead different purchases remain', () => {
  const result = computeAttribution([sale(), sale(), sale('s2')]);
  near(result.totalRevenue, 200); near(result.rows.reduce((sum, row) => sum + row.conversions, 0), 2);
});
await test('missing amounts are not coerced; zero and negative amounts conserve', () => {
  const input = [sale('null', undefined, { amount: null }), sale('string', undefined, { amount: '100' }), sale('zero', undefined, { amount: 0 }), sale('negative', undefined, { amount: -5 })];
  const result = computeAttribution(input, { model: 'linear' });
  near(result.totalRevenue, -5); near(result.attributedRevenue, -5);
  near(result.rows.reduce((sum, row) => sum + row.conversions, 0), 4);
});
await test('CALL counts are isolated from SALE revenue', () => {
  const input = [sale(), sale('call', undefined, { kind: 'CALL', amount: 99999 })];
  near(computeAttribution(input).totalRevenue, 100);
  const result = computeCallAttribution(input); near(result.totalRevenue, 0);
  near(result.rows.reduce((sum, row) => sum + row.conversions, 0), 1);
});
await test('position weights, two-touch fallback and single touch', () => {
  const options = { model: 'position', positionWeights: { first: 10, middle: 70, last: 20 } };
  near(revenue(computeAttribution([sale('one', [touch('A')])], options), 'A'), 100);
  near(revenue(computeAttribution([sale('two', [touch('A'), touch('B')])], options), 'A'), 100 / 3);
  near(revenue(computeAttribution([sale()], options), 'B'), 70);
  near(revenue(computeAttribution([sale()], { model: 'position', positionWeights: { first: 0, middle: 0, last: 0 } }), 'A'), 100 / 3);
  near(computeAttribution([sale()], { model: 'position', positionWeights: { first: 1e308, middle: 1e308, last: 1e308 } }).attributedRevenue, 100);
  near(revenue(computeAttribution([sale('two', [touch('A'), touch('B')])], { model: 'position', positionWeights: { first: 0, middle: 100, last: 0 } }), 'A'), 50);
});
await test('decay does not underflow when all touches are old', () => {
  const input = sale('old', [touch('A', 1, { date: '2000-01-01T00:00:00Z' }), touch('B', 1, { date: '2001-01-01T00:00:00Z' })]);
  const result = computeAttribution([input], { model: 'decay', halfLifeDays: 0.01 });
  near(result.attributedRevenue, 100); near(revenue(result, 'B'), 100);
});
await test('unknown organic and source identity remain explicit', () => {
  const input = sale('unknown', [touch('A', 18, { organic: null }), touch(null, 18, { name: null }), touch(null, 19, { name: 'Named only', platform: 'search' })]);
  near(computeAttribution([input], { includeOrganic: false }).attributedRevenue, 100);
  assert.equal(getTouchCredits(input, { includeOrganic: false })[0].reason, 'Organic status unknown');
  assert.equal(computeAttribution([input], { includeOrganic: false }).rows[0].sourceId, 'name:search:Named only');
});
await test('deterministic stress conserves credit and revenue without mutations', () => {
  const random = rng(751);
  const conversions = Array.from({ length: 300 }, (_, index) => sale(`stress-${index}`, Array.from({ length: Math.floor(random() * 9) }, () => touch(`source-${Math.floor(random() * 6)}`, 1 + Math.floor(random() * 23), { organic: random() > 0.8, disregarded: random() > 0.9 })), { amount: index % 13 === 0 ? null : (random() - 0.1) * 500 }));
  const before = JSON.stringify(conversions);
  for (const model of ATTRIBUTION_MODELS) for (const includeOrganic of [true, false]) for (const windowDays of [0, 7]) {
    const result = computeAttribution(conversions, { model, includeOrganic, windowDays });
    near(result.totalRevenue, result.attributedRevenue + result.unattributedRevenue, 1e-7);
    near(result.attributedRevenue, result.rows.reduce((sum, row) => sum + row.revenue, 0));
    const eligible = conversions.filter((conversion) => getTouchCredits(conversion, { model, includeOrganic, windowDays }).some((entry) => !entry.reason)).length;
    near(result.rows.reduce((sum, row) => sum + row.conversions, 0), eligible);
  }
  assert.equal(JSON.stringify(conversions), before);
});
await test('normalizer allowlists fields, preserves missing flags and account currency', () => {
  const result = normalizeConversion(native('s1', { email: 'private@example.com', lead: { email: 'private@example.com' }, firstSale: undefined }), 'SALE', 'USD');
  assert.equal(result.firstSale, null); assert.equal(result.path[0].id, 'A'); assert.equal(result.path[0].adId, 'ad1');
  assert.ok(!JSON.stringify(result).includes('email'));
  assert.equal(normalizeConversion(native('foreign', { price: { price: 80, currency: 'EUR' } }), 'SALE', 'USD').amount, null);
  assert.equal(normalizeConversion(native('converted', { price: { price: 80, currency: 'EUR' }, usdPrice: { price: 90, currency: 'USD' } }), 'SALE', 'USD').amount, 90);
  assert.equal(normalizeConversion(native(), 'SALE', null).amount, null);
  assert.equal(normalizeConversion(native('empty', { path: null, price: null }), 'CALL', 'USD').amount, null);
});
await test('server pages each type independently, dedupes and never exceeds contract', async () => {
  const calls = [];
  const result = await build(serverCtx({ callTool: async (name, args, options) => {
    calls.push({ name, args, options });
    const kind = args.request.conversionType;
    return args.request.pageId ? { result: [native(`${kind}-first`), native(`${kind}-second`)] }
      : { result: [native(`${kind}-first`)], nextPageId: `${kind}-next` };
  } }));
  assert.deepEqual(calls.map((call) => call.args.request.conversionType), ['SALE', 'CALL', 'SALE', 'CALL']);
  assert.equal(result.conversions.length, 4); assert.equal(result.coverage.complete, true);
  assert.ok(calls.every((call) => call.name === 'hyros_get_conversion_paths' && call.args.request.pageSize <= 250 && call.options.timeoutMs <= 15000));
  assert.equal(calls[2].args.request.pageId, 'SALE-next'); assert.equal(calls[3].args.request.pageId, 'CALL-next');
});
await test('spent and nearly spent budgets perform zero calls and preserve previous time', async () => {
  let calls = 0;
  for (const timeLeft of [0, 900]) {
    const result = await build(serverCtx({ timeLeft: () => timeLeft, previous: { checkedAt: at(1), conversions: [], stale: true, skipped: 'old' }, callTool: async () => { calls += 1; } }));
    assert.equal(result.stale, true); assert.equal(result.checkedAt, at(1)); assert.equal(result.skipped, 'time budget');
  }
  assert.equal(calls, 0);
  assert.deepEqual(await build(serverCtx({ timeLeft: () => 0 })), { skipped: 'time budget' });
});
await test('expired absolute deadline governs and per-call timeout leaves margin', async () => {
  let calls = 0;
  await build(serverCtx({ deadline: Date.now() - 1, callTool: async () => { calls += 1; } })); assert.equal(calls, 0);
  let remaining = 1200;
  const result = await build(serverCtx({ timeLeft: () => remaining, callTool: async (_name, _args, options) => {
    calls += 1; assert.ok(options.timeoutMs <= 950); remaining = 0; return { result: [native()] };
  } }));
  assert.equal(calls, 1); assert.equal(result.coverage.truncated, true); assert.equal(result.conversions.length, 1);
});
await test('page limits and repeated cursors are disclosed', async () => {
  let calls = 0;
  const result = await build(serverCtx({ callTool: async (_name, args) => { calls += 1; return { result: [native(`${args.request.conversionType}-${calls}`)], nextPageId: 'same' }; } }));
  assert.equal(calls, 4); assert.equal(result.coverage.complete, false); assert.equal(result.coverage.truncated, true);
  assert.ok(result.errors.some((error) => /cursor/.test(error)));
});
await test('rate limiting stops without retries and errors redact emails', async () => {
  let calls = 0;
  const result = await build(serverCtx({ callTool: async () => { calls += 1; throw Object.assign(new Error('Rate limited for private@example.com'), { code: 'rate_limited' }); } }));
  assert.equal(calls, 1); assert.ok(result.errors[0].includes('Try next refresh'));
  assert.ok(!JSON.stringify(result).includes('private@example.com')); assert.equal(result.coverage.complete, false);
});
await test('empty native result is complete; malformed result is not', async () => {
  const empty = await build(serverCtx()); assert.equal(empty.coverage.complete, true); assert.equal(empty.coverage.sampled, 0);
  const malformed = await build(serverCtx({ callTool: async () => ({}) })); assert.equal(malformed.coverage.complete, false); assert.equal(malformed.errors.length, 2);
});
await test('large Unicode paths keep whole conversions and block below 200 KB', async () => {
  const path = Array.from({ length: 60 }, (_, index) => ({ sourceLinkId: `source-${index}`, name: '\u4e2d'.repeat(160), clickDate: at(15) }));
  let calls = 0;
  const result = await build(serverCtx({ callTool: async (_name, args) => { calls += 1; return { result: Array.from({ length: 100 }, (_, index) => native(`${args.request.conversionType}-${index}`, { path })), nextPageId: 'more' }; } }));
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 200000);
  assert.ok(result.conversions.every((conversion) => conversion.path.length === 60));
  assert.ok(result.conversions.some((conversion) => conversion.kind === 'CALL'));
  assert.equal(calls, 2); assert.equal(result.coverage.truncated, true);
});
await test('missing conversion IDs and amounts are disclosed', async () => {
  const result = await build(serverCtx({ callTool: async () => ({ result: [native(null), native('unknown', { price: null })] }) }));
  assert.equal(result.conversions.length, 2); assert.equal(result.coverage.complete, false);
  assert.ok(result.errors.some((error) => /amounts unavailable/.test(error)));
});

const snapshot = buildDemoSnapshot();
const demoBlock = demo(snapshot);
await test('demo is deterministic, bounded and labels illustrative differences', () => {
  assert.deepEqual(demoBlock, demo(snapshot)); assert.ok(Buffer.byteLength(JSON.stringify(demoBlock)) < 200000);
  assert.ok(demoBlock.errors.some((error) => /Illustrative/.test(error)));
  assert.ok(demoBlock.conversions.some((conversion) => conversion.kind === 'CALL'));
});
const viewCtx = (block, root = { innerHTML: '', querySelectorAll: () => [], querySelector: () => null }) => ({ root, block, snapshot,
  range: '30d', demo: true, fmt: { money: (value) => `$${value.toFixed(2)}`, datetime: (value) => value }, esc: (value) => String(value ?? '').replaceAll('<', '&lt;').replaceAll('>', '&gt;') });
await test('all block states render with fake DOM and stale uses previous timestamp', () => {
  for (const block of [demoBlock, null, {}, { skipped: 'time budget' }, { error: 'Forbidden' }, { ...demoBlock, stale: true, skipped: 'time budget' }]) {
    const ctx = viewCtx(block); render(ctx); assert.ok(ctx.root.innerHTML.length > 30);
    if (block?.stale) { assert.match(ctx.root.innerHTML, /previous/i); assert.ok(ctx.root.innerHTML.includes(block.checkedAt)); }
  }
  const ctx = viewCtx(demoBlock, { innerHTML: '' }); render(ctx); assert.ok(ctx.root.innerHTML.includes('Source credit'));
});
await test('view escapes evidence labels and keeps native Scientific separate', () => {
  const ctx = viewCtx({ ...demoBlock, conversions: [sale('<img src=x>', [touch('<script>')])] });
  render(ctx); assert.ok(!ctx.root.innerHTML.includes('<script>')); assert.ok(ctx.root.innerHTML.includes('&lt;script&gt;'));
  assert.ok(!ctx.root.innerHTML.includes('value="scientific"')); assert.ok(ctx.root.innerHTML.includes('Native Scientific'));
});
await test('model, organic, call and pagination controls recalculate via guarded listeners', () => {
  const listeners = {};
  const root = { innerHTML: '', querySelectorAll: (selector) => [{ addEventListener: (event, handler) => { listeners[selector] = handler; } }] };
  render(viewCtx(demoBlock, root));
  listeners['[data-setting]']({ currentTarget: { dataset: { setting: 'modelA' }, value: 'position' } });
  assert.ok(root.innerHTML.includes('First weight'));
  listeners['[data-weight]']({ currentTarget: { dataset: { weight: 'first' }, value: '25' } });
  assert.ok(root.innerHTML.includes('value="25"'));
  listeners['[data-page]']({ currentTarget: { dataset: { page: '1' } } });
  assert.ok(root.innerHTML.includes('2 /'));
  listeners['[data-kind]']({ currentTarget: { dataset: { kind: 'CALL' } } });
  assert.ok(root.innerHTML.includes('Sampled calls')); assert.ok(!root.innerHTML.includes('Known SALE revenue'));
});
await test('unavailable amounts remain unknown and snapshot model labels win', () => {
  const ctx = viewCtx({ ...demoBlock, conversions: [sale('unknown', [], { amount: null })] });
  ctx.snapshot = { ...snapshot, attributionModel: 'CUSTOM HYROS', settings: { model: 'LAST_CLICK' } };
  render(ctx);
  assert.ok(ctx.root.innerHTML.includes('Current core model: CUSTOM HYROS'));
  assert.ok(ctx.root.innerHTML.includes('kpi-value">Unknown'));
  const empty = viewCtx({ ...demoBlock, conversions: [], errors: ['SALE: unavailable'] });
  render(empty); assert.ok(empty.root.innerHTML.includes('Cohort incomplete'));
});
await test('CSV includes settings and coverage, escapes formulas and preserves decimal revenue', () => {
  const a = computeAttribution([sale('csv', [touch('A', 15, { name: '=HYPERLINK("x")' })])]);
  const rows = a.rows.map((row) => ({ sourceId: row.sourceId, name: row.name, a: row, b: row }));
  const csv = comparisonCsv({ rows, a, b: a, currency: 'USD', coverage: demoBlock.coverage, window: demoBlock.window,
    state: { kind: 'SALE', modelA: 'first', modelB: 'last', cohortSize: 1, halfLifeDays: 7, windowDays: 0, includeOrganic: true, positionWeights: { first: 40, middle: 20, last: 40 } } });
  assert.ok(csv.includes("'=HYPERLINK")); assert.ok(csv.includes('"half_life_days"')); assert.ok(csv.includes('"truncated"'));
  assert.ok(csv.includes('"Unattributed"')); assert.ok(csv.includes('"100"'));
  const negative = comparisonCsv({ rows: [{ ...rows[0], a: { ...rows[0].a, revenue: -5 } }], a, b: a,
    currency: 'USD', coverage: demoBlock.coverage, window: demoBlock.window,
    state: { kind: 'SALE', modelA: 'first', modelB: 'last', cohortSize: 1, positionWeights: { first: 40, middle: 20, last: 40 } } });
  assert.ok(negative.includes('"-5"'));
  const unknown = comparisonCsv({ rows: [], a: computeAttribution([]), b: computeAttribution([]),
    currency: 'USD', coverage: demoBlock.coverage, window: demoBlock.window,
    state: { kind: 'SALE', modelA: 'first', modelB: 'last', cohortSize: 0, cohortAvailable: false, revenueAvailable: false, unknownAmounts: 0,
      positionWeights: { first: 40, middle: 20, last: 40 } } });
  assert.ok(unknown.includes('"last","","","","",""'));
});

console.log(`\n${passed} attribution tests passed.`);

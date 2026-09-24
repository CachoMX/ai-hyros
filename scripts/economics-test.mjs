import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { computeProfit, computeProfitRows, loadProfitSettings, saveProfitSettings, revenueOf, captureEconomicsSnapshot, windowDays } from '../public/shared/profit.js';
import { groupCreatives, parseAdName, comparablePeriods, compareGroup, saveCreativeSettings, loadCreativeSettings, normalizeCreativeSettings, detectNaming, resolveNaming, activeSlots } from '../public/features/creative/analysis.js';
import { creativeBlock } from '../public/features/creative/server.js';
import { csvText } from '../public/features/profit/ui.js';
import { buildDemoSnapshot } from '../public/demo.js';
import { validateManifest } from '../public/shared/features.js';
import { fmt } from '../public/shared/metrics.js';

let passed = 0;
async function test(name, run) { await run(); passed++; console.log(`PASS ${name}`); }
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
const row = { id: 'ad-1', cost: 100, revenue: 150, totalRevenue: 200, recurringRevenue: 50, refund: 0 };
const settings = { defaultMarginPct: 60, refundTreatment: 'included', dailyOverhead: 0 };

await test('unknown margins stay unknown; explicit zero margin is meaningful', () => {
  const result = computeProfit(row, {});
  assert.equal(result.configured, false);
  for (const key of ['contribution', 'netProfit', 'breakEvenRoas']) assert.equal(result[key], null);
  assert.equal(result.revenue, 200);
  const zero = computeProfit(row, { ...settings, defaultMarginPct: 0 });
  assert.equal(zero.configured, true);
  assert.equal(zero.contribution, 0);
  assert.equal(zero.netProfit, -100);
});
await test('rebills enter total revenue once and fallback coverage is explicit', () => {
  near(computeProfit(row, settings).netProfit, 20);
  assert.equal(revenueOf({ ...row, totalRevenue: 0 }).revenue, 0);
  assert.equal(revenueOf({ revenue: 150, recurringRevenue: 50 }).revenue, 200);
  assert.equal(revenueOf({ revenue: null, recurringRevenue: 50 }).revenue, null);
  assert.match(revenueOf({ revenue: 150 }).issues.join(' '), /rebill coverage unknown/);
});
await test('missing revenue, spend, or unconfirmed refunds cannot manufacture profit', () => {
  for (const value of [{ cost: 50, refund: 0 }, { totalRevenue: 100, cost: null, refund: 0 }, null]) assert.equal(computeProfit(value, settings).netProfit, null);
  for (const refund of [null, 20]) assert.equal(computeProfit({ ...row, refund }, { defaultMarginPct: 60 }).contribution, null);
  assert.equal(computeProfit({ ...row, refund: null }, { ...settings, refundTreatment: 'subtract' }).contribution, null);
});
await test('refunds are deducted once using an explicit revenue treatment', () => {
  for (const refund of [20, -20]) near(computeProfit({ ...row, refund }, { ...settings, refundTreatment: 'subtract' }).contribution, 100);
  near(computeProfit({ ...row, totalRevenue: 180, refund: 20 }, settings).contribution, 108);
  near(computeProfit({ ...row, hardCosts: 80, costOfGoods: 80, profit: -900 }, settings).netProfit, 20);
});
await test('native costs replace margin costs and cannot double-count refunds', () => {
  const native = { ...settings, costBasis: 'native', refundTreatment: 'subtract', nativeCostsIncludeRefunds: true };
  near(computeProfit({ ...row, hardCosts: 80, refund: 20 }, native).netProfit, 20);
  near(computeProfit({ ...row, hardCosts: 60, refund: 20 }, { ...native, nativeCostsIncludeRefunds: false }).netProfit, 20);
  assert.equal(computeProfit({ ...row, hardCosts: 80, refund: 20 }, { ...native, nativeCostsIncludeRefunds: null }).netProfit, null);
  assert.equal(computeProfit({ ...row, hardCosts: 80, refund: 20 }, { ...native, refundTreatment: 'included' }).netProfit, null);
  assert.equal(computeProfit(row, native).netProfit, null);
});
await test('zero spend has no ROAS; break-even includes overhead and refunds', () => {
  const zero = computeProfit({ ...row, cost: 0 }, settings);
  near(zero.netProfit, 120);
  assert.equal(zero.roas, null);
  assert.equal(zero.breakEvenRoas, null);
  const result = computeProfit({ ...row, refund: 20 }, { ...settings, refundTreatment: 'subtract', overhead: 20 });
  near(result.breakEvenRoas, 2.4);
  near(result.netProfit, -20);
});
await test('product margins precede offer margins; absent IDs cannot match', () => {
  const mapped = { ...settings, productMargins: { p: 80 }, offerMargins: { o: 70 } };
  near(computeProfit({ ...row, productId: 'p', offerId: 'o' }, mapped).contribution, 160);
  near(computeProfit({ ...row, offerId: 'o' }, mapped).contribution, 140);
  near(computeProfit(row, mapped).contribution, 120);
  for (const defaultMarginPct of [null, '', 101]) assert.equal(computeProfit({ ...row, productId: 'missing' }, { ...mapped, defaultMarginPct }).contribution, null);
});
await test('overhead is allocated once before filtering; unknown windows stay unknown', () => {
  const config = { ...settings, dailyOverhead: 10 }, window = { start: '2026-09-01', end: '2026-09-02' };
  const result = computeProfitRows([row, { ...row, id: 'ad-2', cost: 300 }], config, window);
  near(result[0].overhead, 5); near(result[1].overhead, 15);
  near(result.reduce((sum, item) => sum + item.netProfit, 0), -180);
  assert.equal(computeProfit(row, config).netProfit, null);
  assert.equal(computeProfitRows([row], config, null)[0].netProfit, null);
  assert.equal(computeProfitRows([row, { ...row, cost: null }], config, window)[0].netProfit, null);
  assert.equal(windowDays({ start: '2026-02-30', end: '2026-03-03' }), null);
});
await test('blocked local storage preserves isolated session settings without a DOM', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('blocked'); } });
  try {
    assert.equal(saveProfitSettings('test-a', settings).persisted, false);
    assert.equal(loadProfitSettings('test-a').defaultMarginPct, 60);
    assert.equal(loadProfitSettings('test-b').defaultMarginPct, null);
    assert.equal(saveCreativeSettings('test-a', { configured: true, separator: '|' }).persisted, false);
    assert.equal(loadCreativeSettings('test-a').separator, '|');
    assert.equal(loadCreativeSettings('test-b').configured, false);
  } finally { if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor); else delete globalThis.localStorage; }
});

const SLOTS_ALL = ['concept', 'angle', 'hook', 'format', 'variation'];
const creativeSettings = { configured: true, separator: '|', slots: SLOTS_ALL };
const ads = [80, 10, 10].map((revenue, i) => ({ id: `a${i}`, name: `Concept|Angle|Hook|Video|v${i}`, totalRevenue: revenue, cost: i === 0 ? 80 : 10, sales: 1, _account: 'a', _traffic: 'facebook' }));
await test('name parsing preserves blank slots, empty delimiters, and trailing segments', () => {
  assert.deepEqual(parseAdName(' Concept | | Hook | Video | v1|extra ', creativeSettings.slots, '|'), { concept: 'Concept', angle: null, hook: 'Hook', format: 'Video', variation: 'v1|extra' });
  assert.equal(parseAdName('Whole name', creativeSettings.slots, '').concept, 'Whole name');
  assert.equal(parseAdName('').variation, null);
});
await test('several delimiters split names together; overflow joins into the last active slot', () => {
  const slots = ['variation', 'concept', 'angle', 'ignore', 'ignore'];
  assert.deepEqual(parseAdName('Ad 2 - Zoe 2 | Your Insurance Company Will Hate Me For This', slots, [' | ', ' - ']),
    { concept: 'Zoe 2', angle: 'Your Insurance Company Will Hate Me For This', hook: null, format: null, variation: 'Ad 2' });
  assert.deepEqual(parseAdName('Ad 6 - Car Wallpaper', slots, [' | ', ' - ']).angle, null);
  assert.equal(parseAdName('a - b | c - d | e', slots, [' | ', ' - ']).angle, 'c - d | e');
  assert.equal(parseAdName('Before-After_Transformation_30-days_Static_v3', undefined, '_').concept, 'Before-After');
  const settings = normalizeCreativeSettings({ separators: [' - ', '', ' - ', ' | ', '_', '#'], separator: 'ignored' });
  assert.deepEqual(settings.separators, [' - ', ' | ', '_']); assert.equal(settings.separator, ' - '); assert.equal(settings.detect, true);
  assert.deepEqual(normalizeCreativeSettings({ separator: '|' }).separators, ['|']);
  assert.deepEqual(normalizeCreativeSettings({ separators: [] }).separators, []);
  assert.equal(parseAdName('Whole|name', SLOTS_ALL, []).concept, 'Whole|name');
});
const triggerfishLike = ['Ad 2 - Zoe 2 | Your Insurance Company Will Hate Me For This', 'Ad 4 - Zoe 4 | Phone Call 2', 'Ad 6 - Car Wallpaper',
  'Ad 1 - Zoe 1 | Explain This To Me', 'Ad 3 - Zoe 3 | Phone Call', 'Ad 7 - PayPal', 'Ad 9 - Shocked Guy', 'Ad 8 - Car Graphic 1',
  "Ad 5 - Zoe 5 | I Can't Believe This Worked", 'Ad 11 - Text Blurred Dark', 'Ad 10 - Text Blurred', 'Ad 746854695745', 'Ad 746854667668', "Ad 5 - Zoe 5 | I Can't Believe This Worked"].map((name, i) => ({ id: `t${i}`, name }));
await test('naming detection proposes the delimiters and slots the account actually uses', () => {
  const detected = detectNaming(triggerfishLike);
  assert.deepEqual(detected.separators, [' | ', ' - ']);
  assert.deepEqual(detected.slots, ['variation', 'concept', 'angle', 'ignore', 'ignore']);
  assert.equal(detected.named, 11); assert.equal(detected.unnamed, 2); assert.equal(detected.total, 13);
  assert.equal(detected.coverage, 1); assert.equal(detected.confident, true);
  const underscore = detectNaming(['UGC_Skeptic_I-was-skeptical_Video-30s_v1', 'Bundle_Value_Save-20_Static_v1', 'Press_Authority_As-seen-in_Static_v1', 'Founder_Origin_Why_Video_v2'].map((name) => ({ name })));
  assert.deepEqual(underscore.separators, ['_']); assert.deepEqual(underscore.slots, ['concept', 'angle', 'hook', 'format', 'variation']); assert.equal(underscore.confident, true);
  const loose = detectNaming(['Founder Story 45s', 'Static — Bundle Offer', 'UGC Hook — "I was skeptical"', 'Testimonial Mashup'].map((name) => ({ name })));
  assert.equal(loose.confident, false); assert.equal(loose.coverage, 0.5);
  assert.equal(detectNaming([{ name: 'A_B' }, { name: 'C_D' }]).confident, false);
  assert.equal(detectNaming([]).named, 0); assert.equal(detectNaming(null).confident, false);
});
await test('resolved naming: saved wins, confident detection is labelled, and turning detection off keeps the fallback', () => {
  const detected = resolveNaming({}, triggerfishLike);
  assert.equal(detected.source, 'detected'); assert.equal(detected.settings.configured, true);
  assert.deepEqual(activeSlots(detected.settings), ['concept', 'angle', 'variation']);
  assert.equal(groupCreatives(triggerfishLike, detected.settings, 'concept').find((group) => group.name === 'Zoe 5').variants.length, 2);
  assert.equal(groupCreatives(triggerfishLike, detected.settings, 'concept').find((group) => group.name === 'Unclassified').variants.length, 2);
  assert.equal(resolveNaming({ detect: false }, triggerfishLike).source, 'none');
  const saved = resolveNaming({ configured: true, separator: '|' }, triggerfishLike);
  assert.equal(saved.source, 'saved'); assert.deepEqual(saved.settings.separators, ['|']);
  assert.equal(resolveNaming({}, [{ name: 'Founder Story 45s' }, { name: 'Static Offer' }, { name: 'Plain' }]).source, 'none');
});
await test('concentration measures revenue share, with weighted ROAS and thresholds', () => {
  const group = groupCreatives(ads, creativeSettings)[0];
  near(group.topShare, 0.8); near(group.roas, 1);
  assert.equal(group.concentrated, true);
  for (const override of [{ minSales: 4 }, { minSpend: 101 }, { minVariants: 4 }, { concentrationPct: 80 }, { coverageComplete: false }]) assert.equal(groupCreatives(ads, { ...creativeSettings, ...override })[0].concentrated, false);
});
await test('unknown, zero, or negative revenue has no fabricated concentration', () => {
  for (const amount of [null, 0, -1]) {
    const group = groupCreatives(ads.map((ad) => ({ ...ad, totalRevenue: amount })), creativeSettings)[0];
    assert.equal(group.topShare, null); assert.equal(group.concentrated, false);
  }
  assert.equal(groupCreatives(ads.map((ad) => ({ ...ad, cost: 0 })), creativeSettings)[0].roas, null);
});
await test('same names remain separate across accounts and fallback parents', () => {
  assert.equal(groupCreatives([...ads, ...ads.map((ad) => ({ ...ad, _account: 'b' }))], creativeSettings).length, 2);
  assert.equal(groupCreatives([{ ...ads[0], parentId: 'p1', parentName: 'Shared' }, { ...ads[1], parentId: 'p2', parentName: 'Shared' }]).length, 2);
});
const period = { start: '2026-09-08', end: '2026-09-14', complete: true, model: 'LAST_CLICK', currency: 'USD', context: 'same-settings' };
const priorPeriod = { ...period, start: '2026-09-01', end: '2026-09-07' };
await test('trends require adjacent equal-length closed periods and matching context', () => {
  assert.equal(comparablePeriods(period, priorPeriod, '2026-09-15T12:00:00Z'), true);
  for (const bad of [{ ...period, complete: false }, { ...period, model: 'FIRST_CLICK' }, { ...period, currency: 'EUR' }, { ...period, start: '2026-09-07' }, { ...period, context: null }, { ...period, context: 'different-window' }]) assert.equal(comparablePeriods(bad, priorPeriod, '2026-09-15'), false);
  assert.equal(comparablePeriods(period, priorPeriod, '2026-09-14'), false);
});
await test('ROAS trends reject changed ad mixes and zero comparison economics', () => {
  const current = groupCreatives(ads, creativeSettings)[0];
  const previous = groupCreatives(ads.map((ad) => ({ ...ad, cost: ad.cost * 2 })), creativeSettings)[0];
  near(compareGroup(current, previous).delta, 100);
  assert.equal(compareGroup(current, groupCreatives(ads.slice(0, 2), creativeSettings)[0]).delta, null);
  assert.equal(compareGroup(current, groupCreatives(ads.map((ad) => ({ ...ad, totalRevenue: 0 })), creativeSettings)[0]).delta, null);
});
await test('bounded snapshots retain nulls and disclose incomplete coverage', () => {
  const source = { ranges: { '30d': { start: '2026-08-16', end: '2026-09-14', levels: { ad: Array.from({ length: 500 }, (_, id) => ({ id: String(id), name: `ad-${id}`, cost: null })) } } } };
  const block = captureEconomicsSnapshot(source, 'ad');
  assert.equal(block.ranges['30d'].rows[0].cost, null);
  assert.equal(block.ranges['30d'].sourceCount, 500);
  assert.equal(block.ranges['30d'].complete, false);
  assert.ok(block.ranges['30d'].errors.length);
  assert.ok(Buffer.byteLength(JSON.stringify(block)) < 200 * 1024);
});
await test('live comparison retains only an actual previous completed period', () => {
  const snapshot = (start, end, generatedAt) => ({ generatedAt, attributionModel: 'LAST_CLICK', settings: { windowDays: 0, leadStage: [] }, account: { currency: 'USD' }, ranges: { yesterday: { start, end, levels: { ad: ads } } } });
  const previous = creativeBlock(snapshot('2026-09-13', '2026-09-13', '2026-09-14T12:00:00Z'), null);
  const current = creativeBlock(snapshot('2026-09-14', '2026-09-14', '2026-09-15T12:00:00Z'), previous);
  assert.equal(current.comparison.start, '2026-09-13');
  assert.equal(creativeBlock(snapshot('2026-09-14', '2026-09-14', '2026-09-15T12:00:00Z'), null).comparison, null);
  assert.equal(creativeBlock(snapshot('2026-09-14', '2026-09-14', '2026-09-15T12:00:00Z'), { ...previous, stale: true }).comparison, null);
});
await test('CSV preserves unknown values and guards formula-like text', () => {
  const text = csvText(['Name', 'Value'], [['=SUM(1,2)', null], ['normal', -12]]);
  assert.ok(text.includes("'=SUM(1,2)"));
  assert.ok(text.includes('-12'));
});

const snapshot = buildDemoSnapshot();
const esc = (value) => String(value ?? '').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
for (const id of ['profit', 'creative']) {
  const manifest = JSON.parse(await readFile(new URL(`../public/features/${id}/feature.json`, import.meta.url), 'utf8'));
  const { demo } = await import(`../public/features/${id}/demo.js`);
  const { render } = await import(`../public/features/${id}/view.js`);
  const { build } = await import(`../public/features/${id}/server.js`);
  const block = demo(snapshot);
  await test(`${id}: manifest, deterministic block, and size budget`, () => {
    assert.deepEqual(validateManifest(manifest, id), []);
    assert.deepEqual(block, demo(snapshot));
    assert.ok(Buffer.byteLength(JSON.stringify(block)) < 200 * 1024);
  });
  await test(`${id}: fresh, stale, error, skipped, empty, and null render states`, () => {
    for (const state of [null, {}, { error: '<broken>' }, { skipped: 'time budget' }, block, { ...block, stale: true, skipped: 'time budget' }]) {
      const root = { innerHTML: '', querySelector: () => null, querySelectorAll: () => [] };
      render({ root, block: state, snapshot, fmt, esc, kpis: (items) => items.map((item) => esc(item.label) + esc(item.value)).join(' '), demo: true, account: 'test', range: '30d', manifest });
      assert.ok(root.innerHTML.length > 20); assert.ok(!root.innerHTML.includes('<broken>'));
      if (state?.stale) assert.match(root.innerHTML, /previous/i);
    }
  });
  await test(`${id}: live build needs no MCP calls and preserves stale evidence`, async () => {
    const ctx = { snapshot, previous: block, now: new Date(), timeLeft: () => 1000, callTool: () => { throw new Error('Unexpected MCP call'); } };
    assert.ok((await build(ctx)).ranges['30d'].rows.length);
    const skipped = await build({ ...ctx, timeLeft: () => 0 });
    assert.equal(skipped.stale, true); assert.deepEqual(skipped.ranges, block.ranges);
    assert.equal((await build({ ...ctx, previous: skipped })).stale, undefined);
  });
}
console.log(`\n${passed} economics checks passed.`);

if (process.argv.includes('--browser')) {
  const { chromium } = await import('playwright');
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const output = await mkdtemp(join(tmpdir(), 'ai-hyros-economics-qa-'));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto('http://127.0.0.1:4321/features/profit/feature.json');
    for (const id of ['profit', 'creative']) {
      await page.setContent(`<link rel='stylesheet' href='/styles.css'><link rel='stylesheet' href='/features/${id}/style.css'><main class='panel'><section id='view-${id}'></section></main>`);
      await page.evaluate(async (feature) => {
        const { render } = await import(`/features/${feature}/view.js`);
        const { demo } = await import(`/features/${feature}/demo.js`);
        const { buildDemoSnapshot } = await import('/demo.js');
        const { fmt } = await import('/shared/metrics.js');
        const snapshot = buildDemoSnapshot();
        const esc = (value) => { const element = document.createElement('span'); element.textContent = String(value ?? ''); return element.innerHTML.replaceAll(String.fromCharCode(34), '&quot;'); };
        render({ root: document.getElementById(`view-${feature}`), snapshot, block: demo(snapshot), demo: false, account: 'economics-browser-test', range: '30d', fmt, esc,
          kpis: (items) => items.map((item) => `<div class='kpi'><div class='kpi-label'>${esc(item.label)}</div><div class='kpi-value ${item.cls || ''}'>${esc(item.value)}</div><div class='kpi-sub'>${esc(item.sub)}</div></div>`).join('') });
      }, id);
      if (id === 'profit') {
        await page.getByLabel('Default gross margin (%)').fill('60');
        await page.locator('select[name=refundTreatment]').selectOption('included');
        await page.getByLabel('Daily overhead', { exact: false }).fill('100');
        await page.getByRole('button', { name: 'Save settings', exact: true }).click();
        assert.match(await page.locator('[data-profit-save]').innerText(), /Saved in this browser/);
        await page.locator('[data-profit-search]').fill('no-such-ad-set-734');
        assert.match(await page.locator('[data-profit-results]').innerText(), /No matching/);
        await page.locator('[data-profit-search]').fill('');
        await page.locator('.profit-table summary').first().click();
      } else {
        await page.getByLabel('Use name slots').check();
        await page.getByLabel('Delimiter', { exact: true }).fill(' ');
        await page.getByRole('button', { name: 'Save settings', exact: true }).click();
        assert.match(await page.locator('[data-creative-save]').innerText(), /Saved in this browser/);
        await page.locator('[data-creative-search]').fill('no-such-creative-734');
        assert.match(await page.locator('[data-creative-results]').innerText(), /No matching/);
        await page.locator('[data-creative-search]').fill('');
        await page.locator('.creative-group > summary').first().click();
      }
      const downloadPromise = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Export CSV', exact: true }).click();
      assert.match((await downloadPromise).suggestedFilename(), new RegExp(`^${id}-30d`));
      for (const width of [1440, 390, 320]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.screenshot({ path: join(output, `${id}-${width}.png`), fullPage: true });
        const layout = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: innerWidth }));
        assert.ok(layout.scroll <= layout.width, `${id} page overflows at ${width}: ${layout.scroll}`);
      }
      console.log(`PASS ${id}: browser settings, filtering, expansion, CSV, desktop/mobile layout`);
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
    assert.deepEqual(errors, []);
    console.log(`Browser screenshots: ${output}`);
  } finally { await browser.close(); }
}

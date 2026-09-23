import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diagnose, parameterState, assessRecheck, remediationNote } from '../public/features/health/diagnostics.js';
import { recheck } from '../public/features/health/wizard.js';
import { render as renderHealth } from '../public/features/health/view.js';
import { build as buildHealth } from '../public/features/health/server.js';
import { normalizeCurve, build as buildScale } from '../public/features/scale/server.js';
import { historicalScenario, curveAssessment, attributionRole } from '../public/features/scale/analysis.js';
import { render as renderScale, curveSvg } from '../public/features/scale/view.js';
import { fmt } from '../public/shared/metrics.js';

let passed = 0;
async function test(name, run) { await run(); passed += 1; console.log(`PASS ${name}`); }
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const snapshot = { account: {}, adAccounts: [{ id: 'a', type: 'GOOGLE' }, { id: 'b', type: 'FACEBOOK' }], ranges: { '30d': { end: '2026-09-23', levels: { adset: [] } } } };
const health = { checkedAt: '2026-09-22T08:00:00Z', domains: ['data.example.test'],
  sites: [{ url: 'https://example.test/', trackingDomain: 'data.example.test' }, { url: 'https://www.example.test/', trackingDomain: 'data.example.test' }],
  scripts: { 'https://example.test/': 'SCRIPT_NOT_FOUND', 'https://www.example.test/': 'SCRIPT_NOT_FOUND' },
  trackingParams: [{ type: 'SEARCH', rows: [{ adId: 'ad1', valid: false, missing: ['gclid'] }] }], errors: [],
  checks: { domains: { status: 'ok' }, script: { status: 'ok' }, params: { status: 'ok', channels: { SEARCH: 'ok' } } } };
const fresh = (extra) => ({ ...health, checkedAt: '2026-09-23T08:00:00Z', ...extra });
const scriptIssue = diagnose(health).find((i) => i.check === 'script');
const paramsIssue = diagnose(health).find((i) => i.check === 'params');
const apiContext = (body, extra = {}) => ({ account: 'a', demo: false, api: async () => ({ status: 200, body }), ...extra });
const curveReply = { name: 'Observed', cacCeiling: 70, attributionModel: 'FIRST_CLICK', daysSampled: 28,
  curve: [{ spendPerDay: 100, days: 14, newCustomers: 25, avgCac: 56, marginalCac: null },
    { spendPerDay: 200, days: 14, newCustomers: 40, avgCac: 70, marginalCac: 93 }], notes: [] };
const curve = normalizeCurve(curveReply, { id: 'a', level: 'ACCOUNT' });
function context(block, extra = {}) {
  return { root: { innerHTML: '' }, block, snapshot, account: 'a', demo: false, fmt, esc,
    kpis: (tiles) => tiles.map((t) => `${esc(t.label)}: ${esc(t.value)}`).join(' '), ...extra };
}
function serverContext(extra = {}) {
  const calls = [];
  return { snapshot, previous: null, now: new Date('2026-09-23T08:00:00Z'), env: {}, log() {}, timeLeft: () => 60000,
    calls, callTool: async (name, args, opts) => { calls.push({ name, args, opts }); return curveReply; }, ...extra };
}

await test('parameter names and empty missing arrays cannot create false positives', () => {
  assert.equal(parameterState({ adName: 'Missing you / Invalid offer', valid: true, missing: [] }), 'ok');
  assert.equal(parameterState({ adName: 'Missing tags' }), 'unknown');
  assert.equal(parameterState({ valid: true, missing: ['gclid'] }), 'missing');
});
await test('script diagnosis groups redirects and requires explicit absence', () => {
  assert.equal(diagnose(health).filter((i) => i.check === 'script').length, 1);
  assert.equal(diagnose({ ...health, scripts: { ...health.scripts, 'https://www.example.test/': 'SCRIPT_FOUND' } }).filter((i) => i.check === 'script').length, 0);
  assert.equal(diagnose({ ...health, scripts: {} }).find((i) => i.check === 'script').severity, 'coverage');
});
await test('failed channels remain visible when another channel succeeds', () => {
  const items = diagnose({ ...health, checks: { ...health.checks, params: { status: 'ok', channels: { SEARCH: 'ok', PERFORMANCE_MAX: 'failed' } } } });
  assert(items.some((i) => i.channel === 'PERFORMANCE_MAX' && i.severity === 'coverage'));
});
await test('missing domains are diagnosed only from a completed empty check', () => {
  assert(!diagnose({ checkedAt: health.checkedAt, domains: [] }).some((i) => i.check === 'domains'));
  assert(diagnose({ checkedAt: health.checkedAt, domains: [], checks: { domains: { status: 'empty' } } }).some((i) => i.id === 'domains:none'));
});
await test('recheck needs fresh positive evidence for the matching entity', () => {
  assert.equal(assessRecheck(scriptIssue, fresh({ scripts: { 'https://www.example.test/': 'SCRIPT_FOUND' } })).status, 'verified');
  assert.equal(assessRecheck(scriptIssue, fresh({ sites: [], scripts: {} })).status, 'inconclusive');
  assert.equal(assessRecheck(scriptIssue, fresh({})).status, 'still-open');
  assert.equal(assessRecheck(scriptIssue, health).status, 'inconclusive');
  assert.equal(assessRecheck(scriptIssue, fresh({ stale: true })).status, 'inconclusive');
});
await test('disappearing ads, failed channels and stale checks cannot resolve issues', () => {
  assert.equal(assessRecheck(paramsIssue, fresh({ trackingParams: [] })).status, 'inconclusive');
  const good = fresh({ trackingParams: [{ type: 'SEARCH', rows: [{ adId: 'ad1', valid: true }] }] });
  assert.equal(assessRecheck(paramsIssue, good).status, 'verified');
  assert.equal(assessRecheck(paramsIssue, { ...good, checks: { ...good.checks, params: { status: 'ok', channels: { SEARCH: 'failed' } } } }).status, 'inconclusive');
  assert.equal(assessRecheck(scriptIssue, fresh({ checks: { ...health.checks, script: { status: 'ok', stale: true } } })).status, 'inconclusive');
});
await test('demo recheck performs no request; live uses only core POST refresh', async () => {
  let calls = 0;
  const api = async (path, opts) => { calls++; assert.equal(path, '/api/refresh'); assert.deepEqual(opts, { method: 'POST' }); return { status: 200, body: { ok: true, persisted: true, account: 'a' } }; };
  assert.equal((await recheck({ ...apiContext({}, { api }), demo: true }, scriptIssue)).status, 'demo');
  assert.equal(calls, 0);
  assert.equal((await recheck(apiContext({}, { api }), scriptIssue)).status, 'reload-required');
  assert.equal(calls, 1);
});
await test('refresh failures and unpersisted results never claim verification', async () => {
  for (const body of [{ ok: true, persisted: false }, { ok: true }, { ok: false, message: 'Timeout' }, {}]) {
    assert.notEqual((await recheck(apiContext(body), scriptIssue)).status, 'verified');
  }
  assert.equal((await recheck(apiContext({ ok: true, persisted: true, account: 'other' }), scriptIssue)).status, 'inconclusive');
  assert.equal((await recheck(apiContext({}, { api: async () => { throw new Error('Network down'); } }), scriptIssue)).status, 'failed');
});
await test('optional reload bridge checks actual new evidence', async () => {
  const ctx = apiContext({ ok: true, persisted: true }, { reloadSnapshot: async () => ({ health: fresh({ scripts: { 'https://example.test/': 'SCRIPT_FOUND' } }) }) });
  assert.equal((await recheck(ctx, scriptIssue)).status, 'verified');
  assert.equal((await recheck({ ...ctx, reloadSnapshot: async () => ({ health }) }, scriptIssue)).status, 'inconclusive');
  assert.equal((await recheck({ ...ctx, reloadSnapshot: async () => { throw new Error(); } }, scriptIssue)).status, 'reload-required');
  let loaded = false;
  assert.equal((await recheck({ ...ctx, reload: async () => { loaded = true; } }, scriptIssue)).status, 'reloaded');
  assert(loaded);
});
await test('export distinguishes a proposal, self-reported work and recheck status', () => {
  const note = remediationNote(paramsIssue, { demo: true, account: 'a', checked: [0], result: { message: 'Refresh pending.' } });
  assert(note.includes('Demo sample') && note.includes('gclid') && note.includes('- [x]') && note.includes('self-reported') && note.includes('Refresh pending.'));
});
await test('views handle all block states with no DOM query methods', () => {
  for (const [render, data] of [[renderHealth, health], [renderScale, { curves: [curve] }]]) {
    for (const block of [null, {}, { skipped: 'time budget' }, { error: 'bad <x>' }, data, { ...data, stale: true, skipped: 'time budget' }]) {
      const ctx = context(block); render(ctx); assert(ctx.root.innerHTML.length > 20);
      assert(!ctx.root.innerHTML.includes('<x>'));
      if (block?.stale) assert.match(ctx.root.innerHTML, /previous/i);
    }
  }
});
await test('diagnostic evidence is escaped and unsafe names do not become markup', () => {
  const ctx = context({ ...health, trackingParams: [{ type: 'SEARCH', rows: [{ adId: '<img src=x onerror=alert(1)>', valid: false }] }] });
  renderHealth(ctx); assert(!ctx.root.innerHTML.includes('<img')); assert(ctx.root.innerHTML.includes('&lt;img'));
});
await test('curve normalization bounds points and rejects non-finite/negative spend', () => {
  const c = normalizeCurve({ curve: [{ spendPerDay: Infinity }, { spendPerDay: -1 }, { spendPerDay: true }, { spendPerDay: ' ' }, { spendPerDay: 0, marginalCac: Infinity }, null] }, {});
  assert.equal(c.points.length, 1); assert.equal(c.points[0].marginalCac, null);
  const large = normalizeCurve({ curve: Array.from({ length: 300 }, (_, i) => ({ spendPerDay: i })) }, {});
  assert.equal(large.points.length, 120); assert(large.notes.includes('CURVE_TRUNCATED'));
});
await test('historical scenarios use exact buckets without forecasts or interpolation', () => {
  const before = JSON.stringify(curve);
  assert.equal(historicalScenario(curve, 1, 100).status, 'within');
  assert.equal(historicalScenario(curve, 1, 80).status, 'above');
  assert.equal(historicalScenario(curve, 0, 80).status, 'unknown');
  assert.equal(historicalScenario(curve, 99).bucket, null);
  assert.equal(historicalScenario(curve, 1, 80).bucket.spend, 200);
  assert.equal(JSON.stringify(curve), before);
});
await test('missing ceilings, partial notes and stale data cannot promise scale', () => {
  assert.match(curveAssessment({ ...curve, ceiling: null }).text, /unassessed/);
  assert.match(curveAssessment({ ...curve, stale: true }).text, /Previous/);
  assert.match(curveAssessment({ ...curve, notes: ['INSUFFICIENT_DATA'] }, 100).text, /Partial/);
  assert.match(curveAssessment(curve, 100).text, /future response unknown/);
});
await test('acquisition and closing labels follow explicit attribution models', () => {
  assert.equal(attributionRole('FIRST_CLICK'), 'Acquisition credit');
  assert.equal(attributionRole('LAST_CLICK'), 'Closing credit');
  assert.equal(attributionRole(null), 'Attribution model unavailable');
  assert.equal(attributionRole('SCIENTIFIC'), 'Other attribution credit');
});
await test('curve chart does not invent zeros or join missing CAC samples', () => {
  const c = { points: [{ spend: 10, marginalCac: -10 }, { spend: 20 }, { spend: 30, marginalCac: 30 }] };
  const html = curveSvg(c, fmt); assert(!/NaN|Infinity/.test(html));
  assert.match(html, /class="marg"[^>]+d="M[^L]+M/);
  assert.equal(curveSvg({ points: [{ spend: 1 }, { spend: 2 }] }, fmt), '');
});
await test('live curve failures retain dated evidence without hiding errors', async () => {
  const previous = { checkedAt: health.checkedAt, window: { start: '2026-06-25', end: '2026-09-22' }, curves: [curve] };
  const ctx = serverContext({ previous, callTool: async () => { throw Object.assign(new Error('timed out'), { code: 'timeout' }); } });
  const out = await buildScale(ctx);
  assert(out.curves[0].stale && out.curves[0].points.length && out.curves[0].error);
  assert.equal(out.curves[0].checkedAt, previous.checkedAt);
  assert.equal(out.curves[0].retry, 'next refresh');
  const view = context(out); renderScale(view); assert.match(view.root.innerHTML, /Previous curve/);
});
await test('rate limits stop later curve calls and mark their coverage', async () => {
  let calls = 0;
  const out = await buildScale(serverContext({ callTool: async () => { calls++; throw Object.assign(new Error('Slow down'), { code: 'rate_limited' }); } }));
  assert.equal(calls, 1); assert.match(out.curves[1].skipped, /rate limited/); assert.equal(out.coverage.failed, 1);
});
await test('scale preserves every account plus the top six ad sets beyond twelve targets', async () => {
  const many = { ...snapshot, adAccounts: Array.from({ length: 14 }, (_, i) => ({ id: `account-${i}` })),
    ranges: { '30d': { end: '2026-09-23', levels: { adset: Array.from({ length: 8 }, (_, i) => ({ id: `adset-${i}`, cost: i * 100 })) } } } };
  const ctx = serverContext({ snapshot: many });
  const out = await buildScale(ctx);
  assert.equal(out.curves.length, 20); assert.equal(ctx.calls.length, 20);
  assert.deepEqual(out.curves.filter((c) => c.level === 'SOURCE_LINK').map((c) => c.id), ['adset-7', 'adset-6', 'adset-5', 'adset-4', 'adset-3', 'adset-2']);
  let called = false;
  const partial = await buildScale(serverContext({ snapshot: many, timeLeft: () => called ? 0 : 60000,
    callTool: async () => { called = true; return curveReply; } }));
  assert.equal(partial.curves.length, 20); assert.equal(partial.coverage.skipped, 19);
});
await test('only one curve uses the slow lane and every timeout fits the budget', async () => {
  const ctx = serverContext({ timeLeft: () => 30000, slowTimeout: () => 45000 });
  await buildScale(ctx);
  assert.equal(ctx.calls[0].opts.timeoutMs, 28000);
  assert(ctx.calls.slice(1).every((c) => c.opts.timeoutMs <= 15000));
});
await test('unknown replies are errors and missing core ranges do not throw', async () => {
  const out = await buildScale(serverContext({ callTool: async () => ({ result: { request_id: 'pending' } }) }));
  assert(out.curves.every((c) => c.error));
  const ctx = serverContext({ snapshot: {} }); assert((await buildScale(ctx)).error); assert.equal(ctx.calls.length, 0);
});
await test('health cheap requests cannot overrun their remaining budget', async () => {
  const calls = [];
  await buildHealth(serverContext({ timeLeft: () => 4000, snapshot: { adAccounts: [] },
    callTool: async (name, args, opts) => { calls.push(opts.timeoutMs); return []; } }));
  assert.deepEqual(calls, [2000]);
});

if (process.argv.includes('--browser')) {
  const modulePath = process.argv.find((arg) => arg.startsWith('--playwright-module='))?.split('=').slice(1).join('=');
  const { chromium } = modulePath ? await import(pathToFileURL(modulePath)) : await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/_diagnostics-fixture', (route) => route.fulfill({ contentType: 'text/html',
      body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"></head><body></body></html>' }));
    await page.goto('http://127.0.0.1:4321/_diagnostics-fixture');
    await page.evaluate(async () => {
      const [{ buildDemoSnapshot }, healthDemo, scaleDemo, healthView, scaleView, metrics] = await Promise.all([
        import('/demo.js'), import('/features/health/demo.js'), import('/features/scale/demo.js'),
        import('/features/health/view.js'), import('/features/scale/view.js'), import('/shared/metrics.js'),
      ]);
      document.body.innerHTML = '<main style="padding:16px;max-width:1400px;margin:auto"><p>Diagnostic test fixture</p><section id="fixture"></section></main>';
      for (const id of ['health', 'scale']) { const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = `/features/${id}/style.css`; document.head.append(link); }
      const snapshot = buildDemoSnapshot();
      const escape = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
      window.fixture = { root: document.querySelector('#fixture'), snapshot, account: 'test-a', demo: false, fmt: metrics.fmt, esc: escape,
        kpis: (items) => items.map((k) => `<div class="kpi"><div class="kpi-label">${escape(k.label)}</div><div class="kpi-value">${escape(k.value)}</div><div class="sub">${escape(k.sub)}</div></div>`).join(''),
        api: () => new Promise((resolve) => { window.finishRefresh = resolve; }) };
      window.healthFixture = healthDemo.demo(snapshot);
      window.healthOriginal = window.healthFixture;
      window.scaleFixture = scaleDemo.demo(snapshot);
      window.paintHealth = () => { window.fixture.root.id = 'view-health'; healthView.render({ ...window.fixture, block: window.healthFixture }); };
      window.paintScale = () => { window.fixture.root.id = 'view-scale'; scaleView.render({ ...window.fixture, block: window.scaleFixture }); };
      window.paintHealth();
    });
    await test('browser: guided checklist, export and pending/result states', async () => {
      await page.getByRole('button', { name: 'Review correction', exact: true }).click();
      await page.locator('[data-health-check]').first().check();
      const download = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Export remediation note', exact: true }).click();
      assert.match((await download).suggestedFilename(), /^tracking-remediation-/);
      await page.getByRole('button', { name: 'Continue to recheck', exact: true }).click();
      await page.getByRole('button', { name: 'Recheck account', exact: true }).click();
      assert(await page.getByRole('button', { name: 'Rechecking...', exact: true }).isDisabled());
      await page.evaluate(() => window.finishRefresh({ status: 200, body: { ok: true, persisted: true, account: 'test-a' } }));
      await page.getByRole('button', { name: 'Reload snapshot', exact: true }).waitFor();
      assert.match(await page.locator('.health-result').innerText(), /no correction is verified yet/);
    });
    await test('browser: late recheck cannot overwrite another account or snapshot', async () => {
      await page.getByRole('button', { name: 'Recheck account', exact: true }).click();
      await page.evaluate(() => { window.fixture.account = 'test-b'; window.paintHealth(); window.finishRefresh({ status: 200, body: { ok: true, persisted: true, account: 'test-a' } }); });
      assert.equal(await page.locator('[data-health-reload]').count(), 0);
      await page.locator('[data-health-step="2"]').click();
      await page.getByRole('button', { name: 'Recheck account', exact: true }).click();
      await page.evaluate(() => { window.healthFixture = { ...window.healthFixture, checkedAt: '2026-09-24T08:00:00Z' }; window.paintHealth(); window.finishRefresh({ status: 200, body: { ok: true, persisted: true, account: 'test-b' } }); });
      assert.equal(await page.locator('[data-health-reload]').count(), 0);
    });
    await test('browser: core reload bridge verifies the new snapshot without restoring old evidence', async () => {
      await page.evaluate(() => {
        window.fixture.reload = async () => {
          window.healthFixture = { ...window.healthFixture, checkedAt: '2026-09-25T08:00:00Z',
            scripts: Object.fromEntries(Object.keys(window.healthFixture.scripts).map((url) => [url, 'SCRIPT_FOUND'])),
            trackingParams: [] };
          window.paintHealth();
        };
        window.paintHealth();
      });
      await page.locator('[data-health-step="2"]').click();
      await page.getByRole('button', { name: 'Recheck account', exact: true }).click();
      await page.evaluate(() => window.finishRefresh({ status: 200, body: { ok: true, persisted: true, account: 'test-b' } }));
      await page.getByText(/A fresh positive result was returned/).waitFor();
      assert.match(await page.locator('.health-result').innerText(), /Recheck for Script not found/);
      assert.equal(await page.locator('[data-health-issue]').count(), 0);
      const download = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Export recheck note', exact: true }).click();
      assert.match((await download).suggestedFilename(), /^tracking-remediation-/);
      await page.evaluate(() => { window.healthFixture = window.healthOriginal; delete window.fixture.reload; window.paintHealth(); });
    });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const feature of ['health', 'scale']) {
        await page.evaluate((feature) => feature === 'health' ? window.paintHealth() : window.paintScale(), feature);
        await page.evaluate(() => document.fonts.ready);
        await test(`browser: ${feature} fits ${width}px viewport`, async () => {
          const size = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: innerWidth }));
          assert(size.scroll <= size.width + 1, JSON.stringify(size));
          if (feature === 'scale') assert(await page.locator('svg.scale-chart').count() > 0);
          await page.screenshot({ path: join(tmpdir(), `hyros-${feature}-${width}.png`), fullPage: false });
        });
      }
    }
    await test('browser: comparison ceiling and observed bucket controls work', async () => {
      await page.locator('[data-scale-ceiling]').fill('75');
      await page.getByRole('button', { name: 'Compare', exact: true }).click();
      assert.match(await page.locator('#scale-ceiling-note').innerText(), /Local ceiling/);
      await page.locator('[data-scale-bucket]').first().selectOption('1');
      assert.equal(await page.locator('[data-scale-bucket]').first().inputValue(), '1');
      await page.getByRole('button', { name: 'Reset comparison', exact: true }).click();
      assert.equal(await page.locator('[data-scale-ceiling]').inputValue(), '');
    });
    await test('browser: long Health metadata cannot expand mobile grid columns', async () => {
      await page.evaluate(() => {
        window.fixture.snapshot = { ...window.fixture.snapshot, adAccounts: [{ id: 'x'.repeat(140), name: 'Synthetic account', type: 'GOOGLE' }] };
        window.healthFixture = { ...window.healthOriginal, sites: window.healthOriginal.sites.map((site) => ({ ...site, trackingDomain: 'tracking.' + 'subdomain'.repeat(12) + '.example.test' })) };
        window.paintHealth();
      });
      for (const width of [320, 390, 768, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        const size = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: innerWidth }));
        assert(size.scroll <= size.width + 1, JSON.stringify(size));
      }
    });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
}
console.log(`\n${passed} diagnostics tests passed.`);

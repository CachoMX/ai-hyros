import assert from 'node:assert/strict';
import { analyzePaths, build as buildFunnel } from '../public/features/funnel/server.js';
import { build as buildAdltv } from '../public/features/adltv/server.js';
import { cohortLtv, nativeLtv, observedRevenue, salesHistory } from '../public/features/adltv/analytics.js';
import { render as renderFunnel } from '../public/features/funnel/view.js';
import { render as renderAdltv } from '../public/features/adltv/view.js';
import { demo as funnelDemo } from '../public/features/funnel/demo.js';
import { demo as adltvDemo } from '../public/features/adltv/demo.js';
import { buildDemoSnapshot } from '../public/demo.js';
import { validateManifest } from '../public/shared/features.js';
import { readFile } from 'node:fs/promises';

const now = '2026-09-23T12:00:00.000Z';
const touch = (id, date, extra = {}) => ({ id, name: id, date, platform: 'Meta', organic: false, disregarded: false, ...extra });
const sale = (id, leadId, date, amount, extra = {}) => ({ id, leadId, kind: 'SALE', date, amount, currency: 'USD', firstSale: null, path: [], ...extra });
const attribution = {
  checkedAt: now, window: { start: '2026-08-24', end: '2026-09-23' },
  coverage: { sampled: 5, withPaths: 3, complete: true, truncated: false }, errors: [],
  conversions: [
    sale('first', 'lead-a', '2026-09-15', 100, { firstSale: true, recurring: true, path: [touch('open', '2026-09-01', { adId: 'ad-a' }), touch('assist', '2026-09-08'), touch('assist', '2026-09-09'), touch('close', '2026-09-14')] }),
    sale('repeat', 'lead-a', '2026-09-20', 40, { firstSale: false, recurring: false, path: [touch('open', '2026-09-01', { adId: 'ad-a' })] }),
    sale('eur', 'lead-b', '2026-09-20', 60, { currency: 'EUR', path: [] }),
    sale('disregarded', 'lead-c', '2026-09-20', null, { currency: null, path: [touch('ignored', '2026-09-01', { disregarded: true })] }),
    { id: 'call', leadId: 'lead-z', kind: 'CALL', date: '2026-09-21', path: [touch('call-source', '2026-09-20')] },
  ],
};
const snapshot = {
  account: { currency: 'USD' }, attribution,
  ranges: { '30d': { start: '2026-08-24', end: '2026-09-23', levels: { ad: [{ id: 'ad-a', name: 'Native ad', ltv30Days: 125, ltv60Days: 175, ltv90Days: null }] } } },
  crm: { window: { from: '2026-08-24', to: '2026-09-23' }, sync: { syncedAt: now, truncated: { leads: false, calls: false, sales: false } }, leads: [{ id: 'lead-a', email: 'fixture@example.test' }], calls: [{ qualified: true }, { qualified: false }], sales: Array.from({ length: 9 }, (_, i) => ({ id: `crm-${i}` })) },
};
const serverCtx = (snap = snapshot, extra = {}) => ({ snapshot: snap, now: new Date(now), timeLeft: () => 10000, callTool: () => { throw new Error('Unexpected network call'); }, ...extra });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function viewCtx(block, minimal = false) {
  const events = new Map();
  const root = { innerHTML: '', querySelectorAll: () => [] };
  if (!minimal) root.querySelector = (selector) => ({ addEventListener: (type, cb) => events.set(`${selector}:${type}`, cb) });
  return { block, root, events, snapshot, demo: false, fmt: { int: (n) => String(n), money: (n) => `$${n}`, date: (d) => String(d || 'Unknown'), datetime: (d) => String(d || 'Unknown') }, esc,
    kpis: (rows) => rows.map((r) => `<div>${esc(r.label)}: ${esc(r.value)} ${esc(r.sub || '')}</div>`).join('') };
}
let count = 0;
async function test(name, fn) { await fn(); count += 1; console.log(`PASS ${name}`); }

await test('source roles use conversion paths, dedupe assists, preserve organic and disregarded evidence', () => {
  const f = analyzePaths(attribution);
  assert.equal(f.summary.conversions, 5); assert.equal(f.summary.sales, 4); assert.equal(f.summary.calls, 1);
  assert.equal(f.summary.noTouch, 2); assert.equal(f.summary.multiTouch, 1); assert.equal(f.summary.late, 2);
  assert.equal(f.sources.find((r) => r.name === 'assist').assists, 1);
  assert.equal(f.sources.find((r) => r.name === 'open').opening, 2);
  assert.equal(f.sources.find((r) => r.name === 'close').closing, 1);
  assert.equal(f.sources.some((r) => r.name === 'ignored'), false);
  assert.equal(f.journeys.find((j) => j.id === 'disregarded').path[0].disregarded, true);
  assert.equal(f.flows.filter((r) => r.steps[0] === 'No eligible touch').reduce((sum, r) => sum + r.count, 0), 2);
  assert.equal(f.journeys.find((r) => r.id === 'first').path.length, 4);
});
await test('sale and call IDs occupy separate namespaces; duplicate sale IDs are counted once', () => {
  const f = analyzePaths({ conversions: [attribution.conversions[0], attribution.conversions[0], { id: 'first', kind: 'CALL', path: [] }] });
  assert.equal(f.summary.conversions, 2);
});
await test('source roles sort valid touches, exclude unknown/future dates, and keep original evidence', () => {
  const sample = { conversions: [sale('unordered', 'lead', '2026-09-20', 100, { path: [touch('last', '2026-09-19'), touch('future', '2026-10-01'), touch('first', '2026-09-01'), touch('undated', null)] })] };
  const f = analyzePaths(sample);
  assert.equal(f.sources.find((r) => r.name === 'first').opening, 1);
  assert.equal(f.sources.find((r) => r.name === 'last').closing, 1);
  assert.equal(f.sources.length, 2); assert.equal(f.journeys[0].path.length, 4);
  assert.equal(f.journeys[0].path[1].exclusion, 'after conversion');
  assert.equal(f.journeys[0].path[3].exclusion, 'date unknown');
  const d = observedRevenue(sample);
  assert.equal(d.rows[0].name, 'first'); assert.equal(d.candidates[0].late, 1);
});
await test('independent CRM counts cannot become path conversion rates or cohort denominators', async () => {
  const f = await buildFunnel(serverCtx());
  assert.equal(f.crm.leads, 1); assert.equal(f.crm.calls, 2); assert.equal(f.crm.sales, 9);
  assert.equal(f.summary.sales, 4); assert.equal('stages' in f, false);
  const ctx = viewCtx(f); renderFunnel(ctx);
  assert.match(ctx.root.innerHTML, /different populations/);
  assert.doesNotMatch(ctx.root.innerHTML, /of previous|Visitors.*Customers/);
});
await test('repeats depend on firstSale, never recurring; revenue stays partitioned by currency', () => {
  const d = observedRevenue(attribution);
  assert.deepEqual(d.summary, { sales: 4, first: 1, repeat: 1, unclassified: 2, unlinked: 0 });
  assert.equal(d.totals.find((r) => r.currency === 'USD').revenue, 140);
  assert.equal(d.totals.find((r) => r.currency === 'EUR').revenue, 60);
  assert.equal(d.totals.find((r) => r.currency === null).unknownAmounts, 1);
  assert.equal(d.rows.find((r) => r.name === 'No eligible touch' && r.currency === 'EUR').sales, 1);
  assert.equal(d.leads.find((r) => r.leadId === 'lead-a').repeat, 1);
});
await test('late and multitouch evidence identify candidates; native values match ad IDs only', () => {
  const native = nativeLtv(snapshot);
  const d = observedRevenue(attribution, native);
  const candidate = d.candidates.find((r) => r.adId === 'ad-a');
  assert.equal(candidate.late, 2); assert.equal(candidate.multiTouch, 1); assert.equal(candidate.native.ltv60, 175);
  assert.equal(candidate.native.ltv90, null);
  assert.equal(d.candidates.some((r) => r.name === 'close'), false);
  assert.equal(d.candidates.find((r) => r.name === 'assist').native, null);
  assert.equal(observedRevenue(attribution, [{ ...native[0], stale: true }]).candidates.find((r) => r.adId === 'ad-a').native, null);
});
await test('complete path-date sample never certifies acquisition-cohort LTV', async () => {
  const d = await buildAdltv(serverCtx());
  assert.equal(d.coverage.complete, true); assert.deepEqual(d.cohorts.rows, []);
  assert.match(d.cohorts.reason, /Unknown/); assert.equal(d.native[0].ltv60, 175);
  assert.equal(salesHistory({ attribution: { history: { basis: 'conversion-paths', complete: true, sales: attribution.conversions } } }), null);
});
const history = {
  basis: 'lead-sales', complete: true, truncated: false, checkedAt: now,
  window: { start: '2026-06-01', end: '2026-09-23' },
  sales: [
    sale('h0', 'mature', '2026-06-01T00:00:00Z', 100, { firstSale: true, source: { adId: 'ad-a', name: 'Source A' } }),
    sale('h30', 'mature', '2026-07-01T00:00:00Z', 20, { firstSale: false }),
    sale('h60', 'mature', '2026-07-31T00:00:00Z', 30, { firstSale: false }),
    sale('h90', 'mature', '2026-08-30T00:00:00Z', 40, { firstSale: false }),
    sale('young', 'young', '2026-09-20T00:00:00Z', 50, { firstSale: true, source: { adId: 'ad-a', name: 'Source A' } }),
  ],
};
await test('cohort horizons include exact boundaries and only mature denominators', () => {
  const c = cohortLtv(history, now).rows[0];
  assert.equal(c.customers, 2);
  assert.deepEqual(c.horizons.map((h) => h.value), [75, 120, 150, 190]);
  assert.deepEqual(c.horizons.map((h) => h.mature), [2, 1, 1, 1]);
  assert.deepEqual(c.horizons.map((h) => h.immature), [0, 1, 1, 1]);
});
await test('young cohorts are immature, while missing historical horizon coverage is unknown', () => {
  const young = cohortLtv({ ...history, sales: [history.sales[4]] }, now).rows[0];
  assert.equal(young.horizons[3].status, 'immature'); assert.equal(young.horizons[3].value, null);
  const short = cohortLtv({ ...history, window: { start: '2026-06-01', end: '2026-07-15' }, sales: history.sales.slice(0, 4) }, now).rows[0];
  assert.equal(short.horizons[1].value, 120); assert.equal(short.horizons[2].status, 'unknown');
  const leftCensored = cohortLtv({ ...history, window: { start: '2026-06-02', end: '2026-09-23' } }, now).rows[0];
  assert.equal(leftCensored.horizons[1].value, null);
});
await test('truncation, stale history, unknown amount, or mixed lead currencies cannot yield mature LTV', () => {
  for (const extra of [{ complete: false }, { truncated: true }, { stale: true }]) {
    assert.equal(cohortLtv({ ...history, ...extra }, now).rows[0].horizons[3].value, null);
  }
  for (const extra of [{ amount: null }, { currency: 'EUR' }]) {
    const rows = history.sales.map((s) => s.id === 'h30' ? { ...s, ...extra } : s);
    assert.equal(cohortLtv({ ...history, sales: rows }, now).rows[0].horizons[1].value, null);
  }
  const unknownAnchor = history.sales.map((s) => ({ ...s, firstSale: null, recurring: false }));
  assert.deepEqual(cohortLtv({ ...history, sales: unknownAnchor }, now).rows, []);
});
await test('different cohort currencies retain separate denominators', () => {
  const eur = sale('euro-first', 'eur-lead', '2026-06-01', 80, { currency: 'EUR', firstSale: true, source: { adId: 'ad-a', name: 'Source A' } });
  const rows = cohortLtv({ ...history, sales: [...history.sales, eur] }, now).rows;
  assert.equal(rows.length, 2); assert.equal(rows.find((r) => r.currency === 'EUR').horizons[3].value, 80);
});
await test('CRM can supply history only with exact firstSale flags and verified sales pagination', () => {
  const crm = { ...snapshot.crm, window: { from: '2026-06-01', to: '2026-09-23' }, sales: [{ id: 'crm-first', email: 'fixture@example.test', date: '2026-06-01', amount: 25, currency: 'USD', firstSale: true }] };
  const c = cohortLtv(salesHistory({ crm }), now);
  assert.equal(c.rows[0].horizons[3].value, 25);
  assert.equal(cohortLtv(salesHistory({ crm: { ...crm, sync: {} } }), now).rows[0].horizons[3].value, null);
});
await test('builders propagate dependency freshness and honor spent budgets without requests', async () => {
  for (const build of [buildFunnel, buildAdltv]) {
    const stale = await build(serverCtx({ ...snapshot, attribution: { ...attribution, stale: true, skipped: 'time budget' } }));
    assert.equal(stale.stale, true); assert.equal(stale.checkedAt, now);
    const previous = await build(serverCtx(snapshot, { previous: { ...stale, error: 'old' }, timeLeft: () => 0 }));
    assert.equal(previous.stale, true); assert.equal(previous.error, undefined);
    const fresh = await build(serverCtx(snapshot, { previous: stale }));
    assert.equal(fresh.stale, undefined);
    assert.deepEqual(await build(serverCtx(snapshot, { timeLeft: () => 0 })), { skipped: 'time budget' });
  }
});
await test('live views tolerate states and fake DOM roots; stale status includes its own timestamp', async () => {
  for (const [build, render] of [[buildFunnel, renderFunnel], [buildAdltv, renderAdltv]]) {
    const fresh = await build(serverCtx());
    for (const block of [null, {}, { skipped: 'time budget' }, { error: 'bad response' }, fresh, { ...fresh, stale: true, skipped: 'budget' }, await build(serverCtx({})), await build(serverCtx({ attribution: { conversions: [], errors: [] } }))]) {
      const ctx = viewCtx(block, true); assert.doesNotThrow(() => render(ctx)); assert.ok(ctx.root.innerHTML.length);
      if (block?.stale) { assert.match(ctx.root.innerHTML, /previous/); assert.match(ctx.root.innerHTML, /2026-09-23/); }
      if (block?.error) assert.match(ctx.root.innerHTML, /bad response/);
    }
  }
});
await test('evidence controls change the selected full chain and kind filter', async () => {
  const ctx = viewCtx(await buildFunnel(serverCtx())); renderFunnel(ctx);
  ctx.events.get('[data-funnel-sample]:change')({ target: { value: 'SALE:disregarded' } });
  assert.match(ctx.root.innerHTML, /funnel-disregarded/);
  ctx.events.get('[data-funnel-kind]:change')({ target: { value: 'CALL' } });
  assert.match(ctx.root.innerHTML, /Call call/); assert.doesNotMatch(ctx.root.innerHTML, /<option value="SALE:/);
  ctx.events.get('[data-funnel-role]:change')({ target: { value: 'closing' } });
  assert.match(ctx.root.innerHTML, /value="closing" selected/);
});
await test('date-only windows bypass timezone-shifting timestamp formatters', async () => {
  for (const [build, render] of [[buildFunnel, renderFunnel], [buildAdltv, renderAdltv]]) {
    const ctx = viewCtx(await build(serverCtx())); ctx.fmt.date = () => 'WRONG LOCAL DAY'; render(ctx);
    assert.match(ctx.root.innerHTML, /2026-08-24 to 2026-09-23/);
    assert.doesNotMatch(ctx.root.innerHTML, /WRONG LOCAL DAY/);
  }
});
await test('Ad LTV currency, source sort, search, and candidate selectors are functional', async () => {
  const ctx = viewCtx(await buildAdltv(serverCtx())); renderAdltv(ctx);
  ctx.events.get('[data-adltv-currency]:change')({ target: { value: 'EUR' } });
  assert.match(ctx.root.innerHTML, /EUR/); assert.doesNotMatch(ctx.root.innerHTML, /USD\s*140/);
  ctx.events.get('[data-adltv-search]:change')({ target: { value: 'does-not-exist' } });
  assert.match(ctx.root.innerHTML, /No lead rows match/);
  ctx.events.get('[data-adltv-order]:change')({ target: { value: 'repeat' } });
  assert.match(ctx.root.innerHTML, /value="repeat" selected/);
  ctx.events.get('[data-adltv-candidate]:change')({ target: { value: 'source:assist' } });
  assert.match(ctx.root.innerHTML, /value="source:assist" selected/);
});
await test('live evidence escapes names, IDs and errors, and never formats an unknown amount as zero USD', async () => {
  const evil = { ...attribution, conversions: [sale('<img src=x>', '<script>', now, null, { path: [touch('x', now, { name: '<img src=x>' })] })], errors: ['<script>alert(1)</script>'] };
  for (const [build, render] of [[buildFunnel, renderFunnel], [buildAdltv, renderAdltv]]) {
    const ctx = viewCtx(await build(serverCtx({ attribution: evil }))); render(ctx);
    assert.doesNotMatch(ctx.root.innerHTML, /<script>|<img/); assert.match(ctx.root.innerHTML, /&lt;img/);
    assert.doesNotMatch(ctx.root.innerHTML, /USD\s*0\.00/);
  }
});
await test('evidence caps omit entire paths, report omissions, and keep normal large blocks bounded', async () => {
  const conversions = Array.from({ length: 300 }, (_, i) => sale(`sale-${i}`, `lead-${i}`, now, 10, { path: Array.from({ length: 8 }, (_, j) => touch(`source-${i % 10}-${j}`, '2026-09-01')) }));
  const snap = { ...snapshot, attribution: { ...attribution, conversions } };
  for (const build of [buildFunnel, buildAdltv]) {
    const b = await build(serverCtx(snap)); assert.ok(Buffer.byteLength(JSON.stringify(b)) < 200 * 1024);
  }
  const f = await buildFunnel(serverCtx(snap)); assert.ok(f.journeys.every((j) => j.path.length === 8));
  assert.match(f.errors.join(' '), /complete conversion chains/);
});
await test('existing demos remain deterministic and render; manifests opt into both/live', async () => {
  const snap = buildDemoSnapshot();
  for (const [id, demo, render] of [['funnel', funnelDemo, renderFunnel], ['adltv', adltvDemo, renderAdltv]]) {
    const block = demo(snap); assert.deepEqual(block, demo(snap));
    const ctx = viewCtx(block, true); render(ctx); assert.match(ctx.root.innerHTML, /Demo feature/);
    const manifest = JSON.parse(await readFile(new URL(`../public/features/${id}/feature.json`, import.meta.url), 'utf8'));
    assert.equal(manifest.mode, 'both'); assert.equal(manifest.server, true); assert.deepEqual(manifest.tools, []);
    assert.deepEqual(validateManifest(manifest, id), []);
  }
});
console.log(`\n${count} journey analytics tests passed.`);

// Optional local browser QA; no package dependency or external requests required.
const browserModule = process.argv.find((arg) => arg.startsWith('--browser='))?.slice(10);
if (browserModule) {
  const { pathToFileURL } = await import('node:url');
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { chromium } = await import(pathToFileURL(browserModule).href);
  const base = process.argv.find((arg) => arg.startsWith('--url='))?.slice(6) || 'http://localhost:4321';
  const origin = new URL(base).origin;
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname), 'Browser fixture must use a local server');
  const browser = await chromium.launch({ headless: true });
  const output = await mkdtemp(join(tmpdir(), 'journey-analytics-qa-'));
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const fixture = { funnel: await buildFunnel(serverCtx()), adltv: await buildAdltv(serverCtx({ ...snapshot, attribution: { ...attribution, history } })) };
    fixture.funnel.sources[0].name = 'A source with a deliberately long name to verify wrapping in narrow layouts';
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (url.pathname !== '/journey-feature-check') return route.continue();
      return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/features/funnel/style.css"><link rel="stylesheet" href="/features/adltv/style.css"><style>main{max-width:1200px;margin:0 auto;padding:20px;min-width:0}h1{font:500 16px var(--sans)}</style></head><body><main><h1>Synthetic validation fixture</h1><section id="fixture"></section></main><script type="module">
        import {render as funnel} from '/features/funnel/view.js';
        import {render as adltv} from '/features/adltv/view.js';
        import {fmt} from '/shared/metrics.js';
        const blocks=${JSON.stringify(fixture).replace(/</g, '\\u003c')};
        const feature=new URLSearchParams(location.search).get('feature');
        const esc=s=>String(s??'').replace(/[&<>\']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\':'&quot;',"'":'&#39;'}[c]));
        ({funnel,adltv})[feature]({root:document.getElementById('fixture'),block:blocks[feature],fmt,esc,kpis:rows=>rows.map(r=>'<div class="kpi"><div class="kpi-label">'+esc(r.label)+'</div><div class="kpi-value">'+esc(r.value)+'</div><div class="kpi-sub">'+esc(r.sub||'')+'</div></div>').join('')});
        document.body.dataset.ready='true';
      </script></body></html>` });
    });
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      for (const feature of ['funnel', 'adltv']) {
        await page.goto(`${base}/journey-feature-check?feature=${feature}`);
        await page.waitForSelector('body[data-ready=true]');
        await page.evaluate(() => document.fonts.ready);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
        assert.equal(overflow, false, `${feature} viewport ${viewport.width} must not overflow horizontally`);
        if (feature === 'funnel') {
          await page.locator('[data-funnel-kind]').selectOption('CALL');
          assert.match(await page.locator('.funnel-evidence-meta').innerText(), /Call call/);
          await page.locator('[data-funnel-kind]').selectOption('SALE');
          await page.locator('[data-funnel-sample]').selectOption('SALE:disregarded');
          assert.match(await page.locator('.funnel-chain .pill.warn').innerText(), /disregarded/i);
        } else {
          await page.locator('[data-adltv-search]').fill('does-not-exist');
          await page.locator('[data-adltv-search]').press('Tab');
          assert.match(await page.locator('.adltv-live').innerText(), /No lead rows match/);
          await page.locator('[data-adltv-search]').fill('');
          await page.locator('[data-adltv-search]').press('Tab');
          await page.locator('[data-adltv-currency]').selectOption('EUR');
          await page.locator('[data-adltv-currency]').selectOption('ALL');
        }
        await page.screenshot({ path: join(output, `${feature}-${viewport.width}.png`), fullPage: true });
      }
    }
    assert.deepEqual(errors, []);
    console.log(`Browser layouts and controls passed at 1440px and 390px. Screenshots: ${output}`);
  } finally { await browser.close(); }
}

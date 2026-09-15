/**
 * Feature unit tests — pure-function and view/server checks that need no
 * MCP and no KV. Same `check()` style as pipeline-test.mjs; exits 1 on any
 * failure.
 *
 *   node scripts/feature-unit-test.mjs
 *
 * Covers: the Scale Advisor curve normaliser against the REST-documented
 * shape, cacCeiling handling, the "tool did not answer" card, stale
 * labelling; Tracking Health's budget check, reply-shape tolerance and the
 * warnings pill; the template / funnel / adltv views against every block
 * state; the manifest rule for live features without a server step.
 */
import { buildDemoSnapshot } from '../public/demo.js';
import { fmt, formatCell } from '../public/shared/metrics.js';
import { validateManifest } from '../public/shared/features.js';
import { normalizeCurve, build as buildScale } from '../public/features/scale/server.js';
import { demo as scaleDemo } from '../public/features/scale/demo.js';
import { render as renderScale } from '../public/features/scale/view.js';
import { build as buildHealth } from '../public/features/health/server.js';
import { demo as healthDemo } from '../public/features/health/demo.js';
import { render as renderHealth } from '../public/features/health/view.js';
import { render as renderTemplate } from '../public/features/_template/view.js';
import { build as buildTemplate } from '../public/features/_template/server.js';
import { demo as templateDemo } from '../public/features/_template/demo.js';
import { render as renderFunnel } from '../public/features/funnel/view.js';
import { render as renderAdltv } from '../public/features/adltv/view.js';
import { demo as adltvDemo } from '../public/features/adltv/demo.js';

let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${extra}`}`);
  if (!ok) failures += 1;
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const stubRoot = () => ({ innerHTML: '', querySelectorAll: () => [], querySelector: () => null, dataset: {}, hidden: false });
const snap = buildDemoSnapshot();
fmt.cents = false;

/** A view ctx like the app builds; `seen` collects every kpis() call so tests can read tile values. */
function viewCtx(id, block, extra = {}) {
  const seen = [];
  return {
    seen,
    id, manifest: { id, name: id, description: 'd' }, root: stubRoot(), snapshot: snap, block,
    demo: true, account: null, range: '30d', level: 'campaign', fmt, esc,
    kpis: (list) => { seen.push(...list); return list.map((k) => `<div class="kpi">${k.label}: ${k.value} ${k.sub || ''}</div>`).join(''); },
    formatCell, note: () => {}, openJourney: () => {}, api: async () => ({ status: 200, body: {} }), selectView: () => {},
    ...extra,
  };
}
const renders = (fn, ctx) => { try { fn(ctx); return null; } catch (err) { return err; } };

/** A server ctx with a recording callTool; `reply` decides what each tool returns. */
function serverCtx({ reply = async () => ({}), timeLeft = 20000, env = {}, previous = null } = {}) {
  const calls = [];
  return {
    calls,
    id: 'x', manifest: {},
    callTool: async (name, args, opts) => { calls.push({ name, args, opts }); return reply(name, args); },
    callToolPaged: async (name, args, opts) => { calls.push({ name, args, opts }); return []; },
    snapshot: snap, previous, deadline: Date.now() + timeLeft, timeLeft: () => timeLeft,
    log: () => {}, env, now: new Date('2026-09-14T12:00:00Z'),
  };
}

// ---------------------------------------------------------------------------
console.log('\nScale Advisor: normalizeCurve against the documented response');
const REST_EXAMPLE = {
  id: '23851234567890123', level: 'SOURCE_LINK', name: 'YT-LongForm-Founder',
  startDate: '2020-05-12', endDate: '2020-08-10', attributionModel: 'FIRST_CLICK', daysSampled: 84,
  cacCeiling: 52.0, ceilingBasis: 'CALLER_PROVIDED', ltvWindow: null,
  curve: [
    { spendPerDay: 812.40, days: 28, newCustomers: 594, avgCac: 38.29, marginalCac: null },
    { spendPerDay: 1490.10, days: 28, newCustomers: 941, avgCac: 44.33, marginalCac: 54.68 },
    { spendPerDay: 2274.75, days: 28, newCustomers: 1088, avgCac: 58.54, marginalCac: 149.46 },
  ],
  saturationPoint: { efficientSpendPerDay: 1490.10, saturatedSpendPerDay: 2274.75, reason: 'MARGINAL_CAC_ABOVE_CEILING' },
  notes: [],
};
{
  const c = normalizeCurve(REST_EXAMPLE, { id: 'x', name: 'meta name', level: 'SOURCE_LINK' });
  check('documented curve parses to >= 2 points', c.points.length === 3, JSON.stringify(c.points));
  check('spend read from spendPerDay', c.points[0]?.spend === 812.4, String(c.points[0]?.spend));
  check('customers read from newCustomers', c.points[0]?.customers === 594, String(c.points[0]?.customers));
  check('avgCac / marginalCac read (null marginal kept null)', c.points[0]?.avgCac === 38.29 && c.points[0]?.marginalCac === null && c.points[1]?.marginalCac === 54.68, JSON.stringify(c.points));
  check('days per bucket kept', c.points[0]?.days === 28, String(c.points[0]?.days));
  check('saturation read from saturatedSpendPerDay', c.saturationSpend === 2274.75, String(c.saturationSpend));
  check('efficient spend read from efficientSpendPerDay', c.efficientSpend === 1490.1, String(c.efficientSpend));
  check('saturation reason kept', c.saturationReason === 'MARGINAL_CAC_ABOVE_CEILING', String(c.saturationReason));
  check('ceilingBasis, ltvWindow, cacCeiling kept', c.ceilingBasis === 'CALLER_PROVIDED' && c.ltvWindow === null && c.ceiling === 52, JSON.stringify([c.ceilingBasis, c.ltvWindow, c.ceiling]));
  check('name comes from the reply when present', c.name === 'YT-LongForm-Founder', c.name);
  check('daysSampled and attributionModel kept', c.daysSampled === 84 && c.attributionModel === 'FIRST_CLICK');
  const ltv = normalizeCurve({ ...REST_EXAMPLE, cacCeiling: 61.2, ceilingBasis: 'LTV_BREAKEVEN', ltvWindow: '90_days' }, { id: 'x', level: 'SOURCE_LINK' });
  check('LTV_BREAKEVEN + ltvWindow kept', ltv.ceilingBasis === 'LTV_BREAKEVEN' && ltv.ltvWindow === '90_days');
  const wrapped = normalizeCurve({ request_id: 'r', result: REST_EXAMPLE }, { id: 'x', level: 'SOURCE_LINK' });
  check('REST envelope { result } is unwrapped', wrapped.points.length === 3, String(wrapped.points.length));
  const nullSat = normalizeCurve({ ...REST_EXAMPLE, saturationPoint: null }, { id: 'x', level: 'SOURCE_LINK' });
  check('saturationPoint null -> saturationSpend null', nullSat.saturationSpend === null && nullSat.efficientSpend === null);
  const acct = normalizeCurve({ ...REST_EXAMPLE, name: null, level: 'ACCOUNT', cacCeiling: null, ceilingBasis: null, saturationPoint: null, notes: ['LTV_CEILING_UNAVAILABLE'] }, { id: '9001', name: 'Meta', level: 'ACCOUNT' });
  check('account level: null name falls back to meta, ceiling null, notes kept', acct.name === 'Meta' && acct.ceiling === null && acct.notes[0] === 'LTV_CEILING_UNAVAILABLE', JSON.stringify(acct));
  const legacy = normalizeCurve({ curve: [{ dailySpend: 20, averageCac: 46, marginalCac: 56, customers: 1 }, { dailySpend: 40, averageCac: 52, marginalCac: 72, customers: 2 }], saturationPoint: { dailySpend: 40 } }, { id: 'x', level: 'SOURCE_LINK' });
  check('legacy keys (dailySpend/averageCac/customers) still parse', legacy.points.length === 2 && legacy.points[1].spend === 40 && legacy.points[1].customers === 2 && legacy.saturationSpend === 40, JSON.stringify(legacy));
  const junk = normalizeCurve('nope', { id: 'x', level: 'SOURCE_LINK' });
  check('non-object reply -> empty points, no throw', Array.isArray(junk.points) && junk.points.length === 0);
}

console.log('\nScale Advisor: build(ctx) request + budget rules');
{
  const c1 = serverCtx({ reply: async () => REST_EXAMPLE });
  const out = await buildScale(c1);
  const acctReq = c1.calls.find((c) => c.args.request.level === 'ACCOUNT')?.args.request;
  check('account call omits cacCeiling when HYROS_CAC_CEILING is unset', acctReq && !('cacCeiling' in acctReq), JSON.stringify(acctReq));
  check('every call uses a timeout <= 15 s', c1.calls.every((c) => (c.opts?.timeoutMs ?? 0) > 0 && c.opts.timeoutMs <= 15000), JSON.stringify(c1.calls.map((c) => c.opts)));
  check('block carries checkedAt (ISO) and window', /^\d{4}-\d{2}-\d{2}T/.test(out.checkedAt || '') && out.window?.start && out.window?.end, JSON.stringify([out.checkedAt, out.window]));
  check('one curve per call', Array.isArray(out.curves) && out.curves.length === c1.calls.length);

  const c2 = serverCtx({ reply: async () => REST_EXAMPLE, env: { HYROS_CAC_CEILING: '85' } });
  await buildScale(c2);
  check('account call passes cacCeiling when the env value is a positive number', c2.calls.find((c) => c.args.request.level === 'ACCOUNT')?.args.request.cacCeiling === 85);
  check('ad-set calls never pass cacCeiling (HYROS derives the LTV break-even)', c2.calls.filter((c) => c.args.request.level === 'SOURCE_LINK').every((c) => !('cacCeiling' in c.args.request)));
  for (const bad of ['0', '-5', 'abc', '']) {
    const c3 = serverCtx({ reply: async () => REST_EXAMPLE, env: { HYROS_CAC_CEILING: bad } });
    await buildScale(c3);
    check(`HYROS_CAC_CEILING=${JSON.stringify(bad)} -> cacCeiling omitted`, !('cacCeiling' in c3.calls.find((c) => c.args.request.level === 'ACCOUNT').args.request));
  }

  const spent = serverCtx({ timeLeft: 0 });
  const skipped = await buildScale(spent);
  check('spent budget: zero MCP calls', spent.calls.length === 0, String(spent.calls.length));
  check('spent budget, no previous: bare { skipped } marker', JSON.stringify(skipped) === '{"skipped":"time budget"}', JSON.stringify(skipped));
  const prev = { window: { start: '2026-06-01', end: '2026-08-29' }, checkedAt: '2026-08-29T10:00:00Z', curves: [{ id: 'a', level: 'ACCOUNT', points: [] }], stale: true, skipped: 'time budget' };
  const spent2 = serverCtx({ timeLeft: 0, previous: prev });
  const reused = await buildScale(spent2);
  check('spent budget with previous data: previous block kept, marked stale', reused.stale === true && reused.skipped === 'time budget' && reused.curves?.length === 1 && reused.checkedAt === prev.checkedAt, JSON.stringify(reused));

  const failing = serverCtx({ reply: async () => { throw new Error('Non-JSON response (HTTP 404)'); } });
  const errs = await buildScale(failing);
  check('a failing tool lands inside each curve as { error }, never throws', errs.curves.length > 0 && errs.curves.every((c) => /HTTP 404/.test(c.error)), JSON.stringify(errs.curves[0]));
}

console.log('\nScale Advisor: view states');
{
  const demoBlock = scaleDemo(snap);
  check('demo block uses the documented ceilingBasis enum', demoBlock.curves.every((c) => [null, 'CALLER_PROVIDED', 'LTV_BREAKEVEN'].includes(c.ceilingBasis)), JSON.stringify([...new Set(demoBlock.curves.map((c) => c.ceilingBasis))]));
  check('demo block is deterministic', JSON.stringify(scaleDemo(snap)) === JSON.stringify(demoBlock));
  check('demo block has >= 2 points per curve and a checkedAt', demoBlock.curves.every((c) => c.points.length >= 2) && Boolean(demoBlock.checkedAt));

  const allErr = viewCtx('scale', { window: { start: 'a', end: 'b' }, curves: [
    { id: '9001', name: 'Meta', level: 'ACCOUNT', points: [], notes: [], error: 'Non-JSON response (HTTP 404)' },
    { id: 'as-1', name: 'Broad <b>x</b>', level: 'SOURCE_LINK', points: [], notes: [], error: 'Non-JSON response (HTTP 404)' },
  ] });
  const e1 = renders(renderScale, allErr);
  check('all curves errored: renders', !e1, e1?.message);
  check('all curves errored: one clear "did not answer" card naming the HTTP status', /did not answer the CAC curve tool/.test(allErr.root.innerHTML) && /HTTP 404/.test(allErr.root.innerHTML) && /HYROS support/.test(allErr.root.innerHTML), allErr.root.innerHTML.slice(0, 300));
  check('all curves errored: does not say "Not enough data yet"', !/Not enough data yet/.test(allErr.root.innerHTML));
  check('all curves errored: the card appears once, not per entity', (allErr.root.innerHTML.match(/did not answer the CAC curve tool/g) || []).length === 1);

  const stale = viewCtx('scale', { ...demoBlock, stale: true, skipped: 'time budget' });
  const e2 = renders(renderScale, stale);
  check('stale block renders and says the curves are from a previous refresh', !e2 && /previous/i.test(stale.root.innerHTML), e2?.message || stale.root.innerHTML.slice(0, 200));
  check('stale block shows the previous check time via fmt.datetime', stale.root.innerHTML.includes(esc(fmt.datetime(demoBlock.checkedAt))), fmt.datetime(demoBlock.checkedAt));

  const mixed = viewCtx('scale', { ...demoBlock, curves: [demoBlock.curves[0], { id: 'z', name: 'Z', level: 'SOURCE_LINK', skipped: 'time budget' }] });
  renderScale(mixed);
  check('"Entities analyzed" does not count per-curve { skipped }', mixed.seen.find((k) => k.label === 'Entities analyzed')?.value === fmt.int(1), JSON.stringify(mixed.seen));
  const full = viewCtx('scale', demoBlock);
  renderScale(full);
  check('ceilingBasis and ltvWindow shown on the cards', /ltv breakeven/i.test(full.root.innerHTML) && /90 days/i.test(full.root.innerHTML));

  for (const blk of [{ skipped: 'time budget' }, { error: 'boom' }, {}]) {
    const c = viewCtx('scale', blk);
    const e = renders(renderScale, c);
    check(`scale view tolerates ${JSON.stringify(blk)}`, !e && c.root.innerHTML.length > 0, e?.message);
  }
}

// ---------------------------------------------------------------------------
console.log('\nTracking Health: build(ctx)');
{
  const spent = serverCtx({ timeLeft: 0 });
  const out = await buildHealth(spent);
  check('spent budget: zero MCP calls (no hyros_get_domains before the first check)', spent.calls.length === 0, spent.calls.map((c) => c.name).join(','));
  check('spent budget, no previous: bare { skipped } marker', JSON.stringify(out) === '{"skipped":"time budget"}', JSON.stringify(out));
  const prev = { ...healthDemo(), checkedAt: '2026-08-29T10:00:00Z' };
  const reused = await buildHealth(serverCtx({ timeLeft: 0, previous: { ...prev, stale: true, skipped: 'time budget' } }));
  check('spent budget with previous data: previous block kept, marked stale', reused.stale === true && reused.checkedAt === prev.checkedAt && reused.domains.length === 3, JSON.stringify(reused).slice(0, 200));

  const ok = serverCtx({ reply: async (name, args) => {
    if (name === 'hyros_get_domains') return ['a.test', 'b.test'];
    if (name === 'hyros_assert_script_presence_on_domain') return Object.fromEntries(args.domains.map((d) => [d, 'SCRIPT_FOUND']));
    return { result: [{ adName: 'x', valid: true }] };
  } });
  const good = await buildHealth(ok);
  check('happy path: domains, scripts, no errors', good.domains.length === 2 && Object.keys(good.scripts).length === 2 && good.errors.length === 0, JSON.stringify(good));
  check('every call uses a timeout <= 15 s', ok.calls.every((c) => (c.opts?.timeoutMs ?? 0) > 0 && c.opts.timeoutMs <= 15000), JSON.stringify(ok.calls.map((c) => [c.name, c.opts])));

  const odd = serverCtx({ reply: async (name) => (name === 'hyros_get_domains' ? ['a.test'] : ['SCRIPT_FOUND']) });
  const shape = await buildHealth(odd);
  check('assert tool returning a non-map records "script: unexpected reply shape"', shape.errors.includes('script: unexpected reply shape'), JSON.stringify(shape.errors));
  check('...and scripts stays an empty map', JSON.stringify(shape.scripts) === '{}');
  const wrapped = serverCtx({ reply: async (name) => (name === 'hyros_get_domains' ? { result: ['a.test'] } : { result: { 'https://a.test/': 'SCRIPT_FOUND' } }) });
  const w = await buildHealth(wrapped);
  check('assert tool { result: map } is unwrapped', w.scripts['https://a.test/'] === 'SCRIPT_FOUND' && w.errors.length === 0, JSON.stringify(w));
}

console.log('\nTracking Health: view');
{
  const h = healthDemo();
  const withWarn = viewCtx('health', h, { snapshot: { ...snap, adAccounts: [{ id: '9006', name: 'Reddit <x>', type: 'REDDIT' }, { id: '9001', name: 'Meta', type: 'FACEBOOK' }],
    warnings: [{ adAccountId: '9006', name: 'Reddit <x>', type: 'REDDIT', level: null, error: 'no report level for REDDIT', kind: 'unsupported' }] } });
  const e = renders(renderHealth, withWarn);
  check('ad account in snapshot.warnings gets a pill with the warning kind', !e && /skipped: unsupported/.test(withWarn.root.innerHTML), e?.message || withWarn.root.innerHTML.slice(0, 200));
  check('warning pill and names are escaped', !/<x>/.test(withWarn.root.innerHTML) && /Reddit &lt;x&gt;/.test(withWarn.root.innerHTML));
  const noWarn = viewCtx('health', h, { snapshot: { ...snap, warnings: [] } });
  renderHealth(noWarn);
  check('no warnings -> no skipped pill', !/skipped:/.test(noWarn.root.innerHTML));
  for (const blk of [{ skipped: 'time budget' }, { error: 'boom' }, {}, { ...h, stale: true, skipped: 'time budget' }]) {
    const c = viewCtx('health', blk);
    const err = renders(renderHealth, c);
    check(`health view tolerates ${JSON.stringify(Object.keys(blk))}`, !err && c.root.innerHTML.length > 0, err?.message);
    if (blk.stale) check('health stale block says "previous"', /previous/i.test(c.root.innerHTML));
  }
}

// ---------------------------------------------------------------------------
console.log('\nTemplate, Funnel, Ad LTV: block states');
{
  const tDemo = templateDemo(snap);
  for (const blk of [{ skipped: 'time budget' }, { error: 'boom' }, {}, { ...tDemo, stale: true, skipped: 'time budget' }, tDemo]) {
    const c = viewCtx('my-feature', blk);
    const err = renders(renderTemplate, c);
    check(`template view tolerates ${JSON.stringify(Object.keys(blk))}`, !err && c.root.innerHTML.length > 0, err?.message);
    if (blk.stale) check('template stale block says "previous"', /previous/i.test(c.root.innerHTML));
    if (blk.error) check('template error block shows the error', /boom/.test(c.root.innerHTML));
    if (blk.skipped && !blk.stale) check('template skipped block names the reason', /time budget/.test(c.root.innerHTML));
  }
  const tSpent = serverCtx({ timeLeft: 0 });
  const tOut = await buildTemplate(tSpent);
  check('template server: zero calls + bare marker on a spent budget', tSpent.calls.length === 0 && tOut.skipped === 'time budget', JSON.stringify(tOut));

  for (const blk of [{ error: 'boom' }, { skipped: 'time budget' }, {}]) {
    const c = viewCtx('funnel', blk);
    const err = renders(renderFunnel, c);
    check(`funnel view tolerates ${JSON.stringify(blk)}`, !err && c.root.innerHTML.length > 0, err?.message);
  }
  const aDemo = adltvDemo(snap);
  const evil = { ...aDemo, rows: aDemo.rows.map((r, i) => (i === 0 ? { ...r, name: 'Top <img src=x onerror=alert(1)>', ltv60: 1e9 } : r)) };
  const a = viewCtx('adltv', evil);
  const aErr = renders(renderAdltv, a);
  const sub = a.seen.find((k) => k.label === 'Highest 60-day LTV')?.sub || '';
  check('adltv: KPI sub (top ad name) is escaped', !aErr && sub.includes('&lt;img') && !sub.includes('<img'), aErr?.message || sub);
  for (const blk of [{ error: 'boom' }, { skipped: 'time budget' }, {}]) {
    const c = viewCtx('adltv', blk);
    const err = renders(renderAdltv, c);
    check(`adltv view tolerates ${JSON.stringify(blk)}`, !err && c.root.innerHTML.length > 0, err?.message);
  }
}

// ---------------------------------------------------------------------------
console.log('\nManifest rule: live tabs need a server step');
{
  const base = { id: 'xx', name: 'X', tab: 'X', version: '1.0.0', description: 'd' };
  check('mode live without server is rejected (the tab could never show)', validateManifest({ ...base, mode: 'live', server: false, needs: ['ranges.30d'] }, 'xx').length > 0);
  check('mode both with demo but without server is rejected', validateManifest({ ...base, mode: 'both', demo: true, server: false, needs: ['ranges.30d'] }, 'xx').length > 0);
  check('mode both with demo + server is valid', validateManifest({ ...base, mode: 'both', demo: true, server: true }, 'xx').length === 0, validateManifest({ ...base, mode: 'both', demo: true, server: true }, 'xx').join('; '));
  check('mode demo without server is valid', validateManifest({ ...base, mode: 'demo', demo: true, server: false }, 'xx').length === 0);
}

console.log(failures ? `\n${failures} feature unit test(s) FAILED` : '\nAll feature unit tests passed.');
process.exit(failures ? 1 : 0);

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { summarize, paginationCoverage, compareSummaries, buildBrief, sanitizeBrief, exportBrief, HISTORY_LIMIT, ALERT_LIMIT, RULES, hash } from '../public/features/brief/model.js';
import { loadReadState, setReadState, isRead, filterAlerts } from '../public/features/brief/inbox.js';
import { build } from '../public/features/brief/server.js';
import { demo } from '../public/features/brief/demo.js';
import { render } from '../public/features/brief/view.js';
import { validateManifest } from '../public/shared/features.js';

const NOW = '2026-09-23T12:00:00.000Z';
const at = (hours) => new Date(Date.parse(NOW) + hours * 3600000).toISOString();
const snapshot = (hours = 0, totals = {}) => ({
  generatedAt: at(hours), account: { currency: 'USD', timezone: '+00:00', email: 'private-owner@example.test' },
  attributionModel: 'LAST_CLICK', settings: { windowDays: 7, leadStage: [] },
  ranges: { '7d': { start: '2026-09-17', end: '2026-09-23', totals: { cost: 500, totalRevenue: 2000, revenue: 1200, sales: 30, calls: 40, ...totals } } },
  health: {
    checkedAt: at(hours), checks: { domains: { status: 'ok' }, script: { status: 'ok' }, params: { status: 'ok' } },
    scripts: { 'https://private-site.test/': 'SCRIPT_FOUND' }, trackingParams: [], errors: [],
  },
  crm: { leads: [{ email: 'private-customer@example.test' }], sync: { truncated: { leads: false, sales: false } } },
  attribution: { coverage: { sampled: 30, withPaths: 30, complete: true, truncated: false } },
});
const withMissing = (hours = 0) => {
  const value = snapshot(hours);
  value.health.scripts['https://private-site.test/'] = 'SCRIPT_NOT_FOUND';
  return value;
};
const storage = () => {
  const values = new Map();
  return { values, getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
};
const stubRoot = () => ({ innerHTML: '', querySelector: () => null, querySelectorAll: () => [], hidden: false });
const viewCtx = (root, block, extra = {}) => ({ root, block, snapshot: {}, account: 'acc_one', demo: false, range: '30d', fmt: { datetime: (value) => value }, ...extra });
const rules = (block) => block.alerts.map((alert) => alert.rule);

test('server accepts Date, ISO and epoch now contexts with fresh-core timestamp fallback', async () => {
  for (const now of [new Date(NOW), NOW, Date.parse(NOW)]) {
    const core = snapshot(); delete core.generatedAt;
    const block = await build({ snapshot: core, previous: null, now, timeLeft: () => 500 });
    assert.equal(block.current.generatedAt, NOW);
    assert.equal(block.current.totalRevenue, 2000);
    assert.equal(block.current.range, '7d');
  }
  assert.equal((await build({ snapshot: snapshot(), now: at(1) })).checkedAt, NOW);
  assert.ok((await build({ snapshot: {}, now: 'invalid' })).error);
  assert.doesNotThrow(() => summarize(null, NOW));
});

test('previous is the brief block, keeps compact summary history, and is never mutated', async () => {
  const prior = buildBrief(snapshot());
  const encoded = JSON.stringify(prior);
  const next = await build({ snapshot: snapshot(1), previous: prior, now: at(1) });
  assert.equal(next.history.length, 2);
  assert.equal(next.history[1].generatedAt, NOW);
  assert.equal(JSON.stringify(prior), encoded);
  assert.equal(next.comparison.previousId, prior.current.id);
  assert.ok(!JSON.stringify(next).includes('private-owner'));
  assert.ok(!JSON.stringify(next).includes('ranges'));
});

test('same-window comparisons produce snapshot revisions including rebills', () => {
  const prior = buildBrief(snapshot());
  const next = buildBrief(snapshot(1, { totalRevenue: 2400, revenue: 1, cost: 600, calls: 45, sales: 35 }), prior);
  assert.equal(next.comparison.comparable, true);
  assert.equal(next.comparison.reason, 'same_window');
  assert.deepEqual(next.comparison.changes.totalRevenue, { delta: 400, percent: 20 });
  assert.equal(next.comparison.changes.cost.delta, 100);
  assert.equal(next.comparison.changes.calls.delta, 5);
  assert.equal(next.comparison.changes.sales.delta, 5);
});

test('changed rolling windows, currencies, models, settings, and unknown contexts block diffs', () => {
  const prior = buildBrief(snapshot());
  for (const [reason, mutate] of [
    ['rolling_window', (s) => { s.ranges['7d'].start = '2026-09-18'; s.ranges['7d'].end = '2026-09-24'; }],
    ['currency_changed', (s) => { s.account.currency = 'EUR'; }],
    ['model_changed', (s) => { s.attributionModel = 'FIRST_CLICK'; }],
    ['context_changed', (s) => { s.settings.windowDays = 30; }],
    ['context_unknown', (s) => { delete s.account.currency; }],
    ['context_unknown', (s) => { s.attributionModel = 'unrecognized'; }],
  ]) {
    const current = snapshot(1, { totalRevenue: 100 });
    mutate(current);
    const next = buildBrief(current, prior);
    assert.equal(next.comparison.comparable, false, reason);
    assert.equal(next.comparison.reason, reason);
    assert.equal(next.comparison.changes, null);
    assert.ok(!rules(next).includes('revenue-revision'));
  }
});

test('unknown revenue is never replaced by initial revenue, zero, or a performance alert', () => {
  const current = snapshot(1, { totalRevenue: null, revenue: 90000 });
  const block = buildBrief(current, buildBrief(snapshot()));
  assert.equal(block.current.totalRevenue, null);
  assert.equal(block.current.coverage.report, 'partial');
  assert.ok(block.current.coverage.unknownMetrics.includes('totalRevenue'));
  assert.equal(block.comparison.reason, 'incomplete');
  assert.ok(!rules(block).includes('revenue-below-spend'));
  assert.ok(!rules(block).includes('revenue-revision'));
  assert.ok(rules(block).includes('report-coverage'));
  assert.equal(buildBrief(snapshot(0, { totalRevenue: 0 })).current.totalRevenue, 0);
  assert.equal(buildBrief(snapshot(0, { totalRevenue: Infinity })).current.totalRevenue, null);
});

test('zero baselines and negative corrections never invent percentages', () => {
  const previous = summarize(snapshot(0, { calls: 0 }));
  const current = summarize(snapshot(1, { calls: 2 }));
  assert.deepEqual(compareSummaries(current, previous).changes.calls, { delta: 2, percent: null });
  assert.equal(compareSummaries(current, current).reason, 'clock');
});

test('pagination metadata stays compact, blocks partial comparisons, and omits cursors', () => {
  const metadata = paginationCoverage({ pagination: { pagesFetched: 2, rowsFetched: 250, totalCount: 900, nextCursor: 'PRIVATE-CURSOR', hasMore: true } });
  assert.deepEqual(metadata, { truncated: true, cursorPresent: true, pages: 2, sampled: 250, total: 900 });
  assert.ok(!JSON.stringify(metadata).includes('PRIVATE-CURSOR'));
  const current = snapshot(1);
  current.ranges['7d'].pagination = { nextPageId: 'PRIVATE-CURSOR', pages: 3 };
  const block = buildBrief(current, buildBrief(snapshot()));
  assert.equal(block.current.coverage.report, 'partial');
  assert.equal(block.comparison.reason, 'incomplete');
  assert.ok(rules(block).includes('report-coverage'));
  assert.equal(block.current.coverage.pagination.report.pages, 3);
  for (const value of [{ coverage: { complete: false } }, { sync: { truncated: { calls: true } } }, { pageInfo: { hasNextPage: true } }, { nextPageToken: 'secret' }]) assert.equal(paginationCoverage(value).truncated, true);
});

test('CRM and attribution truncation create coverage alerts without fabricating metric changes', () => {
  const current = snapshot(1);
  current.crm.sync.truncated.sales = true;
  current.attribution.coverage.truncated = true;
  const block = buildBrief(current, buildBrief(snapshot()));
  assert.equal(block.current.coverage.crm, 'partial');
  assert.equal(block.current.coverage.attribution, 'partial');
  assert.equal(block.current.coverage.report, 'complete');
  assert.equal(block.comparison.comparable, true);
  assert.ok(rules(block).includes('crm-coverage'));
  assert.ok(rules(block).includes('attribution-coverage'));
});

test('partial and skipped data cannot trigger efficiency alerts; range-specific warnings stay scoped', () => {
  const current = snapshot(1, { totalRevenue: 100 });
  current.ranges['7d'].skipped = 'time budget';
  let block = buildBrief(current);
  assert.equal(block.current.totalRevenue, null);
  assert.ok(!rules(block).includes('revenue-below-spend'));
  delete current.ranges['7d'].skipped;
  current.warnings = [{ range: '30d', level: 'adset', error: 'PRIVATE' }];
  assert.equal(buildBrief(current).current.coverage.report, 'complete');
  current.warnings[0].range = '7d';
  block = buildBrief(current);
  assert.equal(block.current.coverage.report, 'partial');
  assert.ok(!rules(block).includes('revenue-below-spend'));
});

test('performance findings require absolute thresholds and a minimum sales sample', () => {
  assert.ok(rules(buildBrief(snapshot(0, { cost: 500, totalRevenue: 100, sales: 10 }))).includes('revenue-below-spend'));
  assert.ok(!rules(buildBrief(snapshot(0, { cost: 500, totalRevenue: 100, sales: 9 }))).includes('revenue-below-spend'));
  assert.ok(!rules(buildBrief(snapshot(0, { cost: 50, totalRevenue: 10, sales: 20 }))).includes('revenue-below-spend'));
  const prior = buildBrief(snapshot());
  assert.ok(rules(buildBrief(snapshot(1, { totalRevenue: 1500 }), prior)).includes('revenue-revision'));
  assert.ok(!rules(buildBrief(snapshot(1, { totalRevenue: 1900 }), prior)).includes('revenue-revision'));
  assert.ok(!rules(buildBrief(snapshot(1, { totalRevenue: 1500, sales: 9 }), prior)).includes('revenue-revision'));
  const small = buildBrief(snapshot(0, { totalRevenue: 400 }));
  assert.ok(!rules(buildBrief(snapshot(1, { totalRevenue: 200 }), small)).includes('revenue-revision'));
  assert.match(RULES['revenue-below-spend'].message, /not a profit estimate/);
});

test('tracking findings require explicit fresh failures, with stable IDs independent of order', () => {
  const first = withMissing();
  first.health.scripts['https://another-private.test'] = 'SCRIPT_NOT_FOUND';
  first.health.trackingParams = [{ type: 'SEARCH', rows: [{ id: 'secret-ad', valid: false }, { id: 'valid-ad', valid: true }, { name: 'Missing you', status: 'UNKNOWN' }] }];
  const a = buildBrief(first);
  const second = structuredClone(first);
  second.generatedAt = at(1); second.health.checkedAt = at(1);
  second.health.scripts = Object.fromEntries(Object.entries(second.health.scripts).reverse());
  second.health.trackingParams[0].rows.reverse();
  const b = buildBrief(second, a);
  assert.deepEqual(a.alerts.map((alert) => alert.id), b.alerts.map((alert) => alert.id));
  assert.ok(b.alerts.every((alert) => alert.change === 'ongoing'));
  assert.ok(!JSON.stringify(a).includes('secret-ad'));
  assert.equal(a.alerts.filter((alert) => alert.rule === 'script-missing').length, 2);
  assert.equal(a.alerts.filter((alert) => alert.rule === 'params-missing').length, 1);
  first.health.checks.script.stale = true;
  assert.ok(!rules(buildBrief(first)).includes('script-missing'));
  first.health.stale = true;
  assert.ok(!rules(buildBrief(first)).includes('params-missing'));
  assert.ok(rules(buildBrief(first)).includes('tracking-coverage'));
});

test('new issues require a completed baseline; reappearance changes the occurrence token', () => {
  const healthy = buildBrief(snapshot());
  const first = buildBrief(withMissing(1), healthy);
  const issue = first.alerts.find((alert) => alert.rule === 'script-missing');
  assert.equal(issue.change, 'new');
  assert.equal(first.newIssues, 1);
  const repeated = buildBrief(withMissing(2), first);
  assert.equal(repeated.alerts[0].readToken, issue.readToken);
  assert.equal(repeated.alerts[0].change, 'ongoing');
  const clear = buildBrief(snapshot(3), repeated);
  const recurrence = buildBrief(withMissing(4), clear).alerts[0];
  assert.equal(recurrence.id, issue.id);
  assert.notEqual(recurrence.readToken, issue.readToken);
  const incomplete = snapshot(); delete incomplete.health;
  assert.equal(buildBrief(withMissing(1), buildBrief(incomplete)).alerts.find((alert) => alert.rule === 'script-missing').change, 'observed');
});

test('history deduplicates retries, caps at 14, and ignores out-of-order snapshots', () => {
  let block = null;
  for (let index = 0; index < 25; index += 1) block = buildBrief(snapshot(index), block);
  assert.equal(block.history.length, HISTORY_LIMIT);
  assert.equal(new Set(block.history.map((entry) => entry.id)).size, HISTORY_LIMIT);
  assert.equal(block.history[0].generatedAt, at(24));
  assert.equal(block.history.at(-1).generatedAt, at(11));
  const retry = buildBrief(snapshot(24), block);
  assert.equal(retry.history.length, HISTORY_LIMIT);
  assert.equal(retry.comparison.previousGeneratedAt, at(23));
  const late = buildBrief(snapshot(20), block);
  assert.equal(late.stale, true);
  assert.equal(late.current.generatedAt, at(24));
});

test('maximum history and alert counts stay below 200 KB with arbitrary raw source text', () => {
  let block = null;
  for (let index = 0; index < 16; index += 1) {
    const current = snapshot(index);
    current.health.scripts = Object.fromEntries(Array.from({ length: 150 }, (_, n) => ['https://private-' + n + '.test/' + 'x'.repeat(2000), 'SCRIPT_NOT_FOUND']));
    block = buildBrief(current, block);
  }
  assert.equal(block.alerts.length, ALERT_LIMIT);
  assert.equal(block.alertCount, 150);
  assert.equal(block.alertsTruncated, true);
  assert.equal(block.history.length, HISTORY_LIMIT);
  assert.ok(new TextEncoder().encode(JSON.stringify(block)).length < 200 * 1024);
  assert.ok(!JSON.stringify(block).includes('private-'));
});

test('read state stays within the account and demo scope, and changed evidence returns unread', () => {
  const store = storage();
  const issue = buildBrief(withMissing()).alerts[0];
  assert.equal(setReadState('acc_one', false, issue, true, store), true);
  assert.equal(isRead(issue, loadReadState('acc_one', false, store)), true);
  assert.equal(isRead(issue, loadReadState('acc_two', false, store)), false);
  assert.equal(isRead(issue, loadReadState('acc_one', true, store)), false);
  assert.equal(isRead({ ...issue, readToken: 'read-12345678' }, loadReadState('acc_one', false, store)), false);
  assert.equal(setReadState('acc_one', false, issue, false, store), true);
  assert.equal(isRead(issue, loadReadState('acc_one', false, store)), false);
  assert.equal(setReadState(null, false, issue, true, store), false);
  assert.equal(setReadState(null, true, issue, true, store), true);
  const broken = { getItem() { throw new Error(); }, setItem() { throw new Error(); } };
  assert.deepEqual(loadReadState('acc_one', false, broken), {});
  assert.equal(setReadState('acc_one', false, issue, true, broken), false);
});

test('read journal is bounded and alert filters combine severity with read status', () => {
  const store = storage();
  for (let index = 0; index < 420; index += 1) setReadState('acc_one', false, { id: 'alert-' + hash(index), readToken: 'read-' + hash('read-' + index) }, true, store);
  assert.equal(Object.keys(loadReadState('acc_one', false, store)).length, 400);
  const alerts = buildBrief(withMissing()).alerts;
  const read = { [alerts[0].id]: alerts[0].readToken };
  assert.equal(filterAlerts(alerts, read, { severity: 'high', status: 'read' }).length, 1);
  assert.equal(filterAlerts(alerts, read, { status: 'unread' }).length, 0);
});

test('sanitized export whitelists aggregates and never exposes raw strings from injected metadata', () => {
  const current = withMissing();
  current.ranges['7d'].pagination = { nextCursor: 'PRIVATE-CURSOR' };
  current.warnings = [{ level: 'adset', kind: 'error', error: 'PRIVATE-ERROR' }];
  current.settings.leadStage = ['PRIVATE-STAGE'];
  const block = buildBrief(current);
  block.apiKey = 'PRIVATE-KEY'; block.email = 'private@example.test';
  block.current.name = 'PRIVATE-NAME'; block.current.coverage.raw = 'PRIVATE-COVERAGE';
  block.alerts[0].title = 'PRIVATE-TITLE'; block.alerts[0].evidence.email = 'private@example.test';
  block.comparison.private = 'PRIVATE-DIFF';
  block.delivery = { configured: true, email: 'private@example.test' };
  const output = exportBrief(block);
  const encoded = JSON.stringify(output);
  assert.ok(!/PRIVATE-|@|private-site|private-owner|private-customer/.test(encoded));
  assert.equal(output.redacted, true);
  assert.equal(output.delivery.configured, false);
  assert.equal(output.delivery.email, false);
  assert.equal(output.delivery.slack, false);
  assert.ok(output.history.every((entry) => entry.comparison));
  assert.ok(sanitizeBrief({ alerts: [{ id: 'alert-12345678', rule: 'toString' }] }).alerts.length === 0);
});

test('demo is deterministic and feature manifest declares no server tools', async () => {
  assert.deepEqual(demo(snapshot()), demo(snapshot()));
  assert.equal(demo(snapshot()).demo, true);
  assert.equal(demo(snapshot()).history.length, 4);
  assert.equal(demo(snapshot()).current.calls, snapshot().ranges['7d'].totals.calls);
  assert.equal(demo(snapshot()).current.sales, snapshot().ranges['7d'].totals.sales);
  const manifest = JSON.parse(await readFile(new URL('../public/features/brief/feature.json', import.meta.url), 'utf8'));
  assert.deepEqual(validateManifest(manifest, 'brief'), []);
  assert.deepEqual(manifest.tools, []);
  assert.equal(manifest.mode, 'both');
});

test('server makes no external calls and preserves previous state on an exhausted budget', async () => {
  const prior = buildBrief(snapshot());
  let calls = 0;
  const base = { snapshot: snapshot(1), previous: { ...prior, error: 'PRIVATE-OLD-ERROR' }, now: at(1), callTool() { calls += 1; } };
  const fresh = await build({ ...base, timeLeft: () => 100 });
  assert.equal(fresh.error, undefined);
  const stale = await build({ ...base, timeLeft: () => 0 });
  assert.equal(stale.stale, true);
  assert.equal(stale.current.generatedAt, NOW);
  assert.ok(!JSON.stringify(stale).includes('PRIVATE-OLD-ERROR'));
  assert.deepEqual(await build({ ...base, previous: null, timeLeft: () => 0 }), { skipped: 'time budget' });
  assert.equal(calls, 0);
});

test('view handles every block state and missing fake DOM methods, without API calls', () => {
  let calls = 0;
  for (const block of [null, {}, { skipped: 'time budget' }, { error: 'PRIVATE-ERROR' }, { ...buildBrief(snapshot()), stale: true, skipped: 'time budget' }, demo(snapshot())]) {
    for (const root of [stubRoot(), { innerHTML: '' }]) {
      render(viewCtx(root, block, { demo: Boolean(block?.demo), api: () => { calls += 1; } }));
      assert.match(root.innerHTML, /Daily Brief/);
      assert.match(root.innerHTML, /Email and Slack delivery: not configured/);
      assert.ok(!root.innerHTML.includes('PRIVATE-ERROR'));
      if (block?.stale) assert.match(root.innerHTML, /previous/);
    }
  }
  assert.equal(calls, 0);
  const live = stubRoot(); render(viewCtx(live, demo(snapshot())));
  assert.match(live.innerHTML, /No daily brief/);
});

test('changed diagnostic evidence returns unread and truncated baselines cannot establish new issues', () => {
  const first = snapshot();
  first.health.trackingParams = [{ type: 'SEARCH', rows: [{ id: 'ad-one', valid: false, missing: ['gclid'] }] }];
  const previous = buildBrief(first);
  const second = structuredClone(first);
  second.generatedAt = at(1);
  second.health.trackingParams[0].rows[0].missing = ['utm_source'];
  const changed = buildBrief(second, previous);
  const a = previous.alerts.find((alert) => alert.rule === 'params-missing');
  const b = changed.alerts.find((alert) => alert.rule === 'params-missing');
  assert.equal(a.id, b.id);
  assert.notEqual(a.readToken, b.readToken);
  assert.equal(b.change, 'updated');
  const truncated = { ...buildBrief(snapshot()), alertsTruncated: true };
  assert.equal(buildBrief(withMissing(1), truncated).alerts.find((alert) => alert.rule === 'script-missing').change, 'observed');
  const pageChange = snapshot(1);
  pageChange.health.pagination = { hasMore: true, pages: 2 };
  assert.equal(buildBrief(pageChange).current.coverage.tracking, 'partial');
});

test('inbox controls save read marks, filter alerts, show history, and download sanitized JSON', async () => {
  const nodes = new Map();
  const makeNode = (dataset = {}) => ({ dataset, checked: false, value: '', listeners: {}, addEventListener(name, fn) { this.listeners[name] = fn; } });
  for (const name of ['severity', 'status', 'export']) nodes.set('[data-brief-' + name + ']', makeNode());
  const prior = buildBrief(snapshot());
  const block = buildBrief(withMissing(1), prior);
  const tabs = [makeNode({ briefTab: 'inbox' }), makeNode({ briefTab: 'history' })];
  const read = makeNode({ briefRead: block.alerts[0].id });
  const review = makeNode({ briefReview: block.alerts[0].rule });
  let clicked = false, blob, name, selected;
  const store = storage();
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: store } });
  const link = { click() { clicked = true; name = this.download; }, remove() {} };
  const root = {
    innerHTML: '',
    querySelector: (selector) => nodes.get(selector) || null,
    querySelectorAll: (selector) => selector === '[data-brief-tab]' ? tabs : selector === '[data-brief-read]' ? [read] : selector === '[data-brief-review]' ? [review] : [],
    ownerDocument: { body: { appendChild() {} }, createElement: () => link,
      defaultView: { URL: { createObjectURL: (value) => { blob = value; return 'blob:brief-test'; }, revokeObjectURL() {} } },
    },
  };
  try {
    const context = viewCtx(root, block, { selectView: (value) => { selected = value; } });
    render(context);
    tabs[1].listeners.click();
    assert.match(root.innerHTML, /Snapshot History/);
    assert.match(root.innerHTML, /Same-window snapshot revision/);
    tabs[0].listeners.click();
    review.listeners.click();
    assert.equal(selected, 'health');
    read.checked = true; read.listeners.change();
    assert.equal(isRead(block.alerts[0], loadReadState('acc_one', false, store)), true);
    nodes.get('[data-brief-status]').listeners.change({ target: { value: 'unread' } });
    assert.match(root.innerHTML, /No alerts match these filters/);
    nodes.get('[data-brief-export]').listeners.click();
    assert.equal(clicked, true);
    assert.equal(name, 'daily-brief-2026-09-23.json');
    const exported = JSON.parse(await blob.text());
    assert.equal(exported.redacted, true);
    assert.equal(exported.history.length, 2);
    assert.ok(!JSON.stringify(exported).includes('private'));
    assert.ok(!JSON.stringify(exported).includes('acc_one'));
    assert.equal(exported.delivery.configured, false);
    const staleHandler = read.listeners.change;
    render(viewCtx(root, block, { account: 'acc_two' }));
    const before = [...store.values];
    read.checked = false; staleHandler();
    assert.deepEqual([...store.values], before);
  } finally {
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow);
    else delete globalThis.window;
  }
});

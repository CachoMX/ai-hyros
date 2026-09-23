import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isCron } from '../api/_auth.js';
import {
  createRefreshHandler, refreshAccount, cronTargets, webhookCronTargets, snapshotFreshForWebhook,
} from '../api/refresh.js';
import {
  acceptWebhookEvent, readWebhookDirty, clearWebhookDirty, webhookKeys,
  ACCEPT_EVENT_SCRIPT, READ_DIRTY_SCRIPT, CLEAR_DIRTY_SCRIPT,
} from '../api/_webhook.js';
import { CRON_BUDGET_MS, CRON_MIN_ACCOUNT_MS, REFRESH_BUDGET_MS } from '../api/_budget.js';

const NOW = Date.parse('2026-09-23T12:00:00Z');
const ACCOUNT = 'acc_012345abcdef';
const OTHER = 'acc_abcdef012345';
const CLIENT = 'cli_abcdef012345';
const MARKER = '01234567-89ab-4def-8123-456789abcdef';
const SETTINGS = JSON.stringify({
  [ACCOUNT]: { subscriptionId: 'sub-one', secretKey: 'synthetic-webhook-secret' },
  [OTHER]: { subscriptionId: 'sub-two', secretKey: 'another-synthetic-secret' },
  [CLIENT]: { subscriptionId: 'sub-client', secretKey: 'synthetic-client-secret' },
});
const account = (id, lastRefresh, extra = {}) => ({ id, lastRefresh, status: 'APPROVED', keyStatus: 'ok', ...extra });
const response = () => ({
  code: 200, body: null,
  status(code) { this.code = code; return this; },
  json(body) { this.body = body; return this; },
  setHeader() {},
});
const request = (url = '/api/refresh', headers = { 'x-report-key': 'unit-password' }) => ({
  method: 'POST', url, headers: { host: 'test.local', ...headers },
});
const cronRequest = (url = '/api/refresh') => request(url, { authorization: 'Bearer unit-cron' });

function snapshot(at = NOW) {
  const stamp = new Date(at).toISOString();
  return {
    origin: 'mcp', generatedAt: stamp, warnings: [], sourcesTruncated: false,
    adAccounts: [], sourceCount: 0, settings: {}, templateVersion: 'test',
    ranges: Object.fromEntries(['today', 'yesterday', '7d', '30d'].map((name) => [name, {
      levels: { account: [], adset: [], ad: [] }, start: '2026-09-01', end: '2026-09-23',
    }])),
    crm: {
      leads: [], sales: [], calls: [], subscriptions: [],
      sync: { syncedAt: stamp, incremental: true, truncated: { leads: false, sales: false, calls: false, subscriptions: false } },
    },
    attribution: { checkedAt: stamp, conversions: [], errors: [], coverage: { complete: true, truncated: false } },
  };
}

function harness(overrides = {}, listed = [account(ACCOUNT, '2026-09-01')]) {
  let clock = NOW;
  const trace = [];
  const logs = [];
  const markers = new Map([[webhookKeys(ACCOUNT).dirty, MARKER]]);
  const receipts = new Set();
  const persisted = new Map();
  // Exercise the exported marker helpers and their exact EVAL command contracts.
  const kv = async ([operation, script, count, ...args]) => {
    assert.equal(operation, 'EVAL');
    if (script === READ_DIRTY_SCRIPT) {
      assert.equal(count, '1');
      return markers.has(args[0]) ? [1, markers.get(args[0])] : [0, ''];
    }
    if (script === CLEAR_DIRTY_SCRIPT) {
      assert.equal(count, '1');
      if (markers.get(args[0]) !== args[1]) return 0;
      markers.delete(args[0]);
      return 1;
    }
    assert.equal(script, ACCEPT_EVENT_SCRIPT);
    assert.equal(count, '2');
    const [receiptKey, dirtyKey, digest, , , marker] = args;
    const receipt = `${receiptKey}:${digest}`;
    if (receipts.has(receipt)) return 0;
    receipts.add(receipt);
    markers.set(dirtyKey, marker);
    return 1;
  };
  const deps = {
    webhookConfiguration: () => SETTINGS,
    now: () => clock,
    storeConfigured: () => true,
    readPrefs: async () => { trace.push('prefs'); return null; },
    readSnapshot: async (id) => persisted.get(id) || null,
    asAccount: async (id, fn) => { trace.push(`account:${id}`); return fn(); },
    buildSnapshot: async ({ budgetMs }) => { trace.push(['build', budgetMs]); return snapshot(clock); },
    writeSnapshot: async (value, id) => { trace.push('persist'); persisted.set(id, value); return true; },
    markKeyStatus: async (id, status) => { trace.push(['key', id, status]); },
    noteRefresh: async (id, ok) => { trace.push(['noted', id, ok]); },
    readWebhookDirty: async (id) => { trace.push(`read:${id}`); return readWebhookDirty(id, { kv }); },
    clearWebhookDirty: async (id, marker) => { trace.push(`clear:${id}`); return clearWebhookDirty(id, marker, { kv }); },
    logEvent: (event, fields) => { logs.push({ event, ...fields }); },
    isCron: (req) => req.headers.authorization === 'Bearer unit-cron',
    cronSecret: () => 'unit-cron',
    checkAccess: async (req) => { trace.push('access'); return { ok: req.headers['x-report-key'] === 'unit-password' }; },
    accountFromReq: async () => ACCOUNT,
    listAccounts: async () => structuredClone(listed),
    syncClients: async (id) => { trace.push(`sync:${id}`); return {}; },
    kvRaw: async () => { trace.push('lock'); return 'OK'; },
    ...overrides,
  };
  return {
    deps, trace, logs, markers, persisted, kv,
    advance(ms) { clock += ms; },
    marker(id = ACCOUNT) { return markers.get(webhookKeys(id).dirty); },
    mark(id = ACCOUNT, marker = MARKER) { markers.set(webhookKeys(id).dirty, marker); },
    async event(eventId = 'evt-new', id = ACCOUNT) {
      return acceptWebhookEvent(id, { subscriptionId: 'sub-one', eventId }, { kv });
    },
    async run(req = request()) {
      const res = response();
      await createRefreshHandler(deps)(req, res);
      return res;
    },
  };
}

await test('freshness requires complete current CRM, all attribution ranges and conversion paths', () => {
  assert.equal(snapshotFreshForWebhook(snapshot(), NOW, NOW), true);
  const mutations = [
    (s) => { s.origin = 'seed'; },
    (s) => { s.generatedAt = new Date(NOW - 1).toISOString(); },
    (s) => { s.generatedAt = new Date(NOW + 1).toISOString(); },
    (s) => { delete s.warnings; },
    (s) => { s.warnings.push({ kind: 'unsupported' }); },
    (s) => { s.sourcesTruncated = true; },
    (s) => { s.stale = true; },
    (s) => { s.crm.sync.stale = true; },
    (s) => { s.crm.sync.skipped = 'time budget'; },
    (s) => { s.crm.sync.syncedAt = new Date(NOW - 1).toISOString(); },
    (s) => { delete s.crm.sync.syncedAt; },
    (s) => { delete s.crm.sync.truncated; },
    (s) => { s.crm.error = 'failed'; },
    (s) => { s.ranges.today.skipped = 'time budget'; },
    (s) => { s.ranges['7d'].stale = true; },
    (s) => { s.ranges['30d'].warnings = ['incomplete']; },
    (s) => { delete s.ranges.yesterday; },
    (s) => { delete s.ranges['30d'].levels.ad; },
    (s) => { delete s.attribution; },
    (s) => { s.attribution.stale = true; },
    (s) => { s.attribution.skipped = 'time budget'; },
    (s) => { s.attribution.error = 'failed'; },
    (s) => { s.attribution.errors = ['CALL: timeout']; },
    (s) => { s.attribution.checkedAt = new Date(NOW - 1).toISOString(); },
    (s) => { s.attribution.coverage.complete = false; },
    (s) => { s.attribution.coverage.truncated = true; },
  ];
  for (const list of ['leads', 'sales', 'calls', 'subscriptions']) {
    mutations.push((s) => { s.crm.sync.truncated[list] = true; });
    mutations.push((s) => { delete s.crm[list]; });
  }
  for (const mutate of mutations) {
    const value = snapshot();
    mutate(value);
    assert.equal(snapshotFreshForWebhook(value, NOW, NOW), false);
  }
  assert.equal(snapshotFreshForWebhook(null, NOW, NOW), false);
  assert.equal(snapshotFreshForWebhook(snapshot(), NaN, NOW), false);
});

await test('manual refresh captures before build and clears only after durable complete persistence', async () => {
  const h = harness();
  const res = await h.run();
  assert.equal(res.code, 200);
  assert.equal(res.body.persisted, true);
  assert.equal(h.marker(), undefined);
  const readIndex = h.trace.indexOf(`read:${ACCOUNT}`);
  const buildIndex = h.trace.findIndex((entry) => Array.isArray(entry) && entry[0] === 'build');
  assert.ok(readIndex >= 0 && readIndex < buildIndex);
  assert.ok(h.trace.indexOf('persist') < h.trace.indexOf(`clear:${ACCOUNT}`));
  assert.ok(h.trace.includes('access'));
  assert.equal(res.body.budgetMs, REFRESH_BUDGET_MS);
});

await test('absent, invalid or unrelated webhook configuration performs no marker I/O and preserves manual refresh', async () => {
  for (const setting of [undefined, '', '{}', '{', JSON.stringify({ [OTHER]: { subscriptionId: 'sub-other', secretKey: 'synthetic' } })]) {
    const h = harness({ webhookConfiguration: () => setting });
    assert.equal((await h.run()).code, 200);
    assert.equal(h.marker(), MARKER);
    assert.equal(h.trace.some((entry) => typeof entry === 'string' && /^(read|clear):/.test(entry)), false);
    if (setting === '{}' || setting === '{') assert.ok(h.logs.some((entry) => entry.code === 'invalid_configuration'));
  }
});

await test('partial, warned, skipped and stale snapshots persist but retain the dirty marker', async () => {
  const changes = [
    (s) => { s.warnings.push({ kind: 'truncated' }); },
    (s) => { s.crm.sync.stale = true; },
    (s) => { s.crm.sync.truncated.leads = true; },
    (s) => { s.crm.sync.truncated.subscriptions = true; },
    (s) => { s.crm.sync.syncedAt = new Date(NOW - 1000).toISOString(); },
    (s) => { s.ranges.today.skipped = 'time budget'; },
    (s) => { s.attribution.skipped = 'time budget'; s.attribution.stale = true; },
    (s) => { s.attribution.coverage.truncated = true; },
    (s) => { delete s.attribution; },
  ];
  for (const change of changes) {
    const value = snapshot();
    change(value);
    const h = harness({ buildSnapshot: async () => value });
    const res = await h.run();
    assert.equal(res.code, 200);
    assert.equal(res.body.persisted, true);
    assert.equal(h.marker(), MARKER);
    assert.equal(h.trace.includes(`clear:${ACCOUNT}`), false);
    assert.ok(h.logs.some((entry) => entry.reason === 'incomplete_snapshot'));
  }
});

await test('failed build, failed durable write and absent storage never clear a marker', async () => {
  for (const overrides of [
    { buildSnapshot: async () => { throw new Error('synthetic build failure'); } },
    { writeSnapshot: async () => { throw new Error('synthetic persistence failure'); } },
    { writeSnapshot: async () => false },
    { storeConfigured: () => false },
  ]) {
    const h = harness(overrides);
    const res = await h.run();
    assert.ok(res.code === 502 || res.body.persisted === false);
    assert.equal(h.marker(), MARKER);
    assert.equal(h.trace.includes(`clear:${ACCOUNT}`), false);
  }
});

await test('marker storage failures warn with fixed fields and do not fail a manual snapshot', async () => {
  const privateText = 'secret=never-log-this private@example.test';
  for (const operation of ['readWebhookDirty', 'clearWebhookDirty']) {
    const h = harness({ [operation]: async () => { throw new Error(privateText); } });
    const res = await h.run();
    assert.equal(res.code, 200);
    assert.equal(res.body.persisted, true);
    assert.equal(h.marker(), MARKER);
    const warnings = h.logs.filter((entry) => entry.event === 'refresh.webhook_warning');
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].level, 'warning');
    assert.equal(warnings[0].code, 'storage_unavailable');
    assert.equal(JSON.stringify({ logs: h.logs, body: res.body }).includes(privateText), false);
    if (operation === 'readWebhookDirty') assert.equal(h.trace.includes(`clear:${ACCOUNT}`), false);
  }
});

await test('a new event during build, during persistence or just before CAS cannot be lost', async () => {
  for (const stage of ['buildSnapshot', 'writeSnapshot', 'clearWebhookDirty']) {
    const h = harness();
    const original = h.deps[stage];
    let newMarker;
    h.deps[stage] = async (...args) => {
      await h.event();
      newMarker = h.marker();
      return original(...args);
    };
    assert.equal((await h.run()).body.persisted, true);
    assert.notEqual(newMarker, MARKER);
    assert.equal(h.marker(), newMarker);
  }
});

await test('an event after an initially clean read remains pending; acknowledgements are awaited', async () => {
  const h = harness();
  h.markers.clear();
  h.deps.buildSnapshot = async () => { await h.event(); return snapshot(); };
  assert.equal((await h.run()).code, 200);
  assert.ok(h.marker());
  assert.equal(h.trace.includes(`clear:${ACCOUNT}`), false);
  const waiting = harness();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const clear = waiting.deps.clearWebhookDirty;
  waiting.deps.clearWebhookDirty = async (...args) => { await gate; return clear(...args); };
  let settled = false;
  const pending = waiting.run().then((value) => { settled = true; return value; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.ok(waiting.persisted.has(ACCOUNT));
  assert.equal(waiting.marker(), MARKER);
  release();
  assert.equal((await pending).code, 200);
});

await test('dirty priority keeps stale fallback, eligibility, unsupported-client skips and input ordering', () => {
  const listed = [
    account(OTHER, '2026-01-01'), account(ACCOUNT, '2026-09-20'),
    account('acc_never', null), account('acc_invalid', null, { keyStatus: 'invalid' }),
    account('acc_pending', null, { status: 'PENDING' }),
    account('acc_agency', '2026-05-01', { clientModeStatus: 'unsupported' }),
    account(CLIENT, null, { parentId: 'acc_agency' }),
  ];
  const before = structuredClone(listed);
  const dirtyAccounts = new Set([ACCOUNT, 'acc_invalid', 'acc_pending', CLIENT]);
  const result = cronTargets(listed, { dirtyAccounts });
  assert.deepEqual(result.accounts.map((a) => a.id), [ACCOUNT, 'acc_never', OTHER, 'acc_agency']);
  assert.deepEqual(result.skipped, [{ id: CLIENT, skipped: 'unsupported' }]);
  assert.deepEqual(cronTargets(listed, { dirtyAccounts, dirtyOnly: true }).accounts.map((a) => a.id), [ACCOUNT]);
  assert.deepEqual(cronTargets(listed).accounts.map((a) => a.id), ['acc_never', OTHER, 'acc_agency', ACCOUNT]);
  assert.deepEqual(listed, before);
  assert.deepEqual(cronTargets([account(ACCOUNT, '2026-09-01'), account(OTHER, '2026-01-01')], { dirtyAccounts: new Set([ACCOUNT, OTHER]) }).accounts.map((a) => a.id), [OTHER, ACCOUNT]);
});

await test('marker reads stay scoped; storage failure preserves daily fallback but skips dirty-only work', async () => {
  const listed = [account(ACCOUNT, '2026-09-01'), account(OTHER, '2026-01-01'), account('acc_unmapped', null), account(CLIENT, null, { keyStatus: 'invalid' })];
  const h = harness({ readWebhookDirty: async (id) => {
    h.trace.push(`read:${id}`);
    if (id === OTHER) throw new Error('upstream response must not escape');
    return MARKER;
  } });
  const normal = await webhookCronTargets(listed, h.deps);
  assert.deepEqual(normal.accounts.map((a) => a.id), [ACCOUNT, 'acc_unmapped', OTHER]);
  assert.deepEqual(h.trace, [`read:${OTHER}`, `read:${ACCOUNT}`]);
  const worker = await webhookCronTargets(listed, { ...h.deps, dirtyOnly: true });
  assert.deepEqual(worker.accounts.map((a) => a.id), [ACCOUNT]);
  assert.deepEqual(worker.skipped, [{ id: OTHER, skipped: 'webhook marker unavailable' }]);
});

await test('normal cron prioritizes dirty accounts and still refreshes clean fallback accounts', async () => {
  const listed = [account(OTHER, '2026-01-01'), account(ACCOUNT, '2026-09-01', { agency: true })];
  const h = harness({}, listed);
  const res = await h.run(cronRequest());
  assert.equal(res.code, 200);
  assert.equal(res.body.cron, true);
  assert.deepEqual(res.body.accounts.map((a) => a.id), [ACCOUNT, OTHER]);
  assert.ok(res.body.accounts.every((a) => a.ok && a.persisted));
  assert.ok(h.trace.includes(`sync:${ACCOUNT}`));
  assert.equal(h.marker(), undefined);
  assert.ok(h.trace.filter((entry) => Array.isArray(entry) && entry[0] === 'build').every((entry) => entry[1] === 120000));
});

await test('dirty-only worker touches only pending eligible accounts and does not discover agency clients', async () => {
  const listed = [account(OTHER, '2026-01-01'), account(ACCOUNT, '2026-09-01', { agency: true }), account(CLIENT, null, { status: 'PENDING' })];
  const h = harness({}, listed);
  h.mark(CLIENT);
  const res = await h.run(cronRequest('/api/refresh?dirty=1'));
  assert.equal(res.code, 200);
  assert.equal(res.body.dirtyOnly, true);
  assert.deepEqual(res.body.accounts.map((a) => a.id), [ACCOUNT]);
  assert.deepEqual(res.body.synced, []);
  assert.ok(!h.trace.some((entry) => typeof entry === 'string' && entry.startsWith('sync:')));
  assert.equal(h.marker(CLIENT), MARKER);
  assert.equal(h.persisted.has(OTHER), false);
  assert.equal((await h.run(cronRequest('/api/refresh?dirty=1'))).body.accounts.length, 0);
});

await test('worker rechecks before build when another worker has consumed the selected marker', async () => {
  const h = harness();
  let reads = 0;
  const read = h.deps.readWebhookDirty;
  h.deps.readWebhookDirty = async (id) => {
    if (++reads === 2) h.markers.clear();
    return read(id);
  };
  const res = await h.run(cronRequest('/api/refresh?dirty=1'));
  assert.deepEqual(res.body.accounts, [{ id: ACCOUNT, skipped: 'webhook already consumed' }]);
  assert.equal(h.persisted.size, 0);
});

await test('dirty-only requires a signed cron secret and preserves manual and unsigned-daily auth paths', async () => {
  const previousSecret = process.env.CRON_SECRET;
  try {
    process.env.CRON_SECRET = 'unit-cron';
    const h = harness({ isCron, cronSecret: () => process.env.CRON_SECRET });
    for (const headers of [{}, { authorization: 'Bearer wrong' }, { 'user-agent': 'vercel-cron/1.0' }]) {
      assert.equal((await h.run(request('/api/refresh?dirty=1', headers))).code, 401);
    }
    assert.equal((await h.run(request('/api/refresh?dirty=1'))).code, 403);
    assert.equal(h.persisted.size, 0);
    assert.equal(h.trace.some((entry) => typeof entry === 'string' && entry.startsWith('read:')), false);
    assert.equal((await h.run(cronRequest('/api/refresh?dirty=1'))).code, 200);
    assert.equal((await h.run(cronRequest(`/api/refresh?dirty=1&account=${ACCOUNT}`))).code, 400);
    delete process.env.CRON_SECRET;
    assert.equal((await h.run(request('/api/refresh?dirty=1', { 'user-agent': 'vercel-cron/1.0' }))).code, 403);
    assert.equal(h.trace.includes('lock'), false);
    assert.equal((await h.run(request('/api/refresh', { 'user-agent': 'vercel-cron/1.0' }))).code, 200);
    assert.ok(h.trace.includes('lock'));
    h.deps.kvRaw = async () => null;
    assert.equal((await h.run(request('/api/refresh', { 'user-agent': 'vercel-cron/1.0' }))).code, 429);
  } finally {
    if (previousSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousSecret;
  }
});

await test('dirty-only rejects absent configuration; daily cron remains usable without marker reads', async () => {
  const h = harness({ webhookConfiguration: () => undefined }, [account(ACCOUNT, '2026-09-01'), account(OTHER, '2026-01-01')]);
  assert.equal((await h.run(cronRequest('/api/refresh?dirty=1'))).code, 503);
  const res = await h.run(cronRequest());
  assert.equal(res.code, 200);
  assert.deepEqual(res.body.accounts.map((a) => a.id), [OTHER, ACCOUNT]);
  assert.equal(h.trace.some((entry) => typeof entry === 'string' && /^(read|clear):/.test(entry)), false);
});

await test('cron budgets skip remaining accounts without acknowledging their markers', async () => {
  const h = harness({}, [account(ACCOUNT, '2026-01-01'), account(OTHER, '2026-09-01')]);
  h.mark(OTHER);
  h.deps.buildSnapshot = async () => {
    const result = snapshot();
    h.advance(CRON_BUDGET_MS - CRON_MIN_ACCOUNT_MS + 1);
    return result;
  };
  const res = await h.run(cronRequest());
  assert.equal(res.body.accounts[0].persisted, true);
  assert.deepEqual(res.body.accounts[1], { id: OTHER, skipped: 'time budget' });
  assert.equal(h.marker(OTHER), MARKER);
  assert.equal(h.persisted.has(OTHER), false);
});

await test('direct injectable refresh retains dirty state when freshness cannot be proven', async () => {
  const h = harness({ buildSnapshot: async () => snapshot(NOW - 1) });
  const result = await refreshAccount(ACCOUNT, [], REFRESH_BUDGET_MS, h.deps);
  assert.equal(result.persisted, true);
  assert.equal(h.marker(), MARKER);
});

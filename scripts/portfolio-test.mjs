import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPortfolioHandler } from '../api/portfolio.js';
import { summarizeAccount, connectionGate, currencyTotals, selectAccounts, portfolioCsv } from '../public/features/portfolio/model.js';
import { demo } from '../public/features/portfolio/demo.js';
import { build } from '../public/features/portfolio/server.js';
import { render } from '../public/features/portfolio/view.js';
import { validateManifest } from '../public/shared/features.js';

const NOW = '2026-09-23T12:00:00.000Z';
const a = { id: 'acc_000000000001', company: 'North Studio', kind: 'key', keyStatus: 'ok' };
const b = { id: 'acc_000000000002', company: 'Field Goods', kind: 'key', keyStatus: 'ok' };
const snapshot = (currency = 'USD', totals = {}) => ({
  origin: 'mcp', generatedAt: NOW, account: { currency, email: 'private@example.test' },
  ranges: { '30d': { start: '2026-08-25', end: '2026-09-23', totals: { cost: 100, revenue: 200, totalRevenue: 320, calls: 6, leads: 24, ...totals } } },
  crm: { leads: [{ email: 'customer@example.test' }] },
});
const row = (account = a, snap = snapshot(), options = {}) => summarizeAccount(account, snap, { now: NOW, ...options });
const resStub = () => ({ code: null, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(n) { this.code = n; return this; }, json(body) { this.body = body; return this; } });
const req = (method = 'GET', query = '') => ({ method, url: `/api/portfolio${query}`, headers: {} });
const minimalRoot = () => ({ innerHTML: '', querySelector: () => null, querySelectorAll: () => [], hidden: false });
const ctx = (root = minimalRoot(), extra = {}) => ({ root, account: a.id, range: '30d', demo: true, snapshot: {}, block: null, fmt: { datetime: (v) => v }, ...extra });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

test('summary uses total revenue including rebills and preserves unknown and zero metrics', () => {
  const summary = row();
  assert.deepEqual(summary.metrics, { spend: 100, totalRevenue: 320, roas: 3.2, calls: 6, leads: 24 });
  assert.equal(summary.status, 'fresh');
  assert.equal(row(a, snapshot('USD', { cost: 0 })).metrics.roas, null);
  assert.equal(row(a, snapshot('USD', { totalRevenue: null })).metrics.totalRevenue, null);
  assert.equal(row(a, snapshot('USD', { totalRevenue: null })).metrics.roas, null);
  assert.equal(row(a, snapshot('USD', { calls: 0, leads: null })).metrics.calls, 0);
  assert.equal(row(a, snapshot('USD', { calls: 0, leads: null })).metrics.leads, null);
  assert.equal(row(a, snapshot('USD', { cost: Infinity })).metrics.spend, null);
});

test('freshness, missing ranges, skipped zero reports, and errors have explicit states', () => {
  assert.equal(row(a, { ...snapshot(), generatedAt: '2026-09-20T12:00:00Z' }).status, 'stale');
  assert.equal(row(a, { ...snapshot(), generatedAt: null }).reason, 'time_unknown');
  assert.equal(row(a, { ...snapshot(), generatedAt: '2026-09-24T12:00:00Z' }).reason, 'time_unknown');
  assert.equal(row(a, null).status, 'not_connected');
  assert.equal(row({ ...a, lastError: 'private error' }, null).reason, 'refresh_failed_no_snapshot');
  assert.equal(row(a, snapshot(), { range: '7d' }).reason, 'range_missing');
  const skipped = snapshot();
  skipped.ranges['30d'].skipped = 'time budget';
  assert.equal(row(a, skipped).metrics, null);
  skipped.ranges['30d'].stale = true;
  assert.equal(row(a, skipped).reason, 'previous');
  assert.equal(row(a, skipped).metrics.totalRevenue, 320);
  assert.equal(row({ ...a, lastError: 'secret failure detail' }).status, 'error');
  assert.equal(row(a, { ...snapshot(), warnings: [{ level: 'adset', error: 'partial' }] }).partial, true);
  assert.equal(row(a, { ...snapshot(), warnings: [{ level: 'crm' }] }).partial, false);
  assert.equal(row(a, { ...snapshot(), origin: 'demo' }).metrics, null);
  assert.equal(row(a, { ...snapshot(), origin: 'seed' }).metrics, null);
});

test('currency totals deduplicate IDs, derive weighted ROAS, and never combine currencies', () => {
  const rows = [row(), row(b, snapshot('USD', { cost: 300, totalRevenue: 600, calls: 3, leads: 10 })), row({ ...a, id: 'acc_000000000003' }, snapshot('EUR')), row()];
  const totals = currencyTotals(rows);
  assert.equal(totals.length, 2);
  const usd = totals.find((t) => t.currency === 'USD');
  assert.equal(usd.spend, 400);
  assert.equal(usd.totalRevenue, 920);
  assert.equal(usd.roas, 2.3);
  assert.equal(usd.calls, 9);
  assert.equal(usd.leads, 34);
  assert.equal(usd.accounts, 2);
  assert.equal(totals.find((t) => t.currency === 'EUR').spend, 100);
  assert.deepEqual(currencyTotals([row(a, snapshot(null)), { ...row(), partial: true }, { ...row(), status: 'error' }]), []);
  assert.equal(currencyTotals([row(), row(b, snapshot('USD', { totalRevenue: null }))])[0].totalRevenue, null);
  assert.equal(currencyTotals([row(), row(b, snapshot('USD', { totalRevenue: null }))])[0].roas, null);
  const stale = { ...row(b), status: 'stale', window: { start: '2026-08-23', end: '2026-09-21' } };
  assert.equal(currencyTotals([row(), stale])[0].stale, 1);
  assert.equal(currencyTotals([row(), stale])[0].windows.length, 2);
});

test('permission gating covers client approval, agency health, missing parents, and client mode', () => {
  const agency = { ...a, agency: true, clientModeStatus: 'verified' };
  const client = { id: 'cli_000000000001', kind: 'client', parentId: a.id, status: 'APPROVED' };
  const map = new Map([[a.id, agency]]);
  assert.equal(connectionGate(client, map), null);
  assert.equal(connectionGate({ ...client, status: 'REVOKED' }, map).reason, 'access_pending');
  assert.equal(connectionGate(client, new Map()).reason, 'agency_missing');
  assert.equal(connectionGate(client, new Map([[a.id, { ...agency, keyStatus: 'invalid' }]])).reason, 'key_invalid');
  assert.equal(connectionGate(client, new Map([[a.id, { ...agency, clientModeStatus: 'unsupported' }]])).reason, 'client_unverified');
  assert.equal(connectionGate(client, new Map([[a.id, { ...agency, clientModeStatus: null }]])).reason, 'client_unverified');
  assert.equal(connectionGate({ ...a, keyStatus: 'invalid' }).reason, 'key_invalid');
});

test('route authenticates before registry access and refuses writes and invalid ranges', async () => {
  let reads = 0;
  const dependencies = { checkAccess: async () => ({ ok: false }), listAccounts: async () => { reads += 1; return [a]; }, readSnapshot: async () => { reads += 1; return snapshot(); }, storeConfigured: () => true, now: () => NOW };
  const denied = resStub();
  await createPortfolioHandler(dependencies)(req(), denied);
  assert.equal(denied.code, 401);
  assert.equal(reads, 0);
  const setup = resStub();
  await createPortfolioHandler({ ...dependencies, checkAccess: async () => ({ ok: false, setup: true }) })(req(), setup);
  assert.equal(setup.body.error, 'setup_required');
  const handler = createPortfolioHandler({ ...dependencies, checkAccess: async () => ({ ok: true }) });
  for (const method of ['POST', 'DELETE', 'PUT', 'PATCH', 'HEAD']) {
    const res = resStub(); await handler(req(method), res);
    assert.equal(res.code, 405); assert.equal(res.headers.Allow, 'GET');
  }
  const invalid = resStub(); await handler(req('GET', '?range=anything'), invalid);
  assert.equal(invalid.code, 400);
  assert.equal(reads, 0);
});

test('route reads only registered allowed snapshots and returns no PII, raw errors or keys', async () => {
  const agency = { ...a, agency: true, clientModeStatus: 'verified', keyEnc: 'ENCRYPTED-SECRET', email: 'owner@example.test' };
  const client = { id: 'cli_000000000001', kind: 'client', parentId: a.id, status: 'APPROVED', label: 'Private Name', email: 'client@example.test' };
  const revoked = { ...client, id: 'cli_000000000002', status: 'REVOKED' };
  const invalid = { ...b, keyStatus: 'invalid', keyError: 'RAW-SECRET' };
  const ids = [];
  const handler = createPortfolioHandler({ checkAccess: async () => ({ ok: true }), storeConfigured: () => true, now: () => NOW,
    listAccounts: async () => [agency, client, revoked, invalid, agency, { id: 'env' }, { id: '../../snapshot' }],
    readSnapshot: async (id) => { ids.push(id); return snapshot(); },
  });
  const res = resStub();
  await handler(req('GET', '?account=acc_999999999999'), res);
  assert.equal(res.code, 200);
  assert.deepEqual(ids.sort(), [a.id, client.id].sort());
  assert.equal(res.body.accounts.length, 4);
  assert.equal(res.body.accounts.find((r) => r.id === revoked.id).canOpen, false);
  assert.equal(res.body.accounts.find((r) => r.id === invalid.id).metrics, null);
  assert.equal(res.body.accounts.find((r) => r.id === client.id).label, 'Account 000001');
  assert.equal(res.headers['Cache-Control'], 'private, no-store');
  const serialized = JSON.stringify(res.body);
  for (const forbidden of ['@', 'ENCRYPTED-SECRET', 'RAW-SECRET', 'Private Name', 'keyEnc', 'crm', 'parentId', 'email']) assert.ok(!serialized.includes(forbidden), forbidden);
});

test('read errors and storage failures return safe unavailable states', async () => {
  const base = { checkAccess: async () => ({ ok: true }), storeConfigured: () => true, now: () => NOW, listAccounts: async () => [a], readSnapshot: async () => { throw new Error('private diagnostic'); } };
  const res = resStub(); await createPortfolioHandler(base)(req(), res);
  assert.equal(res.code, 200);
  assert.equal(res.body.accounts[0].reason, 'snapshot_failed');
  assert.equal(res.body.accounts[0].metrics, null);
  const unavailable = resStub();
  await createPortfolioHandler({ ...base, listAccounts: async () => { throw new Error('private diagnostic'); } })(req(), unavailable);
  assert.equal(unavailable.code, 503);
  assert.ok(!JSON.stringify(unavailable.body).includes('private diagnostic'));
  const noStore = resStub(); await createPortfolioHandler({ ...base, storeConfigured: () => false })(req(), noStore);
  assert.equal(noStore.code, 503);
  assert.equal(noStore.body.error, 'needs_storage');
});

test('filters and sorts respect currency boundaries and put unknown values last', () => {
  const rows = [row(), row(b, snapshot('EUR', { cost: 10000 })), { ...row({ ...b, id: 'acc_000000000003' }), status: 'error', metrics: null }];
  assert.equal(selectAccounts(rows, { currency: 'EUR' }).length, 1);
  assert.equal(selectAccounts(rows, { search: 'north' })[0].id, a.id);
  assert.equal(selectAccounts(rows, { status: 'error' }).length, 1);
  assert.equal(selectAccounts(rows)[0].status, 'error');
  assert.equal(selectAccounts(rows, { sort: 'spend' })[0].currency, 'EUR');
  assert.equal(selectAccounts(rows, { sort: 'roas' }).at(-1).metrics, null);
});

test('CSV exports only supplied rows, includes currency and caveats, and neutralizes formulas', () => {
  const csv = portfolioCsv([{ ...row(), label: '=HYPERLINK("test")' }], { range: '30d', demo: true });
  assert.ok(csv.includes('DEMO'));
  assert.ok(csv.includes('"USD"'));
  assert.ok(csv.includes('"Total revenue incl rebills"'));
  assert.ok(csv.includes('"\'=HYPERLINK(""test"")"'));
  assert.equal(csv.trim().split('\r\n').length, 2);
  assert.ok(!csv.includes('private@example.test'));
});

test('demo is deterministic with three clearly demo accounts and never calls live API', async () => {
  const fixture = demo(snapshot());
  assert.deepEqual(fixture, demo(snapshot()));
  assert.equal(fixture.accounts.length, 3);
  assert.ok(JSON.stringify(fixture).length < 200 * 1024);
  const root = minimalRoot();
  let calls = 0;
  await render(ctx(root, { block: fixture, api: async () => { calls += 1; } }));
  assert.equal(calls, 0);
  assert.ok(root.innerHTML.includes('Demo / North Studio'));
  assert.ok(root.innerHTML.includes('EUR'));
  assert.ok(root.innerHTML.includes('Stale'));
  const live = minimalRoot();
  await render(ctx(live, { demo: false, block: fixture }));
  assert.ok(!live.innerHTML.includes('Demo / North Studio'));
});

test('view handles every feature block state on minimal and absent DOM selectors', async () => {
  const manifest = JSON.parse(await readFile(new URL('../public/features/portfolio/feature.json', import.meta.url), 'utf8'));
  assert.deepEqual(validateManifest(manifest, 'portfolio'), []);
  for (const block of [null, {}, { skipped: 'time budget' }, { error: 'boom' }, { ...demo(snapshot()), stale: true, skipped: 'time budget' }]) {
    for (const root of [minimalRoot(), { innerHTML: '' }]) {
      await render(ctx(root, { block }));
      assert.ok(root.innerHTML.includes('Agency Portfolio'));
      if (block?.stale) assert.match(root.innerHTML, /previous/);
    }
  }
});

test('server is read-only, keeps a lightweight current block, and honours an exhausted budget', async () => {
  let calls = 0;
  const input = { snapshot: snapshot(), now: new Date(NOW), timeLeft: () => 1000, callTool: () => { calls += 1; }, previous: null };
  const fresh = await build(input);
  assert.equal(fresh.current['30d'].metrics.totalRevenue, 320);
  assert.deepEqual(fresh.accounts, []);
  assert.ok(!JSON.stringify(fresh).includes('@'));
  assert.deepEqual(await build({ ...input, timeLeft: () => 0 }), { skipped: 'time budget' });
  const reused = await build({ ...input, timeLeft: () => 0, previous: { ...fresh, error: 'old error', stale: true, skipped: 'old marker' } });
  assert.equal(reused.stale, true);
  assert.equal(reused.error, undefined);
  assert.equal(calls, 0);
});

test('late responses cannot overwrite a newer account, range, or demo render', async () => {
  const root = minimalRoot();
  const pending = deferred();
  const old = render(ctx(root, { demo: false, account: a.id, api: () => pending.promise }));
  await render(ctx(root, { demo: false, account: b.id, api: async () => ({ status: 200, body: { ok: true, range: '30d', accounts: [row(b)], checkedAt: NOW } }) }));
  pending.resolve({ status: 200, body: { ok: true, range: '30d', accounts: [row()], checkedAt: NOW } });
  await old;
  assert.ok(root.innerHTML.includes('Field Goods'));
  assert.ok(!root.innerHTML.includes('North Studio'));
  const next = deferred();
  const request = render(ctx(root, { demo: false, api: () => next.promise }));
  await render(ctx(root, { range: '7d', block: demo(snapshot()) }));
  next.resolve({ status: 200, body: { ok: true, range: '30d', accounts: [row()], checkedAt: NOW } });
  await request;
  assert.ok(root.innerHTML.includes('Demo / North Studio'));
  assert.ok(!root.innerHTML.includes('data-portfolio-account='));
});

test('API failures clear prior rows and a wrong-range payload cannot render', async () => {
  const block = await build({ snapshot: snapshot(), now: new Date(NOW), timeLeft: () => 1000 });
  for (const api of [async () => ({ status: 401, body: { error: 'unauthorized' } }), async () => { throw new Error('private secret'); }, async () => ({ status: 200, body: { ok: true, range: '7d', accounts: [row()] } })]) {
    const root = minimalRoot();
    await render(ctx(root, { demo: false, block, api }));
    assert.ok(!root.innerHTML.includes('Current account'));
    assert.ok(!root.innerHTML.includes('private secret'));
    assert.ok(!root.innerHTML.includes('North Studio'));
    assert.match(root.innerHTML, /Sign in again|Portfolio unavailable/);
  }
});

test('account buttons dispatch the parent event and CSV button downloads filtered rows', async () => {
  const nodes = new Map();
  const emitted = [];
  let blob;
  let clicked = false;
  let filename = '';
  const node = () => ({ innerHTML: '', value: '', dataset: {}, listeners: {}, addEventListener(name, fn) { this.listeners[name] = fn; } });
  for (const name of ['results', 'status', 'refresh', 'download', 'search', 'status-filter', 'currency', 'sort']) nodes.set('[data-portfolio-' + name + ']', node());
  const link = { click() { clicked = true; filename = this.download; }, remove() {} };
  let accountButton;
  const root = { innerHTML: '', hidden: false,
    querySelector: (selector) => nodes.get(selector) || null,
    querySelectorAll: () => {
      accountButton = node(); accountButton.dataset.portfolioAccount = a.id;
      return [accountButton];
    },
    dispatchEvent: (event) => { emitted.push(event); },
    ownerDocument: { body: { appendChild() {} }, createElement: () => link,
      defaultView: { CustomEvent, URL: { createObjectURL: (value) => { blob = value; return 'blob:portfolio-test'; }, revokeObjectURL() {} } },
    },
  };
  const viewCtx = ctx(root, { demo: false, api: async () => ({ status: 200, body: { ok: true, range: '30d', accounts: [row(), row(b)], checkedAt: NOW } }) });
  await render(viewCtx);
  accountButton.listeners.click();
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].type, 'hyros:account');
  assert.equal(emitted[0].bubbles, true);
  assert.deepEqual(emitted[0].detail, { accountId: a.id, view: 'warroom' });
  nodes.get('[data-portfolio-search]').listeners.input({ target: { value: 'North' } });
  nodes.get('[data-portfolio-download]').listeners.click();
  assert.equal(clicked, true);
  assert.equal(filename, 'portfolio-30d.csv');
  const content = await blob.text();
  assert.ok(content.includes('North Studio'));
  assert.ok(!content.includes('Field Goods'));
  assert.equal(nodes.get('[data-portfolio-download]').disabled, false);
  accountButton.dataset.portfolioAccount = 'acc_999999999999';
  accountButton.listeners.click();
  assert.equal(emitted.length, 1);
});

test('hidden and detached views discard asynchronous responses', async () => {
  for (const marker of [{ hidden: true }, { isConnected: false }]) {
    const root = minimalRoot();
    const pending = deferred();
    const request = render(ctx(root, { demo: false, api: () => pending.promise }));
    Object.assign(root, marker);
    pending.resolve({ status: 200, body: { ok: true, range: '30d', accounts: [row()], checkedAt: NOW } });
    await request;
    assert.ok(!root.innerHTML.includes('North Studio'));
  }
});

test('default endpoint uses real auth and registry helpers with GET-only mocked storage', async () => {
  const { hashPassword } = await import('../api/_setup.js');
  const { default: handler } = await import('../api/portfolio.js');
  // These are fixed test credentials. No .env files or external requests are used.
  process.env.KV_REST_API_URL = 'https://portfolio-store.invalid';
  process.env.KV_REST_API_TOKEN = 'portfolio-test-token';
  const values = new Map([
    ['aihyros:config', { passwordHash: hashPassword('portfolio-test-password') }],
    ['aihyros:accounts', { accounts: [a] }],
    [`aihyros:acct:${a.id}:snapshot`, snapshot()],
  ]);
  const originalFetch = globalThis.fetch;
  const commands = [];
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://portfolio-store.invalid');
    const command = JSON.parse(options.body);
    commands.push(command);
    assert.equal(command[0], 'GET');
    return { ok: true, json: async () => ({ result: values.has(command[1]) ? JSON.stringify(values.get(command[1])) : null }) };
  };
  try {
    const unauthorized = resStub(); await handler(req(), unauthorized);
    assert.equal(unauthorized.code, 401);
    assert.ok(!commands.some((command) => command[1].includes('snapshot')));
    const authorized = resStub();
    await handler({ ...req(), headers: { 'x-report-key': 'portfolio-test-password' } }, authorized);
    assert.equal(authorized.code, 200);
    assert.equal(authorized.body.accounts[0].metrics.totalRevenue, 320);
    assert.ok(commands.every((command) => command[0] === 'GET'));
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
  }
});

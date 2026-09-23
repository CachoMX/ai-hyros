import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer, get } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { createDataHandler } from '../api/data.js';
import { accountFromReq } from '../api/_accounts.js';
import { TEMPLATE_VERSION } from '../api/_version.js';

const MIB = 1024 * 1024;
const A = 'acc_000000000001';
const B = 'cli_000000000002';
const originalFetch = globalThis.fetch;
before(() => { globalThis.fetch = async () => { throw new Error('External requests are forbidden in response tests'); }; });
after(() => { globalThis.fetch = originalFetch; });

const snapshots = [
  { name: 'compressible', data: 'private-fixture-\u00e9\u6c34\ud83d\ude80'.repeat(550000) },
  { name: 'incompressible', data: randomBytes(9 * MIB).toString('base64') },
].map(({ name, data }) => ({ name, snapshot: {
  generatedAt: '2026-09-23T12:00:00.000Z',
  account: { email: `${name}@example.test`, currency: 'USD' },
  crm: { leads: [{ email: 'private-lead@example.test', notes: data }] },
  ranges: { '30d': { totals: { revenue: 100, cost: 0 } } },
} }));

const requestStub = (headers = {}, account = A) => ({ method: 'GET', url: `/api/data?account=${account}`, headers });
const responseStub = () => ({
  code: null, body: null, headers: {}, jsonCalls: 0,
  setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
  status(code) { this.code = code; return this; },
  json(body) { this.jsonCalls += 1; this.body = body; return this; },
});
const envelope = (account, snapshot, prefs = { account }, configured = true) => ({
  ok: true, templateVersion: TEMPLATE_VERSION, origin: snapshot ? 'kv' : 'none', account, prefs,
  capabilities: { mcpConfigured: Boolean(account), storeConfigured: configured }, snapshot,
});

function fixture(snapshot, overrides = {}) {
  const calls = { auth: 0, account: 0, configured: 0, snapshots: [], prefs: [] };
  const handler = createDataHandler({
    checkAccess: async () => { calls.auth += 1; return { ok: true }; },
    accountFromReq: async (req) => { calls.account += 1; return accountFromReq(req); },
    storeConfigured: () => { calls.configured += 1; return true; },
    readSnapshot: async (account) => { calls.snapshots.push(account); return snapshot; },
    readPrefs: async (account) => { calls.prefs.push(account); return { account }; },
    ...overrides,
  });
  return { handler, calls };
}

function assertPrivate(headers) {
  assert.equal(headers['cache-control'], 'private, no-store');
  const vary = headers.vary.toLowerCase().split(',').map((value) => value.trim());
  for (const name of ['authorization', 'x-report-key', 'accept-encoding']) assert.ok(vary.includes(name));
  assert.equal(new Set(vary).size, vary.length);
}

function assertNoLogs(t) {
  const spies = ['log', 'info', 'warn', 'error', 'debug'].map((name) => t.mock.method(console, name, () => {}));
  return () => { for (const spy of spies) assert.equal(spy.mock.callCount(), 0, 'response path must not log private data'); };
}

async function serve(t, handler, initialHeaders = {}) {
  const responses = [];
  const server = createServer((req, res) => {
    const record = { jsonCalls: 0, writes: [], backpressure: 0, error: null, completed: false };
    responses.push(record);
    for (const [name, value] of Object.entries(initialHeaders)) res.setHeader(name, value);
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => {
      record.jsonCalls += 1;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(body));
      return res;
    };
    const write = res.write;
    res.write = function (chunk, encoding, callback) {
      record.writes.push(Buffer.byteLength(chunk, typeof encoding === 'string' ? encoding : undefined));
      const ready = write.call(this, chunk, encoding, callback);
      if (!ready) record.backpressure += 1;
      return ready;
    };
    record.done = Promise.resolve().then(() => handler(req, res)).then(
      () => { record.completed = true; },
      (error) => { record.error = error; res.destroy(); },
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await Promise.all(responses.map((record) => record.done));
  });
  return { url: `http://127.0.0.1:${server.address().port}/api/data`, responses };
}

function download(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = get(url, { headers, agent: false }, async (response) => {
      try {
        const chunks = [];
        for await (const chunk of response) chunks.push(chunk);
        resolve({ code: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) });
      } catch (error) { reject(error); }
    });
    request.on('error', reject);
    request.setTimeout(10000, () => request.destroy(new Error('Local response timed out')));
  });
}

test('small responses preserve the legacy fake response .json contract', async () => {
  const snapshot = { account: { currency: 'USD' }, crm: { leads: [] } };
  const f = fixture(snapshot);
  const res = responseStub();
  assert.equal(await f.handler(requestStub({ 'accept-encoding': 'gzip' }), res), res);
  assert.equal(res.code, 200);
  assert.equal(res.jsonCalls, 1);
  assert.deepEqual(res.body, envelope(A, snapshot));
  assert.equal(res.headers['content-encoding'], undefined);
  assertPrivate(res.headers);
  assert.deepEqual(f.calls, { auth: 1, account: 1, configured: 1, snapshots: [A], prefs: [A] });
});

test('missing snapshots, accounts and storage preserve existing response shapes', async () => {
  for (const [account, configured, overrides] of [
    [A, true, {}],
    [null, true, { accountFromReq: async () => null }],
    [A, false, { storeConfigured: () => false }],
  ]) {
    const f = fixture(null, overrides);
    const res = responseStub();
    await f.handler(requestStub(), res);
    assert.deepEqual(res.body, envelope(account, null, account && configured ? { account } : null, configured));
    assert.deepEqual(f.calls.snapshots, account && configured ? [account] : []);
    assert.deepEqual(f.calls.prefs, account && configured ? [account] : []);
  }
});

test('denied, setup and unavailable auth return before any account or snapshot reads', async (t) => {
  const noLogs = assertNoLogs(t);
  for (const [access, code, error] of [
    [{ ok: false }, 401, 'unauthorized'],
    [{ ok: false, setup: true }, 401, 'setup_required'],
    [{ ok: false, unavailable: true }, 503, 'storage_unavailable'],
  ]) {
    const f = fixture(snapshots[0].snapshot, { checkAccess: async () => access });
    const server = await serve(t, f.handler);
    const out = await download(`${server.url}?account=${A}&key=private-key-fixture`, { 'accept-encoding': 'gzip' });
    assert.equal(out.code, code);
    assert.equal(JSON.parse(out.body).error, error);
    assert.equal(out.headers['content-encoding'], undefined);
    assertPrivate(out.headers);
    assert.deepEqual(f.calls, { auth: 0, account: 0, configured: 0, snapshots: [], prefs: [] });
    assert.equal(server.responses[0].jsonCalls, 1);
    assert.equal(server.responses[0].writes.length, 0);
  }
  noLogs();
});

for (const { name, snapshot } of snapshots) {
  for (const encoding of ['identity', 'gzip']) {
    test(`real HTTP round-trips >10 MiB ${name} JSON with ${encoding}`, { timeout: 20000 }, async (t) => {
      const noLogs = assertNoLogs(t);
      const f = fixture(snapshot);
      const server = await serve(t, f.handler, { Vary: 'Origin, authorization', 'Content-Length': '1', 'Content-Encoding': 'stale' });
      const expected = envelope(A, snapshot);
      const expectedBytes = Buffer.from(JSON.stringify(expected));
      assert.ok(expectedBytes.length > 10 * MIB);
      const out = await download(`${server.url}?account=${A}`, { 'accept-encoding': encoding });
      const record = server.responses[0];
      await record.done;
      assert.equal(out.code, 200);
      assertPrivate(out.headers);
      assert.ok(out.headers.vary.includes('Origin'));
      assert.equal(out.headers['content-type'], 'application/json; charset=utf-8');
      assert.equal(out.headers['content-length'], undefined);
      assert.equal(out.headers['content-encoding'], encoding === 'gzip' ? 'gzip' : undefined);
      assert.equal(out.headers['transfer-encoding'], 'chunked');
      const decoded = encoding === 'gzip' ? gunzipSync(out.body) : out.body;
      assert.ok(decoded.equals(expectedBytes), 'wire JSON bytes must match native serialization');
      assert.deepEqual(JSON.parse(decoded), expected);
      if (encoding === 'gzip') assert.ok(out.body.length < expectedBytes.length);
      if (name === 'incompressible') assert.ok(out.body.length > 4.5 * MIB, 'streaming must work even above the compressed platform limit');
      assert.equal(record.jsonCalls, 0);
      assert.ok(record.writes.length > 1);
      assert.ok(record.writes.every((bytes) => bytes <= 64 * 1024));
      if (encoding === 'identity') assert.ok(record.backpressure > 0);
      assert.equal(record.completed, true);
      assert.equal(record.error, null);
      assert.deepEqual(f.calls.snapshots, [A]);
      assert.deepEqual(f.calls.prefs, [A]);
      noLogs();
    });
  }
}

test('large response negotiation respects q=0, wildcard overrides and identity preferences', async (t) => {
  const snapshot = { padding: 'x'.repeat(MIB) };
  const server = await serve(t, fixture(snapshot).handler);
  for (const [accept, expectedEncoding, code = 200] of [
    [undefined, undefined], ['', undefined], ['br', undefined],
    ['gzip;q=0', undefined], ['GZip; Q=0.000', undefined],
    ['gzip;q=0, *;q=1', undefined], ['gzip;q=0, gzip;q=1', undefined],
    ['gzip;q=invalid', undefined], ['gzip;q=1.001', undefined],
    ['gzip;q=0.2, identity;q=0.8', undefined],
    ['gzip;q=0.8, identity;q=0.2', 'gzip'],
    ['br, GZip; Q=1.000', 'gzip'], ['*;q=1', 'gzip'],
    ['*;q=0, gzip;q=1', 'gzip'], ['identity;q=0, gzip;q=0.5', 'gzip'],
    ['*;q=0', undefined, 406], ['gzip;q=0, identity;q=0', undefined, 406],
  ]) {
    const out = await download(`${server.url}?account=${A}`, accept === undefined ? {} : { 'accept-encoding': accept });
    assert.equal(out.code, code, accept);
    assert.equal(out.headers['content-encoding'], expectedEncoding, accept);
    assertPrivate(out.headers);
    const body = JSON.parse(expectedEncoding ? gunzipSync(out.body) : out.body);
    assert.deepEqual(body, code === 200 ? envelope(A, snapshot) : { ok: false, error: 'encoding_not_acceptable' });
  }
});

test('UTF-8 byte size selects streaming even when the JSON character count is small', async (t) => {
  const snapshot = { padding: '\u6c34\ud83d\ude80'.repeat(160000), tail: '\ud800' };
  const json = JSON.stringify(envelope(A, snapshot));
  assert.ok(json.length < MIB);
  assert.ok(Buffer.byteLength(json) > MIB);
  const server = await serve(t, fixture(snapshot).handler);
  const out = await download(`${server.url}?account=${A}`);
  assert.ok(out.body.equals(Buffer.from(json)));
  assert.equal(server.responses[0].jsonCalls, 0);
});

test('concurrent account requests keep snapshots and preferences isolated', async (t) => {
  const accountSnapshots = new Map([[A, { account: A, padding: 'a'.repeat(MIB) }], [B, { account: B, padding: 'b'.repeat(MIB) }]]);
  const reads = [];
  const prefs = [];
  const f = fixture(null, {
    readSnapshot: async (account) => { reads.push(account); return accountSnapshots.get(account); },
    readPrefs: async (account) => { prefs.push(account); return { account }; },
  });
  const server = await serve(t, f.handler);
  const outputs = await Promise.all([A, B].map((account) => download(`${server.url}?account=${account}`, { 'accept-encoding': 'gzip' })));
  for (const [index, account] of [A, B].entries()) {
    assert.deepEqual(JSON.parse(gunzipSync(outputs[index].body)), envelope(account, accountSnapshots.get(account)));
  }
  assert.deepEqual(reads.sort(), [A, B]);
  assert.deepEqual(prefs.sort(), [A, B]);
});

test('preexisting wildcard Vary is preserved', async () => {
  const res = responseStub();
  res.getHeader = () => ['*'];
  await fixture(null).handler(requestStub(), res);
  assert.equal(res.headers.vary, '*');
});

test('client disconnect settles the pipeline without a second JSON response or logs', { timeout: 10000 }, async (t) => {
  const noLogs = assertNoLogs(t);
  const server = await serve(t, fixture(snapshots[1].snapshot).handler);
  await new Promise((resolve, reject) => {
    const request = get(`${server.url}?account=${A}`, { agent: false }, (response) => {
      response.once('data', () => response.destroy());
      response.once('close', resolve);
      response.on('error', reject);
    });
    request.on('error', reject);
  });
  const record = server.responses[0];
  await record.done;
  assert.ok(record.error);
  assert.ok(['ERR_STREAM_PREMATURE_CLOSE', 'ECONNRESET'].includes(record.error.code));
  assert.equal(record.jsonCalls, 0);
  assert.equal(record.completed, false);
  noLogs();
});

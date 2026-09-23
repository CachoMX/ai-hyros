import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { encodeSnapshot, decodeSnapshot, SNAPSHOT_MAX_JSON_BYTES, SNAPSHOT_MAX_STORED_BYTES } from '../api/_snapshot-codec.js';
import { writeSnapshot, readSnapshot } from '../api/_store.js';
import { createRefreshHandler } from '../api/refresh.js';

const ACCOUNT = 'acc_012345abcdef';
const OTHER = 'acc_abcdef012345';
const KEY = `aihyros:acct:${ACCOUNT}:snapshot`;
const mem = new Map();
const calls = [];
const events = [];
const originalFetch = globalThis.fetch;
const originalError = console.error;
let fault = null;
process.env.KV_REST_API_URL = 'https://snapshot.example.test';
process.env.KV_REST_API_TOKEN = 'fixture-private-token';
console.error = (...parts) => events.push(parts.join(' '));
globalThis.fetch = async (url, options) => {
  assert.equal(url, process.env.KV_REST_API_URL, 'all requests must use the mock store');
  const command = JSON.parse(options.body);
  calls.push(command);
  const failed = fault?.(command);
  if (failed) return new Response(JSON.stringify({ error: failed.message }), { status: failed.status });
  assert(Buffer.byteLength(options.body) < 10_000_000, 'the complete REST request stays below the provider limit');
  const [op, key, value] = command;
  if (op === 'GET') return new Response(JSON.stringify({ result: mem.get(key) ?? null }));
  assert.equal(op, 'SET');
  mem.set(key, value);
  return new Response(JSON.stringify({ result: 'OK' }));
};
const snapshot = {
  schema: 2, generatedAt: '2026-09-23T12:00:00.000Z', templateVersion: 'test', origin: 'mcp',
  adAccounts: [], sourceCount: 0, settings: {}, warnings: [], ranges: {},
  crm: { leads: [], sales: [], calls: [], subscriptions: [], totals: { income: 123.45 } },
};

try {
  const small = await encodeSnapshot(snapshot);
  assert.equal(small.encoding, 'json');
  assert.equal(small.value, JSON.stringify(snapshot));
  assert.deepEqual(await decodeSnapshot(small.value), snapshot);
  mem.set(KEY, small.value);
  assert.deepEqual(await readSnapshot(ACCOUNT), snapshot);
  assert.equal(await readSnapshot(OTHER), null);
  console.log('PASS existing plain JSON snapshots and account isolation remain compatible');

  const large = { ...snapshot, crm: { ...snapshot.crm,
    leads: Array.from({ length: 10_000 }, (_, id) => ({
      id, email: 'fixture-person@example.test', name: 'M\u00e9trica \ud83d\udcca', income: id / 100,
      source: 'Synthetic attribution evidence. '.repeat(45), tags: ['customer', 'campaign'],
    })),
  } };
  const encoded = await encodeSnapshot(large);
  assert(encoded.jsonBytes > 10_000_000);
  assert(encoded.storedBytes < 1_000_000);
  assert.equal(encoded.encoding, 'gzip-base64');
  assert.deepEqual(await decodeSnapshot(encoded.value), large);
  calls.length = 0;
  const saved = await writeSnapshot(large, ACCOUNT, { details: true });
  assert.equal(saved.persisted, true);
  assert.equal(saved.storage.jsonBytes, encoded.jsonBytes);
  assert.equal(calls.length, 2, 'compression does not add Redis commands');
  assert.deepEqual(calls[1].slice(-2), ['EX', String(90 * 86400)]);
  assert.equal(calls[0][2], calls[1][2]);
  assert.deepEqual(await readSnapshot(ACCOUNT), large);
  assert.equal(await writeSnapshot(snapshot, OTHER), true, 'legacy boolean return stays compatible');
  assert.deepEqual(await readSnapshot(OTHER), snapshot);
  console.log('PASS >10 MB snapshots round-trip losslessly with two bounded writes and retained history TTL');

  const envelope = JSON.parse(encoded.value);
  for (const invalid of [
    '{', 'null', '[]',
    JSON.stringify({ ...envelope, snapshotEncoding: 'unsupported' }),
    JSON.stringify({ ...envelope, data: 'not-base64!' }),
    JSON.stringify({ ...envelope, data: Buffer.from('not gzip').toString('base64') }),
    JSON.stringify({ ...envelope, jsonBytes: 100 }),
    JSON.stringify({ ...envelope, jsonBytes: encoded.jsonBytes + 1 }),
    JSON.stringify({ ...envelope, jsonBytes: SNAPSHOT_MAX_JSON_BYTES + 1 }),
  ]) {
    await assert.rejects(decodeSnapshot(invalid));
    mem.set(KEY, invalid);
    assert.equal(await readSnapshot(ACCOUNT), null);
  }
  console.log('PASS corrupted encodings, invalid JSON and oversized decompression are rejected safely');

  mem.set(KEY, small.value);
  for (const [status, message, code] of [
    [413, 'fixture-private-token request too large', 'kv_size'],
    [200, 'ERR max request size exceeded', 'kv_size'],
    [400, 'ERR max single record size exceeded', 'kv_size'],
    [400, 'ERR max requests limit exceeded', 'kv_limit'],
    [429, 'quota exhausted', 'kv_limit'],
    [401, 'invalid token fixture-private-token', 'kv_auth'],
    [403, 'NOPERM fixture-private-token', 'kv_permission'],
    [503, 'provider error fixture-private-token', 'kv_unavailable'],
  ]) {
    fault = ([op]) => op === 'SET' ? { status, message } : null;
    calls.length = 0;
    const result = await writeSnapshot(large, ACCOUNT, { details: true });
    assert.equal(result.persisted, false);
    assert.equal(result.persistenceError.code, code);
    assert(!result.persistenceError.message.includes('fixture-private-token'));
    assert.equal(calls.length, 1, 'failed primary writes do not attempt another oversized/history write');
    assert.equal(mem.get(KEY), small.value, 'failed saves preserve the existing snapshot');
  }
  fault = ([op, , , ...flags]) => op === 'SET' && flags.includes('EX') ? { status: 503, message: 'history unavailable' } : null;
  const partial = await writeSnapshot(large, ACCOUNT, { details: true });
  assert.equal(partial.persisted, true);
  assert.equal(partial.persistenceWarning.code, 'kv_unavailable');
  assert.match(partial.persistenceWarning.message, /Current snapshot saved/);
  assert.deepEqual(await readSnapshot(ACCOUNT), large);
  console.log('PASS size, quota and permission failures stay distinct; history failures do not hide current-save success');

  fault = null;
  mem.set(KEY, small.value);
  calls.length = 0;
  const incompressible = { ...snapshot, random: randomBytes(7_000_000).toString('base64') };
  const rejected = await writeSnapshot(incompressible, ACCOUNT, { details: true });
  assert.equal(rejected.persisted, false);
  assert.equal(rejected.persistenceError.code, 'kv_size');
  assert.equal(calls.length, 0, 'still oversized data is rejected before any remote write');
  assert.equal(mem.get(KEY), small.value);
  assert(SNAPSHOT_MAX_STORED_BYTES < 10_000_000);
  console.log('PASS incompressible oversized snapshots preserve the old value without remote requests');

  const notes = [];
  const deps = {
    checkAccess: async () => ({ ok: true }), isCron: () => false,
    accountFromReq: async () => ACCOUNT, storeConfigured: () => true,
    readPrefs: async () => null, readSnapshot: async () => snapshot,
    asAccount: async (id, fn) => fn(), buildSnapshot: async () => large, writeSnapshot,
    markKeyStatus: async () => {}, noteRefresh: async (...args) => notes.push(args),
    logEvent: () => {}, now: Date.now, webhookConfiguration: () => undefined,
  };
  const req = { url: '/api/refresh', method: 'POST', headers: { host: 'test.local' } };
  const response = () => ({ code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; }, setHeader() {} });
  fault = ([op]) => op === 'SET' ? { status: 413, message: 'request too large' } : null;
  let res = response();
  await createRefreshHandler(deps)(req, res);
  assert.equal(res.body.ok, true, 'the build succeeded even though persistence did not');
  assert.equal(res.body.persisted, false);
  assert.equal(res.body.persistenceError.code, 'kv_size');
  assert.equal(notes.at(-1)[1], false, 'the account must not report a successful saved refresh');
  fault = null;
  res = response();
  await createRefreshHandler(deps)(req, res);
  assert.equal(res.body.persisted, true);
  assert.equal(res.body.storage.encoding, 'gzip-base64');
  assert.equal(notes.at(-1)[1], true);
  const thrown = createRefreshHandler({ ...deps, writeSnapshot: async () => { throw new Error('fixture-private-token'); } });
  res = response();
  await thrown(req, res);
  assert.equal(res.body.persistenceError.code, 'kv_unavailable');
  assert(!JSON.stringify(res.body).includes('fixture-private-token'));
  assert(!events.some(event => /fixture-private-token|fixture-person|snapshot\.example\.test|Synthetic attribution/.test(event)));
  console.log('PASS refresh propagates safe errors, records actual save status, and logs sizes without record contents');
} finally {
  globalThis.fetch = originalFetch;
  console.error = originalError;
}

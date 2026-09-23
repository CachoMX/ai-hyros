import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { test } from 'node:test';
import webhook, { config, createWebhookHandler } from '../api/webhook.js';
import {
  ACCEPT_EVENT_SCRIPT, READ_DIRTY_SCRIPT, CLEAR_DIRTY_SCRIPT,
  BODY_TIMEOUT_MS, DEDUPE_SECONDS, EVENT_TYPES, MAX_BODY_BYTES, MAX_RECEIPTS,
  acceptWebhookEvent, clearWebhookDirty, readRawWebhookBody, readWebhookConfig,
  readWebhookDirty, verifyWebhookSignature, webhookKeys,
} from '../api/_webhook.js';

const NOW = 1790164800000;
const ACCOUNT = 'acc_012345abcdef';
const OTHER = 'cli_abcdef012345';
const SECRET = 'synthetic-subscription-secret-for-tests';
const OTHER_SECRET = 'different-synthetic-subscription-secret';
const SETTINGS = JSON.stringify({
  [ACCOUNT]: [{ subscriptionId: 'sub-one', secretKey: SECRET }, { subscriptionId: 'sub-two', secretKey: SECRET }],
  [OTHER]: { subscriptionId: 'sub-other', secretKey: OTHER_SECRET },
});
const envelope = (overrides = {}) => ({
  subscriptionId: 'sub-one', eventId: 'evt-one', type: 'sale.attributed',
  timestamp: '2022-09-28T15:38:48-03:00',
  body: { lead: { email: 'private@example.test', phone: '555-0100' }, orderId: 'private-order' },
  ...overrides,
});
const raw = (value = envelope()) => Buffer.from(JSON.stringify(value));
const sign = (body, { seconds = NOW / 1000, secret = SECRET } = {}) =>
  `t=${seconds},v1=${createHmac('sha256', secret).update(`${seconds}.`).update(body).digest('hex')}`;
const response = () => ({
  statusCode: 200, headers: {}, body: null,
  setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
});

/** Atomic Redis model with independent state, time, expiry, capacity, and failure controls. */
function memoryKv() {
  const state = new Map();
  const calls = [];
  let seconds = NOW / 1000;
  let failure = null;
  const get = (key) => {
    const entry = state.get(key);
    if (entry?.expiresAt && entry.expiresAt <= seconds) { state.delete(key); return undefined; }
    return entry;
  };
  const kv = async (command) => {
    calls.push(command);
    if (failure === 'throw') throw new Error('private upstream error must not escape');
    if (failure === 'null') return null;
    const [op, script, count, ...args] = command;
    assert.equal(op, 'EVAL');
    if (script === ACCEPT_EVENT_SCRIPT) {
      assert.equal(count, '2');
      const [receiptKey, dirtyKey, digest, retention, cap, marker] = args;
      let receipts = get(receiptKey);
      const dirty = get(dirtyKey);
      if ((receipts && receipts.type !== 'zset') || (dirty && dirty.type !== 'string')) return -2;
      if (!receipts) receipts = { type: 'zset', values: new Map() };
      for (const [key, score] of receipts.values) if (score <= seconds - Number(retention)) receipts.values.delete(key);
      if (receipts.values.has(digest)) return 0;
      if (receipts.values.size >= Number(cap)) return -1;
      state.set(dirtyKey, { type: 'string', value: marker });
      receipts.values.set(digest, seconds);
      receipts.expiresAt = seconds + Number(retention);
      state.set(receiptKey, receipts);
      return 1;
    }
    assert.equal(count, '1');
    const [key, marker] = args;
    const dirty = get(key);
    if (dirty && dirty.type !== 'string') return null;
    if (script === READ_DIRTY_SCRIPT) return dirty ? [1, dirty.value] : [0, ''];
    if (script === CLEAR_DIRTY_SCRIPT) {
      if (dirty?.value !== marker) return 0;
      state.delete(key);
      return 1;
    }
    assert.fail('Unexpected Redis script');
  };
  return { kv, calls, state, get, advance(n) { seconds += n; }, fail(value) { failure = value; } };
}

function harness(options = {}) {
  const store = options.store || memoryKv();
  const handler = createWebhookHandler({ configuration: () => SETTINGS, storageConfigured: () => true, kv: store.kv, now: () => NOW, ...options });
  const send = async ({ body = raw(), headers = {}, method = 'POST', parsed, chunks } = {}) => {
    const req = Readable.from(chunks || [body]);
    req.method = method;
    req.headers = { 'content-type': 'application/json', 'x-hyros-signature': sign(body), ...headers };
    if (parsed !== undefined) req.body = parsed;
    const res = response();
    await handler(req, res);
    req.destroy();
    return res;
  };
  return { store, handler, send };
}

await test('raw-byte signature, constant-size MAC, replay boundaries and changed bytes', () => {
  assert.equal(config.api.bodyParser, false);
  const body = Buffer.from('{ "subscriptionId": "sub-one", "label": "caf\u00e9" }\n');
  assert.equal(verifyWebhookSignature(body, sign(body), SECRET, NOW), true);
  for (const offset of [-300, 300]) {
    assert.equal(verifyWebhookSignature(body, sign(body, { seconds: NOW / 1000 + offset }), SECRET, NOW), true);
  }
  for (const offset of [-301, 301]) {
    assert.equal(verifyWebhookSignature(body, sign(body, { seconds: NOW / 1000 + offset }), SECRET, NOW), false);
  }
  assert.equal(verifyWebhookSignature(body, sign(body, { seconds: NOW / 1000 - 300 }), SECRET, NOW + 1), false);
  assert.equal(verifyWebhookSignature(Buffer.concat([body, Buffer.from(' ')]), sign(body), SECRET, NOW), false);
  assert.equal(verifyWebhookSignature(body, sign(body), OTHER_SECRET, NOW), false);
  for (const header of [undefined, '', [], `${sign(body)},v1=${'a'.repeat(64)}`, sign(body).toUpperCase(), 't=NaN,v1=00', `t=1,v1=${'g'.repeat(64)}`, `t=1,v1=${'a'.repeat(63)}`]) {
    assert.equal(verifyWebhookSignature(body, header, SECRET, NOW), false);
  }
});

await test('bounded account configuration fails closed without exposing values', () => {
  assert.equal(readWebhookConfig(SETTINGS).size, 3);
  for (const value of [undefined, '', '{', 'null', '[]', '{}', 'x'.repeat(256 * 1024 + 1),
    JSON.stringify({ env: { subscriptionId: 'sub-one', secretKey: SECRET } }),
    JSON.stringify({ [ACCOUNT]: { subscriptionId: 'sub-one', publicKey: SECRET } }),
    JSON.stringify({ [ACCOUNT]: { subscriptionId: 'sub-one', secretKey: '' } }),
    JSON.stringify({ [ACCOUNT]: { subscriptionId: 'sub-one', secretKey: 'x'.repeat(4097) } }),
    JSON.stringify({ [ACCOUNT]: Array.from({ length: 21 }, (_, i) => ({ subscriptionId: `sub-${i}`, secretKey: SECRET })) }),
    JSON.stringify(Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`acc_${i}`, { subscriptionId: `sub-${i}`, secretKey: SECRET }]))),
    JSON.stringify({ [ACCOUNT]: { subscriptionId: 'sub-one', secretKey: SECRET }, [OTHER]: { subscriptionId: 'sub-one', secretKey: OTHER_SECRET } }),
  ]) {
    assert.throws(() => readWebhookConfig(value), (error) => error.status === 503 && !error.message.includes(SECRET));
  }
});

await test('unconfigured receiver, missing storage, methods, media types and compression', async () => {
  for (const configuration of [() => undefined, () => '{}', () => '{']) {
    const h = harness({ configuration });
    const res = await h.send();
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.error, 'webhook_not_configured');
    assert.equal(res.headers['retry-after'], '60');
    assert.equal(h.store.calls.length, 0);
  }
  assert.equal((await harness({ storageConfigured: () => false }).send()).statusCode, 503);
  const h = harness();
  for (const method of ['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    const res = await h.send({ method });
    assert.equal(res.statusCode, 405);
    assert.equal(res.headers.allow, 'POST');
  }
  for (const headers of [{ 'content-type': undefined }, { 'content-type': 'text/plain' },
    { 'content-type': 'application/json; charset=utf-16' }, { 'content-encoding': 'gzip' }]) {
    assert.equal((await h.send({ headers })).statusCode, 415);
  }
  assert.equal(h.store.calls.length, 0);
});

await test('invalid, expired, future, SHA1-only and mismatched subscription signatures never write', async () => {
  const h = harness();
  for (const headers of [
    { 'x-hyros-signature': undefined, 'x-hyros-hmac-sha1': 'deprecated' },
    { 'x-hyros-signature': sign(raw(), { seconds: NOW / 1000 - 301 }) },
    { 'x-hyros-signature': sign(raw(), { seconds: NOW / 1000 + 301 }) },
    { 'x-hyros-signature': sign(raw(), { secret: OTHER_SECRET }) },
    { 'x-hyros-signature': [sign(raw()), sign(raw())] },
  ]) assert.equal((await h.send({ headers })).statusCode, 401);
  assert.equal((await h.send({ body: raw(envelope({ subscriptionId: 'sub-unknown' })) })).statusCode, 401);
  assert.equal((await h.send({ body: Buffer.concat([raw(), Buffer.from(' ')]), headers: { 'x-hyros-signature': sign(raw()) } })).statusCode, 401);
  assert.equal(h.store.calls.length, 0);
});

await test('invalid JSON, UTF-8, envelope and unsupported event never poison idempotence', async () => {
  const h = harness();
  const bodies = [Buffer.from('{'), Buffer.from([0xff]), raw(null), raw([]), raw({}),
    raw(envelope({ eventId: undefined })), raw(envelope({ eventId: 'bad\nidentifier' })),
    raw(envelope({ timestamp: 'bad' })), raw(envelope({ timestamp: undefined })),
    raw(envelope({ body: null })), raw(envelope({ body: [] })),
    raw(envelope({ type: 'unrecognized.event' })), raw(envelope({ type: {} })),
  ];
  for (const body of bodies) assert.equal((await h.send({ body })).statusCode, 400);
  assert.equal(h.store.calls.length, 0);
  assert.equal((await h.send()).body.duplicate, false);
});

await test('size limits apply to declared, actual, chunked and raw Buffer bytes', async () => {
  const h = harness();
  assert.equal((await h.send({ headers: { 'content-length': String(MAX_BODY_BYTES + 1) } })).statusCode, 413);
  assert.equal((await h.send({ body: Buffer.alloc(MAX_BODY_BYTES + 1) })).statusCode, 413);
  assert.equal((await h.send({ chunks: [Buffer.alloc(MAX_BODY_BYTES), Buffer.from('x')] })).statusCode, 413);
  assert.equal((await h.send({ body: Buffer.alloc(MAX_BODY_BYTES + 1), headers: { 'content-length': '10' } })).statusCode, 413);
  assert.equal((await h.send({ parsed: Buffer.alloc(MAX_BODY_BYTES + 1) })).statusCode, 413);
  for (const length of ['-1', '1.5', 'abc', ['1'], '99999999999']) {
    assert.equal((await h.send({ headers: { 'content-length': length } })).statusCode, 400);
  }
  assert.equal((await h.send({ headers: { 'content-length': '1' } })).statusCode, 400);
  assert.equal((await h.send({ body: Buffer.alloc(0) })).statusCode, 400);
  assert.equal(h.store.calls.length, 0);
  const padded = Buffer.concat([raw(), Buffer.alloc(MAX_BODY_BYTES - raw().length, 32)]);
  assert.equal((await h.send({ body: padded, headers: { 'content-length': String(MAX_BODY_BYTES) } })).statusCode, 200);
});

await test('raw body reader rejects parsing, decoding, aborts and stalled streams; cleans listeners', async () => {
  const h = harness();
  for (const parsed of [envelope(), raw().toString('utf8')]) {
    const res = await h.send({ parsed });
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.error, 'raw_body_unavailable');
  }
  assert.equal((await h.send({ parsed: raw() })).statusCode, 200);
  const decoded = new PassThrough();
  decoded.headers = {};
  decoded.setEncoding('utf8');
  await assert.rejects(readRawWebhookBody(decoded), { code: 'raw_body_unavailable' });
  decoded.destroy();
  assert.equal(BODY_TIMEOUT_MS, 10000);
  const stalled = new PassThrough();
  stalled.headers = {};
  await assert.rejects(readRawWebhookBody(stalled, { timeoutMs: 5 }), { status: 408 });
  for (const event of ['data', 'end', 'error', 'aborted', 'close']) assert.equal(stalled.listenerCount(event), 0);
  stalled.destroy();
  for (const event of ['aborted', 'error', 'close']) {
    const stream = new PassThrough();
    stream.headers = {};
    const pending = readRawWebhookBody(stream);
    const rejected = assert.rejects(pending, { code: 'incomplete_body' });
    stream.emit(event, new Error('synthetic disconnect'));
    await rejected;
    stream.destroy();
  }
});

await test('all documented events are accepted, including old envelope timestamps on fresh deliveries', async () => {
  const h = harness();
  assert.equal(EVENT_TYPES.size, 11);
  for (const type of EVENT_TYPES) {
    const res = await h.send({ body: raw(envelope({ type, eventId: `evt-${type.replaceAll('.', '-')}` })), headers: { 'content-type': 'application/json; charset=UTF-8' } });
    assert.deepEqual(res.body, { ok: true, duplicate: false });
    assert.equal(res.headers['cache-control'], 'no-store');
  }
});

await test('concurrent deliveries across handler instances accept once and freshly signed retries deduplicate', async () => {
  const store = memoryKv();
  const handlers = Array.from({ length: 4 }, () => harness({ store }));
  const responses = await Promise.all(Array.from({ length: 40 }, (_, i) => handlers[i % 4].send()));
  assert.equal(responses.filter((r) => r.statusCode === 200 && r.body.duplicate === false).length, 1);
  assert.equal(responses.filter((r) => r.statusCode === 200 && r.body.duplicate === true).length, 39);
  const marker = await readWebhookDirty(ACCOUNT, store);
  assert.ok(marker);
  const retry = await harness({ store, now: () => NOW + 600000 }).send({ headers: { 'x-hyros-signature': sign(raw(), { seconds: NOW / 1000 + 600 }) } });
  assert.deepEqual(retry.body, { ok: true, duplicate: true });
  assert.equal(await readWebhookDirty(ACCOUNT, store), marker);
  assert.equal(await clearWebhookDirty(ACCOUNT, marker, store), true);
  assert.equal((await handlers[0].send()).body.duplicate, true);
  assert.equal(await readWebhookDirty(ACCOUNT, store), null);
});

await test('account and subscription isolation; untrusted account fields cannot redirect dirty writes', async () => {
  const h = harness();
  assert.equal((await h.send({ body: raw(envelope({ accountId: OTHER })) })).body.duplicate, false);
  assert.equal(await readWebhookDirty(OTHER, h.store), null);
  assert.equal((await h.send({ body: raw(envelope({ subscriptionId: 'sub-two' })) })).body.duplicate, false);
  const otherBody = raw(envelope({ subscriptionId: 'sub-other' }));
  assert.equal((await h.send({ body: otherBody })).statusCode, 401);
  assert.equal((await h.send({ body: otherBody, headers: { 'x-hyros-signature': sign(otherBody, { secret: OTHER_SECRET }) } })).body.duplicate, false);
  assert.ok(await readWebhookDirty(OTHER, h.store));
  assert.notDeepEqual(webhookKeys(ACCOUNT), webhookKeys(OTHER));
  assert.throws(() => webhookKeys('bad}:{account'));
});

await test('dirty acknowledgement retains events arriving during refresh and failed refreshes', async () => {
  const h = harness();
  assert.equal(await readWebhookDirty(ACCOUNT, h.store), null);
  await h.send();
  const first = await readWebhookDirty(ACCOUNT, h.store);
  await h.send({ body: raw(envelope({ eventId: 'evt-new' })) });
  const second = await readWebhookDirty(ACCOUNT, h.store);
  assert.notEqual(second, first);
  assert.equal(await clearWebhookDirty(ACCOUNT, first, h.store), false);
  assert.equal(await readWebhookDirty(ACCOUNT, h.store), second);
  h.store.advance(DEDUPE_SECONDS + 1);
  assert.equal(await readWebhookDirty(ACCOUNT, h.store), second, 'dirty marker never expires before a successful refresh');
  assert.equal(await clearWebhookDirty(ACCOUNT, second, h.store), true);
  assert.equal(await clearWebhookDirty(ACCOUNT, second, h.store), false);
});

await test('KV errors, corrupt key types and lost responses allow safe retry without false success', async () => {
  for (const failure of ['null', 'throw']) {
    const h = harness();
    h.store.fail(failure);
    const res = await h.send();
    assert.equal(res.statusCode, 503);
    assert.ok(!JSON.stringify(res.body).includes('private upstream'));
    await assert.rejects(readWebhookDirty(ACCOUNT, h.store), { status: 503 });
    await assert.rejects(clearWebhookDirty(ACCOUNT, 'a'.repeat(36), h.store), { status: 503 });
    h.store.fail(null);
    assert.equal((await h.send()).body.duplicate, false);
  }
  for (const key of Object.values(webhookKeys(ACCOUNT))) {
    const h = harness();
    h.store.state.set(key, { type: 'list', value: [] });
    assert.equal((await h.send()).statusCode, 503);
    assert.equal(h.store.state.size, 1);
  }
  const store = memoryKv();
  let loseResponse = true;
  const h = harness({ store, kv: async (command) => {
    const result = await store.kv(command);
    if (loseResponse) { loseResponse = false; return null; }
    return result;
  } });
  assert.equal((await h.send()).statusCode, 503);
  assert.equal((await h.send()).body.duplicate, true);
  assert.ok(await readWebhookDirty(ACCOUNT, store));
});

await test('acknowledgement waits for the durable operation', async () => {
  const store = memoryKv();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const h = harness({ store, kv: async (command) => { await gate; return store.kv(command); } });
  let replied = false;
  const pending = h.send().then((res) => { replied = true; return res; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(replied, false);
  assert.equal(store.state.size, 0);
  release();
  assert.equal((await pending).statusCode, 200);
  assert.ok(await readWebhookDirty(ACCOUNT, store));
});

await test('bounded deduplication retains live receipts at capacity and expires after seven days', async () => {
  const h = harness();
  await h.send();
  const keys = webhookKeys(ACCOUNT);
  const receipts = h.store.get(keys.receipts);
  for (let i = receipts.values.size; i < MAX_RECEIPTS; i++) receipts.values.set(`synthetic-${i}`, NOW / 1000);
  const first = await readWebhookDirty(ACCOUNT, h.store);
  const full = await h.send({ body: raw(envelope({ eventId: 'evt-over-capacity' })) });
  assert.equal(full.statusCode, 503);
  assert.equal(full.body.error, 'webhook_capacity');
  assert.equal(receipts.values.size, MAX_RECEIPTS);
  assert.equal(await readWebhookDirty(ACCOUNT, h.store), first);
  assert.equal((await h.send()).body.duplicate, true);
  h.store.advance(DEDUPE_SECONDS - 1);
  assert.equal((await h.send()).body.duplicate, true);
  h.store.advance(1);
  assert.equal((await h.send()).body.duplicate, false);
  assert.equal(h.store.get(keys.receipts).values.size, 1);
  assert.notEqual(await readWebhookDirty(ACCOUNT, h.store), first);
});

await test('per-member retention is pruned even when newer events keep the receipts key alive', async () => {
  const store = memoryKv();
  await acceptWebhookEvent(ACCOUNT, envelope(), store);
  store.advance(DEDUPE_SECONDS - 10);
  await acceptWebhookEvent(ACCOUNT, envelope({ eventId: 'evt-later' }), store);
  store.advance(10);
  assert.equal((await acceptWebhookEvent(ACCOUNT, envelope(), store)).duplicate, false);
  assert.equal((await acceptWebhookEvent(ACCOUNT, envelope({ eventId: 'evt-later' }), store)).duplicate, true);
});

await test('only opaque event digests, receipt times and dirty tokens persist; no PII, signatures or secrets', async () => {
  const h = harness();
  await h.send();
  const serialized = JSON.stringify([...h.store.state], (_, value) => value instanceof Map ? [...value] : value);
  const commands = JSON.stringify(h.store.calls);
  for (const prohibited of ['private@example.test', '555-0100', 'private-order', SECRET, 'evt-one', 'sub-one', sign(raw())]) {
    assert.equal(serialized.includes(prohibited), false);
    assert.equal(commands.includes(prohibited), false);
  }
  assert.equal(h.store.state.size, 2);
  const receipts = h.store.get(webhookKeys(ACCOUNT).receipts);
  assert.match([...receipts.values.keys()][0], /^[0-9a-f]{64}$/);
  assert.equal(receipts.expiresAt, NOW / 1000 + DEDUPE_SECONDS);
});

await test('default handler uses the existing KV REST interface only, with no HYROS requests', async () => {
  const envNames = ['HYROS_WEBHOOK_ACCOUNTS', 'KV_REST_API_URL', 'KV_REST_API_TOKEN'];
  const previous = Object.fromEntries(envNames.map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  const store = memoryKv();
  try {
    process.env.HYROS_WEBHOOK_ACCOUNTS = SETTINGS;
    process.env.KV_REST_API_URL = 'https://webhook-kv.invalid';
    process.env.KV_REST_API_TOKEN = 'synthetic-kv-token';
    globalThis.fetch = async (url, options) => {
      assert.equal(url, 'https://webhook-kv.invalid', 'unexpected outbound request');
      assert.equal(options.method, 'POST');
      assert.equal(options.headers.authorization, 'Bearer synthetic-kv-token');
      return new Response(JSON.stringify({ result: await store.kv(JSON.parse(options.body)) }));
    };
    const body = raw();
    const req = Readable.from([body]);
    req.method = 'POST';
    req.headers = { 'content-type': 'application/json', 'x-hyros-signature': sign(body, { seconds: Math.floor(Date.now() / 1000) }) };
    const res = response();
    await webhook(req, res);
    assert.deepEqual(res.body, { ok: true, duplicate: false });
    const marker = await readWebhookDirty(ACCOUNT);
    assert.equal(await clearWebhookDirty(ACCOUNT, marker), true);
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of envNames) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  }
});

await test('real HTTP stream preserves signed UTF-8 bytes and chunked size enforcement', async () => {
  const h = harness();
  const server = createServer(async (req, res) => {
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); return res; };
    await h.handler(req, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const body = Buffer.from(JSON.stringify(envelope({ body: { label: 'caf\u00e9' } }), null, 2) + '\n');
    const url = `http://127.0.0.1:${server.address().port}/api/webhook`;
    const result = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hyros-signature': sign(body) }, body });
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), { ok: true, duplicate: false });
    const tooLarge = await fetch(url, {
      method: 'POST', duplex: 'half',
      headers: { 'content-type': 'application/json', 'x-hyros-signature': sign(body) },
      body: Readable.from([Buffer.alloc(MAX_BODY_BYTES), Buffer.alloc(1)]),
    });
    assert.equal(tooLarge.status, 413);
    await tooLarge.json();
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

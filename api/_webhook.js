import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { kvRaw } from './_store.js';

export const MAX_BODY_BYTES = 1024 * 1024;
export const BODY_TIMEOUT_MS = 10000;
export const REPLAY_SECONDS = 300;
export const DEDUPE_SECONDS = 7 * 24 * 60 * 60;
export const MAX_RECEIPTS = 10000;
export const EVENT_TYPES = new Set([
  'sale.attributed', 'sale.refunded', 'lead.opted.in', 'lead.opted.in.first.time',
  'lead.origin.assigned', 'lead.stage.changed', 'lead.tag.added', 'lead.tag.removed',
  'call.attributed', 'subscription.created', 'subscription.status.changed',
]);

export class WebhookError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const validAccount = (value) => /^(acc|cli)_[A-Za-z0-9_-]{1,80}$/.test(value);
const invalidPayload = () => new WebhookError(400, 'invalid_payload', 'Expected a HYROS event envelope with an object body.');
const unavailable = () => new WebhookError(503, 'webhook_storage_unavailable', 'Webhook storage is unavailable; retry delivery.');

/** Account IDs are local registry IDs; each secret belongs to one HYROS subscription. */
export function readWebhookConfig(raw = process.env.HYROS_WEBHOOK_ACCOUNTS) {
  const invalid = () => new WebhookError(503, 'webhook_not_configured',
    'Set HYROS_WEBHOOK_ACCOUNTS to account IDs with subscriptionId and secretKey entries.');
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 256 * 1024) throw invalid();
  let config;
  try { config = JSON.parse(raw); } catch { throw invalid(); }
  if (!record(config)) throw invalid();
  const accounts = Object.entries(config);
  if (!accounts.length || accounts.length > 100) throw invalid();
  const subscriptions = new Map();
  for (const [accountId, value] of accounts) {
    if (!validAccount(accountId)) throw invalid();
    const entries = Array.isArray(value) ? value : [value];
    if (!entries.length || entries.length > 20) throw invalid();
    for (const entry of entries) {
      if (!record(entry) || !validId(entry.subscriptionId) || subscriptions.has(entry.subscriptionId)
        || typeof entry.secretKey !== 'string' || !entry.secretKey.trim()
        || Buffer.byteLength(entry.secretKey) > 4096) throw invalid();
      subscriptions.set(entry.subscriptionId, { accountId, secretKey: entry.secretKey });
    }
  }
  return subscriptions;
}

export function verifyWebhookSignature(rawBody, header, secret, now = Date.now()) {
  if (!Buffer.isBuffer(rawBody) || typeof header !== 'string' || header.length > 100
    || typeof secret !== 'string' || !secret || !Number.isFinite(now)) return false;
  const match = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(header);
  if (!match || Math.abs(now / 1000 - Number(match[1])) > REPLAY_SECONDS) return false;
  const expected = createHmac('sha256', secret).update(`${match[1]}.`).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(match[2], 'hex'));
}

export function parseWebhookBody(rawBody) {
  try {
    const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBody));
    if (!record(payload) || !validId(payload.subscriptionId)) throw invalidPayload();
    return payload;
  } catch { throw invalidPayload(); }
}

export function validateWebhookEvent(payload) {
  if (!validId(payload.eventId) || typeof payload.type !== 'string' || payload.type.length > 100
    || typeof payload.timestamp !== 'string' || payload.timestamp.length > 64
    || !/^\d{4}-\d{2}-\d{2}T/.test(payload.timestamp) || !Number.isFinite(Date.parse(payload.timestamp))
    || !record(payload.body)) throw invalidPayload();
  if (!EVENT_TYPES.has(payload.type)) {
    throw new WebhookError(400, 'unsupported_event', 'This HYROS event type is not supported.');
  }
}

/** Never reconstruct JSON from req.body: HMAC verification requires the original bytes. */
export async function readRawWebhookBody(req, { timeoutMs = BODY_TIMEOUT_MS } = {}) {
  const length = req.headers?.['content-length'];
  if (length !== undefined && (typeof length !== 'string' || !/^\d{1,10}$/.test(length))) {
    throw new WebhookError(400, 'invalid_content_length', 'Invalid Content-Length.');
  }
  const declared = length === undefined ? null : Number(length);
  const tooLarge = () => new WebhookError(413, 'payload_too_large', 'Webhook payload exceeds 1 MiB.');
  if (declared > MAX_BODY_BYTES) throw tooLarge();
  const check = (body) => {
    if (body.length > MAX_BODY_BYTES) throw tooLarge();
    if (!body.length || (declared !== null && body.length !== declared)) throw invalidPayload();
    return body;
  };
  if (Buffer.isBuffer(req.body)) return check(req.body);
  if (req.body !== undefined || req.readableEncoding) {
    throw new WebhookError(503, 'raw_body_unavailable', 'Webhook ingestion requires bodyParser: false and an undecoded request stream.');
  }
  if (req.readableEnded || req.destroyed) throw invalidPayload();
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const cleanup = () => {
      clearTimeout(timer);
      for (const [event, listener] of listeners) req.removeListener(event, listener);
    };
    const fail = (error) => { cleanup(); req.pause(); reject(error); };
    const onData = (chunk) => {
      if (!Buffer.isBuffer(chunk)) return fail(invalidPayload());
      size += chunk.length;
      if (size > MAX_BODY_BYTES) return fail(tooLarge());
      chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      try { resolve(check(Buffer.concat(chunks, size))); } catch (error) { reject(error); }
    };
    const onAbort = () => fail(new WebhookError(400, 'incomplete_body', 'Webhook body was not completely received.'));
    const listeners = [['data', onData], ['end', onEnd], ['error', onAbort], ['aborted', onAbort], ['close', onAbort]];
    const timer = setTimeout(() => fail(new WebhookError(408, 'body_timeout', 'Webhook body read timed out.')),
      Math.min(BODY_TIMEOUT_MS, Math.max(1, timeoutMs)));
    for (const [event, listener] of listeners) req.on(event, listener);
  });
}

export function webhookKeys(accountId) {
  if (!validAccount(accountId)) throw new TypeError('Invalid local webhook account ID.');
  // Shared hash tag also keeps the atomic operation on one Redis Cluster slot.
  const prefix = `aihyros:webhook:{${accountId}}`;
  return { receipts: `${prefix}:receipts`, dirty: `${prefix}:dirty` };
}

// Check key types before writes: Redis Lua errors do not roll back prior writes.
export const ACCEPT_EVENT_SCRIPT = `
local receiptsType = redis.call('TYPE', KEYS[1]).ok
local dirtyType = redis.call('TYPE', KEYS[2]).ok
if (receiptsType ~= 'none' and receiptsType ~= 'zset') or
   (dirtyType ~= 'none' and dirtyType ~= 'string') then return -2 end
local now = tonumber(redis.call('TIME')[1])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - tonumber(ARGV[2]))
if redis.call('ZSCORE', KEYS[1], ARGV[1]) then return 0 end
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[3]) then return -1 end
redis.call('SET', KEYS[2], ARGV[4])
redis.call('ZADD', KEYS[1], now, ARGV[1])
redis.call('EXPIRE', KEYS[1], ARGV[2])
return 1`;

export async function acceptWebhookEvent(accountId, payload, { kv = kvRaw } = {}) {
  const keys = webhookKeys(accountId);
  const digest = createHash('sha256').update(JSON.stringify([payload.subscriptionId, payload.eventId])).digest('hex');
  let result;
  try {
    result = await kv(['EVAL', ACCEPT_EVENT_SCRIPT, '2', keys.receipts, keys.dirty,
      digest, String(DEDUPE_SECONDS), String(MAX_RECEIPTS), randomUUID()]);
  } catch { throw unavailable(); }
  if (result === -1) {
    throw new WebhookError(503, 'webhook_capacity', 'Webhook deduplication capacity reached; retry after capacity is available.');
  }
  if (result !== 0 && result !== 1) throw unavailable();
  return { duplicate: result === 0 };
}

export const READ_DIRTY_SCRIPT = `
local marker = redis.call('GET', KEYS[1])
if marker then return {1, marker} end
return {0, ''}`;
export const CLEAR_DIRTY_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0`;

/** Capture before refresh; acknowledge only after its snapshot is durably saved. */
export async function readWebhookDirty(accountId, { kv = kvRaw } = {}) {
  let result;
  try { result = await kv(['EVAL', READ_DIRTY_SCRIPT, '1', webhookKeys(accountId).dirty]); }
  catch { throw unavailable(); }
  if (!Array.isArray(result) || ![0, 1].includes(result[0]) || typeof result[1] !== 'string') throw unavailable();
  return result[0] === 1 ? result[1] : null;
}

export async function clearWebhookDirty(accountId, marker, { kv = kvRaw } = {}) {
  if (typeof marker !== 'string' || !/^[a-f0-9-]{36}$/.test(marker)) throw new TypeError('Invalid webhook dirty token.');
  let result;
  try { result = await kv(['EVAL', CLEAR_DIRTY_SCRIPT, '1', webhookKeys(accountId).dirty, marker]); }
  catch { throw unavailable(); }
  if (result !== 0 && result !== 1) throw unavailable();
  return result === 1;
}

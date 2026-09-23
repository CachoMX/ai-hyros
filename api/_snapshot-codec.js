import { gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';

const compress = promisify(gzip);
const decompress = promisify(gunzip);
const FORMAT = 'aihyros.snapshot.gzip.v1';
export const SNAPSHOT_COMPRESSION_THRESHOLD = 256 * 1024;
export const SNAPSHOT_MAX_JSON_BYTES = 128 * 1024 * 1024;
export const SNAPSHOT_MAX_STORED_BYTES = 9_000_000;

function codecError(code) {
  return Object.assign(new Error(code), { code });
}

/** Lossless storage encoding; small and existing snapshots remain ordinary JSON. */
export async function encodeSnapshot(snapshot) {
  const json = JSON.stringify(snapshot);
  if (typeof json !== 'string') throw codecError('kv_snapshot_corrupt');
  const jsonBytes = Buffer.byteLength(json);
  if (jsonBytes > SNAPSHOT_MAX_JSON_BYTES) throw codecError('kv_size');
  let value = json;
  let encoding = 'json';
  if (jsonBytes >= SNAPSHOT_COMPRESSION_THRESHOLD) {
    const zipped = await compress(json);
    const encoded = JSON.stringify({ snapshotEncoding: FORMAT, jsonBytes, data: zipped.toString('base64') });
    if (Buffer.byteLength(encoded) < jsonBytes) {
      value = encoded;
      encoding = 'gzip-base64';
    }
  }
  const storedBytes = Buffer.byteLength(value);
  if (storedBytes > SNAPSHOT_MAX_STORED_BYTES) throw codecError('kv_size');
  return { value, jsonBytes, storedBytes, encoding };
}

export async function decodeSnapshot(raw) {
  if (typeof raw !== 'string') throw codecError('kv_snapshot_corrupt');
  if (Buffer.byteLength(raw) > SNAPSHOT_MAX_JSON_BYTES) throw codecError('kv_size');
  const stored = JSON.parse(raw);
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) throw codecError('kv_snapshot_corrupt');
  if (!Object.hasOwn(stored, 'snapshotEncoding')) return stored;
  if (stored.snapshotEncoding !== FORMAT || !Number.isSafeInteger(stored.jsonBytes)
    || stored.jsonBytes < 2 || stored.jsonBytes > SNAPSHOT_MAX_JSON_BYTES
    || typeof stored.data !== 'string' || stored.data.length > SNAPSHOT_MAX_STORED_BYTES) {
    throw codecError('kv_snapshot_corrupt');
  }
  const zipped = Buffer.from(stored.data, 'base64');
  if (!zipped.length || zipped.toString('base64') !== stored.data) throw codecError('kv_snapshot_corrupt');
  // Bound decompression to the declared size, including malformed gzip payloads.
  const json = await decompress(zipped, { maxOutputLength: stored.jsonBytes });
  if (json.byteLength !== stored.jsonBytes) throw codecError('kv_snapshot_corrupt');
  const snapshot = JSON.parse(json.toString('utf8'));
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw codecError('kv_snapshot_corrupt');
  return snapshot;
}

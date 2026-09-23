import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

const STREAM_THRESHOLD_BYTES = 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;

export function setPrivateResponseHeaders(res) {
  res.setHeader('Cache-Control', 'private, no-store');
  const existing = res.getHeader?.('Vary');
  const vary = String(Array.isArray(existing) ? existing.join(',') : existing || '')
    .split(',').map((value) => value.trim()).filter(Boolean);
  for (const value of ['Authorization', 'x-report-key', 'Accept-Encoding']) {
    if (!vary.some((entry) => entry.toLowerCase() === value.toLowerCase())) vary.push(value);
  }
  res.setHeader('Vary', vary.includes('*') ? '*' : vary.join(', '));
}

function responseEncoding(header) {
  const qualities = new Map();
  for (const entry of String(header || '').split(',')) {
    const [name, ...parameters] = entry.trim().toLowerCase().split(';');
    if (!name.trim()) continue;
    let quality = 1;
    for (const parameter of parameters) {
      const [key, value] = parameter.split('=').map((part) => part.trim());
      if (key === 'q') {
        quality = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(value || '') ? Number(value) : 0;
      }
    }
    const coding = name.trim();
    // An explicit refusal wins over duplicate entries and wildcard acceptance.
    qualities.set(coding, Math.min(qualities.get(coding) ?? 1, quality));
  }
  const gzip = qualities.get('gzip') ?? qualities.get('*') ?? 0;
  const identity = qualities.get('identity') ?? (qualities.get('*') === 0 ? 0 : 1);
  if (gzip > 0 && gzip >= identity) return 'gzip';
  return identity > 0 ? 'identity' : null;
}

function* chunks(buffer) {
  for (let offset = 0; offset < buffer.length; offset += CHUNK_BYTES) {
    yield buffer.subarray(offset, offset + CHUNK_BYTES);
  }
}

export async function sendJsonResponse(req, res, body) {
  const serialized = JSON.stringify(body);
  if (Buffer.byteLength(serialized) < STREAM_THRESHOLD_BYTES) return res.status(200).json(body);

  const encoding = responseEncoding(req.headers?.['accept-encoding']);
  if (!encoding) return res.status(406).json({ ok: false, error: 'encoding_not_acceptable' });

  const source = Readable.from(chunks(Buffer.from(serialized)), { objectMode: false, highWaterMark: CHUNK_BYTES });
  res.status(200);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.removeHeader('Content-Length');
  if (encoding === 'gzip') res.setHeader('Content-Encoding', 'gzip');
  else res.removeHeader('Content-Encoding');
  // Commit a streaming response; Node owns HTTP framing and pipeline owns backpressure.
  res.flushHeaders();
  if (encoding === 'gzip') await pipeline(source, createGzip(), res);
  else await pipeline(source, res);
}

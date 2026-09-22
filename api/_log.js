/**
 * Structured server-side event log. One JSON line per event on stderr, which
 * Vercel keeps in the function's runtime logs — the only place a template
 * owner can look when a user reports "it failed". Never log API keys,
 * passwords, emails or lead data: ids, codes, tool names and timings only.
 */
import { TEMPLATE_VERSION } from './_version.js';

// Anything that looks like a credential, however it is phrased: the keyword
// ("key" alone included), optionally "is" / "was", a few separator
// characters, then the value. Long opaque blobs (tokens, JWTs, hex secrets)
// are caught on their own as well, wherever they appear.
const REDACT = /\b(api[-_ ]?key|key|password|passwd|secret|token|bearer|authorization)\b(?:\s+(?:is|was))?[\s:="']{0,4}\S{4,}/gi;
const OPAQUE = /\b[A-Za-z0-9_-]{32,}\b/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

const scrub = (v) => (typeof v === 'string'
  ? v.replace(REDACT, '$1=<redacted>').replace(OPAQUE, '<redacted>').replace(EMAIL, '<email>').slice(0, 500)
  : v);

export function logEvent(evt, fields = {}) {
  try {
    const clean = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, scrub(v)]));
    console.error(JSON.stringify({ evt, at: new Date().toISOString(), templateVersion: TEMPLATE_VERSION, ...clean }));
  } catch { /* logging must never throw */ }
}

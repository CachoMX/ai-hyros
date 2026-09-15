/**
 * Structured server-side event log. One JSON line per event on stderr, which
 * Vercel keeps in the function's runtime logs — the only place a template
 * owner can look when a user reports "it failed". Never log API keys,
 * passwords, emails or lead data: ids, codes, tool names and timings only.
 */
import { TEMPLATE_VERSION } from './_version.js';

const REDACT = /(api[-_ ]?key|password|secret|token|bearer)\s*[:=]\s*\S+/gi;

export function logEvent(evt, fields = {}) {
  try {
    const clean = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k,
      typeof v === 'string' ? v.replace(REDACT, '$1=<redacted>').slice(0, 500) : v]));
    console.error(JSON.stringify({ evt, at: new Date().toISOString(), templateVersion: TEMPLATE_VERSION, ...clean }));
  } catch { /* logging must never throw */ }
}

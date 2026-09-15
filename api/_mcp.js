/**
 * Minimal MCP client for the HYROS MCP server.
 *
 * The server runs Spring AI's STATELESS transport (application.properties:
 * `spring.ai.mcp.server.protocol=STATELESS`) and routes on `/mcp`
 * (McpOAuthConstants.MCP_ENDPOINT_PATH). Stateless streamable-HTTP means every
 * call is a self-contained JSON-RPC POST — there is no session to hold open,
 * which is what makes this work from a serverless function at all.
 *
 * Auth is the `API-Key` header: "the same credential the public REST API
 * takes" (McpAuthenticationType.java). OAuth is the other accepted mode but
 * needs an interactive dance, so automation uses the key.
 *
 * Transport errors follow api-docs.hyros.com (REST v1.42 / MCP v1.0):
 *   401  wrong or missing key                       -> code 'auth'
 *   403  valid key missing a role, or a client the  -> code 'forbidden'
 *        agency may not target (never an invalid key)
 *   429  per-account rate limit, body {"error":"…"} -> retried after
 *        `Retry-After`, then code 'rate_limited'
 *
 * No SDK on purpose — this is plain fetch + JSON-RPC, zero dependencies.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request API key. The MCP is stateless and keyed per call, so "an
 * account" is just "a key": `runWithKey(key, fn)` makes every callTool inside
 * fn authenticate as that account. Outside it, HYROS_API_KEY (the primary
 * account from the environment) is used.
 */
const keyContext = new AsyncLocalStorage();

/**
 * `extra.accessibleAccountId` addresses an agency's CLIENT account through the
 * agency's own key (hyros_get_user_info → accessibleAccounts). The MCP docs
 * say to "pass it as accessible_account_id on other tools" but no tool schema
 * declares it, so `extra.clientMode` selects how it travels: 'arg' (a
 * top-level tool argument, the default), 'header' (an HTTP header), or 'both'.
 * _accounts.js probes which one the server honors before trusting either.
 */
export function runWithKey(apiKey, fn, extra = {}) {
  return keyContext.run({ apiKey, ...extra }, fn);
}

const ctx = () => keyContext.getStore() || {};

/** The HYROS MCP endpoint. Production is fixed; HYROS_MCP_URL overrides it (staging, mocks, tests). */
export const DEFAULT_MCP_URL = 'https://mcp.hyros.com/mcp';
export function mcpUrl() {
  return process.env.HYROS_MCP_URL || DEFAULT_MCP_URL;
}

function activeKey() {
  return ctx().apiKey || process.env.HYROS_API_KEY || '';
}

export class McpNotConfigured extends Error {
  constructor() {
    super('No HYROS API key is available for this account');
    this.name = 'McpNotConfigured';
    this.code = 'NOT_CONFIGURED';
  }
}

export class McpError extends Error {
  constructor(message, detail, code) {
    super(message);
    this.name = 'McpError';
    this.detail = detail;
    if (code) this.code = code;
  }
}

export function isConfigured() {
  return Boolean(activeKey());
}

/* ---------------- retry policy (429) ---------------- */

const MAX_RATE_LIMIT_RETRIES = 2;
const MAX_RETRY_WAIT_MS = 5000;
const DEFAULT_RETRY_WAIT_MS = 1000;
const RATE_LIMIT_TEXT = /request limit|rate limit|too many requests/i;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let _id = 0;

/**
 * The server text of a non-2xx body. The 429 body is `{"error":"<string>"}`,
 * the REST envelope is `{result:'ERROR', message:'…'}`, and a gateway may
 * answer plain text; keep whatever is there, capped.
 */
function errorText(text) {
  try {
    const body = JSON.parse(text);
    const msg = typeof body?.error === 'string' ? body.error
      : body?.error?.message || body?.message || body?.error_description || null;
    if (msg) return String(msg);
  } catch { /* not JSON */ }
  return String(text || '').trim().slice(0, 400);
}

/** Retry-After in ms (seconds per the docs; an HTTP date is tolerated too). */
function retryAfterMs(res) {
  const raw = res.headers.get('retry-after');
  if (!raw) return DEFAULT_RETRY_WAIT_MS;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : DEFAULT_RETRY_WAIT_MS;
}

/**
 * Streamable HTTP may answer with either application/json or an SSE stream
 * carrying the single response frame. Handle both.
 */
async function readRpcBody(res) {
  const ctype = res.headers.get('content-type') || '';
  const text = await res.text();

  if (ctype.includes('text/event-stream')) {
    // Take the last non-empty `data:` payload that parses as JSON.
    let last = null;
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try { last = JSON.parse(payload); } catch { /* keep scanning */ }
    }
    if (!last) throw new McpError('No JSON frame in SSE response', text.slice(0, 400));
    return last;
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new McpError(`Non-JSON response (HTTP ${res.status})`, text.slice(0, 400));
  }
}

/** One HTTP round trip. Returns the JSON-RPC result, or `{ rateLimited }` for a 429. */
async function attempt(method, params, headers, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(mcpUrl(), {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: ++_id, method, params }),
      signal: ctrl.signal,
    });

    if (res.status === 429) {
      const text = errorText(await res.text());
      return { rateLimited: true, waitMs: retryAfterMs(res), message: text || 'You have reached the MCP request limit' };
    }
    if (res.status === 401) {
      const text = errorText(await res.text());
      throw new McpError(`MCP rejected the API key (HTTP 401)${text ? `: ${text}` : ''}`, text, 'auth');
    }
    if (res.status === 403) {
      const text = errorText(await res.text());
      throw new McpError(`MCP refused the request (HTTP 403)${text ? `: ${text}` : ''}`, text, 'forbidden');
    }
    if (!res.ok) {
      const text = errorText(await res.text());
      throw new McpError(`MCP answered HTTP ${res.status}${text ? `: ${text}` : ''}`, text);
    }

    const body = await readRpcBody(res);
    if (body.error) {
      const msg = typeof body.error === 'string' ? body.error : body.error.message || 'MCP error';
      if (RATE_LIMIT_TEXT.test(msg)) return { rateLimited: true, waitMs: DEFAULT_RETRY_WAIT_MS, message: msg };
      throw new McpError(msg, body.error);
    }
    return { result: body.result };
  } catch (err) {
    if (err.name === 'AbortError') throw new McpError(`MCP call timed out after ${timeoutMs}ms`, null, 'timeout');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A JSON-RPC call with the 429 policy: wait min(Retry-After, 5 s, what is
 * left of the timeout) and retry up to twice, then surface `rate_limited`
 * with the server's own text so the caller can decide (the snapshot builder
 * retries on the next range instead of blacklisting the account).
 */
async function rpc(method, params, { timeoutMs = 25000 } = {}) {
  if (!isConfigured()) throw new McpNotConfigured();

  const { accessibleAccountId, clientMode = 'arg' } = ctx();
  const headers = {
    'content-type': 'application/json',
    // Advertise both so the server may pick either transport encoding.
    accept: 'application/json, text/event-stream',
    'API-Key': activeKey(),
  };
  if (accessibleAccountId && (clientMode === 'header' || clientMode === 'both')) {
    headers['Accessible-Account-Id'] = accessibleAccountId;
  }
  if (accessibleAccountId && method === 'tools/call' && (clientMode === 'arg' || clientMode === 'both')) {
    params = { ...params, arguments: { ...(params.arguments || {}), accessible_account_id: accessibleAccountId } };
  }

  const started = Date.now();
  for (let tries = 0; ; tries += 1) {
    const left = timeoutMs - (Date.now() - started);
    if (left <= 0) throw new McpError(`MCP call timed out after ${timeoutMs}ms`, null, 'timeout');
    const out = await attempt(method, params, headers, left);
    if (!out.rateLimited) return out.result;
    const wait = Math.min(out.waitMs, MAX_RETRY_WAIT_MS, timeoutMs - (Date.now() - started));
    if (tries >= MAX_RATE_LIMIT_RETRIES || wait < 0) {
      throw new McpError(`MCP rate limit (HTTP 429): ${out.message}`, { retries: tries }, 'rate_limited');
    }
    await sleep(wait);
  }
}

/** List the tools the key can see. Cheap end-to-end connectivity probe. */
export async function listTools() {
  const result = await rpc('tools/list', {});
  return (result?.tools || []).map((t) => t.name);
}

/**
 * Call one MCP tool and return its decoded payload.
 *
 * Tool results arrive as `{ content: [{type:'text', text:'<json>'}] }` and
 * sometimes also as `structuredContent`. Prefer the structured form, fall back
 * to parsing the text block, and finally hand back the raw text.
 */
export async function callTool(name, args = {}, opts = {}) {
  const result = await rpc('tools/call', { name, arguments: args }, opts);

  if (result?.isError) {
    const msg = result?.content?.map((c) => c.text).join('\n') || 'tool reported an error';
    throw new McpError(`${name}: ${msg}`, null, RATE_LIMIT_TEXT.test(msg) ? 'rate_limited' : undefined);
  }
  if (result?.structuredContent !== undefined) return result.structuredContent;

  const text = (result?.content || [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('');

  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

/** "An invalid or expired pagination cursor is rejected with 400" — the tool error names the cursor. */
const CURSOR_ERROR = /page ?id|cursor|pagination/i;

/**
 * Walk a paginated HYROS tool (`{ result: [...], nextPageId }`) and say how
 * far it got:
 *   { rows, pages, truncated, error? }
 * `truncated` is true when `maxPages` was reached with a nextPageId still
 * present, when `deadline` (ms epoch) arrived first (`error: 'time budget'`),
 * or when the server rejected the cursor mid-way (`error: <server text>`) —
 * in that last case the rows fetched so far are returned instead of thrown
 * away. Any other failure still throws (rate limit, auth, tool errors).
 */
export async function callToolPagedInfo(name, args = {}, { maxPages = 20, pageSize = 250, deadline = null, timeoutMs } = {}) {
  const rows = [];
  const opts = timeoutMs ? { timeoutMs } : {};
  let pageId;
  let pages = 0;
  for (let page = 0; page < maxPages; page += 1) {
    if (deadline && Date.now() >= deadline) return { rows, pages, truncated: true, error: 'time budget' };
    const req = { ...args.request, pageSize, ...(pageId ? { pageId } : {}) };
    let body;
    try {
      body = await callTool(name, { ...args, request: req }, opts);
    } catch (err) {
      if (pages > 0 && !err.code && CURSOR_ERROR.test(err.message || '')) {
        return { rows, pages, truncated: true, error: err.message };
      }
      throw err;
    }
    pages += 1;
    rows.push(...(Array.isArray(body) ? body : body?.result || []));
    pageId = Array.isArray(body) ? null : body?.nextPageId;
    if (!pageId) return { rows, pages, truncated: false };
  }
  return { rows, pages, truncated: true };
}

/** Rows only — the same walk for callers that do not need the truncation signal. */
export async function callToolPaged(name, args = {}, opts = {}) {
  return (await callToolPagedInfo(name, args, opts)).rows;
}

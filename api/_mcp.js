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
  constructor(message, detail) {
    super(message);
    this.name = 'McpError';
    this.detail = detail;
  }
}

export function isConfigured() {
  return Boolean(activeKey());
}

let _id = 0;

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

async function rpc(method, params, { timeoutMs = 25000 } = {}) {
  if (!isConfigured()) throw new McpNotConfigured();

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
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
  try {
    const res = await fetch(mcpUrl(), {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: ++_id, method, params }),
      signal: ctrl.signal,
    });

    if (res.status === 401 || res.status === 403) {
      const err = new McpError(`MCP rejected the API key (HTTP ${res.status})`);
      err.code = 'auth';
      throw err;
    }

    const body = await readRpcBody(res);
    if (body.error) {
      throw new McpError(body.error.message || 'MCP error', body.error);
    }
    return body.result;
  } catch (err) {
    if (err.name === 'AbortError') throw new McpError(`MCP call timed out after ${timeoutMs}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
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
    throw new McpError(`${name}: ${msg}`);
  }
  if (result?.structuredContent !== undefined) return result.structuredContent;

  const text = (result?.content || [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('');

  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

/**
 * Walk a paginated HYROS tool to completion.
 * These tools return `{ result: [...], nextPageId }`.
 */
export async function callToolPaged(name, args = {}, { maxPages = 20, pageSize = 250 } = {}) {
  const out = [];
  let pageId;
  for (let page = 0; page < maxPages; page += 1) {
    const req = { ...args.request, pageSize, ...(pageId ? { pageId } : {}) };
    const body = await callTool(name, { ...args, request: req });
    const rows = Array.isArray(body) ? body : body?.result || [];
    out.push(...rows);
    pageId = Array.isArray(body) ? null : body?.nextPageId;
    if (!pageId) break;
  }
  return out;
}

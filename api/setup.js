/**
 * /api/setup — the self-serve first-run flow.
 *
 *   GET                       setup state (no secrets; unauthenticated so the
 *                             page can show the right screen before sign-in)
 *   GET  ?secrets=1           + the generated ACCOUNT_KEY_SECRET / CRON_SECRET
 *                             still held in KV (password-gated; for hardening)
 *   POST {action:'setup', password, apiKey?, agency?}
 *                             first load only: the key is checked with HYROS FIRST
 *                             (nothing is written on a bad key), then the store is
 *                             wiped (fresh start), the password + generated secrets
 *                             are saved and the account is added
 *   POST {action:'change-password', password}  password-gated; KV passwords only
 *   POST {action:'harden'}                     drop generated secrets that now match the env
 *   POST {action:'reset', confirm:'RESET'}     factory reset — every app key in KV
 */
import { checkAccess, deny } from './_auth.js';
import { setupState, setPassword, changePassword, pendingSecrets, harden, factoryReset } from './_setup.js';
import { probeKey, addAccount } from './_accounts.js';
import { storeConfigured } from './_store.js';
import { logEvent } from './_log.js';

/**
 * What the user should DO for each MCP error code (the client maps the same
 * codes; this copy is for anyone reading the JSON directly). Anything else
 * keeps the server's own text.
 */
const CODE_COPY = {
  auth: 'HYROS rejected that key — copy it again from HYROS → Settings → API.',
  forbidden: 'The key is valid but this account cannot use the MCP. Ask HYROS support to enable MCP access for it (it is granted per account).',
  rate_limited: 'HYROS is rate-limiting this account; wait a minute and try again.',
  NOT_CONFIGURED: 'No HYROS API key is available for this account — storage may not be set up, or the key was never saved. Add the account again from the account menu.',
};
const CODE_STATUS = { auth: 400, forbidden: 403, rate_limited: 429, NOT_CONFIGURED: 503 };

/**
 * The JSON body for a failed request. `error` keeps the historical value
 * (bad_key for any MCP rejection) so existing callers still match; `code`
 * carries the MCP error's own code (auth | forbidden | rate_limited |
 * NOT_CONFIGURED) so the client can show actionable copy; `detail` keeps
 * the raw server text when the message was replaced.
 */
export function errorBody(err) {
  const mcp = err?.name === 'McpError';
  const code = err?.code || (mcp ? 'mcp' : err?.name || 'error');
  const copy = CODE_COPY[code] || null;
  const message = copy || (mcp ? `HYROS rejected that key: ${err.message}` : err?.message || 'Unknown error');
  return {
    ok: false,
    error: mcp ? 'bad_key' : (err?.code || err?.name || 'error'),
    code,
    message,
    ...(copy || mcp ? { detail: err?.message } : {}),
  };
}

/** HTTP status for a failed request: the error's own, else by code, else 400 for MCP rejections. */
export function errorStatus(err) {
  return err?.status || CODE_STATUS[err?.code] || (err?.name === 'McpError' ? 400 : 500);
}

/** First run: validate the key before touching the store, then password → wipe → account. */
async function firstRun({ password, apiKey, agency }) {
  const key = String(apiKey || '').trim();
  if (!storeConfigured()) throw Object.assign(new Error('Storage is not set up yet — add the Upstash Redis store first.'), { status: 503, code: 'needs_storage' });
  if (String(password || '').length < 8) throw Object.assign(new Error('Use at least 8 characters for the password.'), { status: 400, code: 'weak' });
  if (key) {
    if (key.length < 8) throw Object.assign(new Error('That does not look like a HYROS API key.'), { status: 400, code: 'bad_key' });
    await probeKey(key); // throws McpError on a rejected key — before anything is written
  }
  await setPassword(password);
  let added = null;
  if (key) added = await addAccount(key, { agency: Boolean(agency) });
  return { ...(await setupState()), ...(added || {}) };
}

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  try {
    if (req.method === 'GET') {
      const url = new URL(req.url, `http://${req.headers.host || 'local'}`);
      const out = { ok: true, ...(await setupState()) };
      if (url.searchParams.get('secrets')) {
        const access = await checkAccess(req);
        if (!access.ok) return deny(res, access);
        out.secrets = await pendingSecrets();
      }
      return res.status(200).json(out);
    }
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

    const body = req.body || {};
    if (body.action === 'setup') {
      return res.status(200).json({ ok: true, ...(await firstRun(body)) });
    }
    const access = await checkAccess(req);
    if (!access.ok) return deny(res, access);
    if (body.action === 'change-password') return res.status(200).json({ ok: true, ...(await changePassword(body.password)) });
    if (body.action === 'harden') return res.status(200).json({ ok: true, ...(await harden()) });
    if (body.action === 'reset') {
      if (body.confirm !== 'RESET') return res.status(400).json({ ok: false, error: 'confirm', message: 'Type RESET to confirm.' });
      return res.status(200).json({ ok: true, ...(await factoryReset()) });
    }
    return res.status(400).json({ ok: false, error: 'bad_request', message: 'Unknown action.' });
  } catch (err) {
    const body = errorBody(err);
    // Ids, codes and actions only — never the key, password or message text.
    logEvent('setup.error', { action: req.body?.action || req.method, code: body.code, status: errorStatus(err) });
    return res.status(errorStatus(err)).json(body);
  }
}

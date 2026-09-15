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
    const bad = err.name === 'McpError';
    return res.status(err.status || (bad ? 400 : 500)).json({
      ok: false, error: bad ? 'bad_key' : (err.code || err.name || 'error'),
      message: bad ? `HYROS rejected that key: ${err.message}` : err.message,
    });
  }
}

/**
 * /api/accounts — the account selector's backend.
 *
 *   GET            list accounts (ids + labels + last refresh; never keys)
 *   POST {apiKey}  validate the key against the MCP, encrypt and store it
 *   DELETE ?id=    forget an added account and its snapshot/settings
 *
 * Adding/removing keys is refused unless the dashboard is password-gated
 * (REPORT_PASSWORD) and ACCOUNT_KEY_SECRET is set — a HYROS API key is full
 * access to a customer's data and must never be storable from an open page.
 */
import { checkAccess, deny, passwordConfigured } from './_auth.js';
import { listAccounts, addAccount, removeAccount, importClients, syncClients, replaceKey, accountsEnabled, defaultAccountId } from './_accounts.js';
import { storeConfigured } from './_store.js';

export default async function handler(req, res) {
  const access = await checkAccess(req);
  if (!access.ok) return deny(res, access);

  if (req.method === 'GET') {
    const accounts = await listAccounts({ withStatus: true });
    return res.status(200).json({
      ok: true, accounts, defaultId: await defaultAccountId(),
      canAdd: accountsEnabled() && passwordConfigured(),
      message: !storeConfigured() ? 'Storage is not set up — added accounts cannot be stored.'
        : !accountsEnabled() ? 'No encryption secret — set a password on the setup screen (it generates one) or set ACCOUNT_KEY_SECRET.'
        : undefined,
    });
  }

  if (!passwordConfigured() || !accountsEnabled()) {
    return res.status(403).json({ ok: false, error: 'accounts_disabled', message: 'Adding accounts needs storage, a dashboard password and an encryption secret (the setup screen provides all three).' });
  }

  try {
    if (req.method === 'POST') {
      const body = req.body || {};
      if (body.action === 'import-clients') {
        return res.status(200).json({ ok: true, ...(await importClients(String(body.id || ''), { offset: Number(body.offset) || 0 })) });
      }
      if (body.action === 'sync-clients') {
        const r = await syncClients(String(body.id || ''));
        return res.status(r ? 200 : 404).json(r ? { ok: true, ...r } : { ok: false, error: 'not_found' });
      }
      if (body.action === 'replace-key') {
        return res.status(200).json({ ok: true, account: await replaceKey(String(body.id || ''), body.apiKey) });
      }
      const added = await addAccount(body.apiKey, { agency: Boolean(body.agency) });
      return res.status(200).json({ ok: true, ...added });
    }
    if (req.method === 'DELETE') {
      const url = new URL(req.url, `http://${req.headers.host || 'local'}`);
      const id = url.searchParams.get('id') || '';
      const removed = await removeAccount(id);
      return res.status(removed ? 200 : 404).json({ ok: removed, error: removed ? undefined : 'not_found' });
    }
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  } catch (err) {
    const status = err.status || (err.name === 'McpError' ? 400 : 500);
    return res.status(status).json({
      ok: false, error: err.name === 'McpError' ? 'bad_key' : (err.name || 'error'),
      message: err.name === 'McpError' ? `HYROS rejected that key: ${err.message}` : err.message,
    });
  }
}

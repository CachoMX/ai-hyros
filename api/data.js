/**
 * GET /api/data  -> the current snapshot for the selected (or default) account.
 *
 * Read from KV (written by /api/refresh). `origin: 'none'` means the account
 * has no build yet — the client triggers its first build. With no account
 * connected at all the dashboard shows the Demo account, which is generated
 * in the browser and never touches this route.
 */
import { checkAccess, deny } from './_auth.js';
import { readSnapshot, readPrefs, storeConfigured } from './_store.js';
import { accountFromReq } from './_accounts.js';
import { TEMPLATE_VERSION } from './_version.js';

export default async function handler(req, res) {
  const access = await checkAccess(req);
  if (!access.ok) return deny(res, access);

  const account = await accountFromReq(req);
  let snapshot = null;
  let origin = 'none';
  let prefs = null;

  if (storeConfigured() && account) {
    [snapshot, prefs] = await Promise.all([readSnapshot(account), readPrefs(account)]);
    if (snapshot) origin = 'kv';
  }

  res.setHeader('cache-control', 'no-store');
  res.status(200).json({
    ok: true,
    templateVersion: TEMPLATE_VERSION,
    origin,
    account,
    prefs,
    capabilities: {
      mcpConfigured: Boolean(account),
      storeConfigured: storeConfigured(),
    },
    snapshot,
  });
}

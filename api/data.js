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
import { sendJsonResponse, setPrivateResponseHeaders } from './_response.js';

export function createDataHandler(deps = {}) {
  const accessCheck = deps.checkAccess || checkAccess;
  const accountFor = deps.accountFromReq || accountFromReq;
  const read = deps.readSnapshot || readSnapshot;
  const prefsFor = deps.readPrefs || readPrefs;
  const configured = deps.storeConfigured || storeConfigured;
  return async function handler(req, res) {
    setPrivateResponseHeaders(res);
    const access = await accessCheck(req);
    if (!access.ok) return deny(res, access);

    const account = await accountFor(req);
    let snapshot = null;
    let origin = 'none';
    let prefs = null;
    const hasStore = configured();

    if (hasStore && account) {
      [snapshot, prefs] = await Promise.all([read(account), prefsFor(account)]);
      if (snapshot) origin = 'kv';
    }

    return sendJsonResponse(req, res, {
      ok: true,
      templateVersion: TEMPLATE_VERSION,
      origin,
      account,
      prefs,
      capabilities: {
        mcpConfigured: Boolean(account),
        storeConfigured: hasStore,
      },
      snapshot,
    });
  };
}

export default createDataHandler();

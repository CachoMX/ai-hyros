/**
 * GET /api/health -> prove the MCP leg end-to-end without building a snapshot.
 * This is the first thing to hit once the URL + key land.
 */
import { checkAccess, deny } from './_auth.js';
import { listTools, callTool, mcpUrl } from './_mcp.js';
import { storeConfigured, storeCredentials } from './_store.js';
import { accountFromReq, asAccount } from './_accounts.js';
import { setupState } from './_setup.js';

export default async function handler(req, res) {
  const access = await checkAccess(req);
  if (!access.ok) return deny(res, access);

  const setup = await setupState();
  const accountId = await accountFromReq(req);
  const out = {
    ok: true,
    setup: setup.state,
    mcpUrl: mcpUrl(),
    account: accountId,
    storeConfigured: storeConfigured(),
    storeVars: storeCredentials()?.via || 'none — snapshots will not persist',
    cronSecret: setup.cronSecret,
    passwordSource: setup.passwordSource,
    keySecret: setup.keySecret,
  };

  if (!accountId) {
    out.ok = false;
    out.message = 'No HYROS account is connected yet — add one from the account menu.';
    return res.status(200).json(out);
  }

  try {
    await asAccount(accountId, async () => {
      const tools = await listTools();
      out.toolCount = tools.length;
      out.hasAttributionTool = tools.includes('hyros_get_attribution_report');

      const user = await callTool('hyros_get_user_info', {});
      out.accountEmail = user?.userProfile?.email || null;
      out.timezone = user?.userProfile?.timezone || null;
    });
  } catch (err) {
    out.ok = false;
    out.error = err.name;
    out.message = err.message;
  }
  res.status(out.ok ? 200 : 502).json(out);
}

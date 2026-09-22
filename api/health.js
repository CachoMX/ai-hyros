/**
 * GET /api/health -> prove the MCP leg end-to-end without building a snapshot.
 * This is the first thing to hit once the URL + key land.
 */
import { checkAccess, deny } from './_auth.js';
import { listTools, callTool, mcpUrl } from './_mcp.js';
import { storeConfigured, storeCredentials } from './_store.js';
import { accountFromReq, asAccount } from './_accounts.js';
import { setupState } from './_setup.js';
import { TEMPLATE_VERSION } from './_version.js';

/**
 * Every MCP tool the dashboard calls (core pipeline, drill, Scale Advisor,
 * Tracking Health). `missingTools` in the answer lists the ones the key's
 * tools/list does not expose — a tab that stays empty usually traces to one
 * of these.
 */
export const REQUIRED_TOOLS = [
  'hyros_get_user_info', 'hyros_get_ad_accounts', 'hyros_get_sources',
  'hyros_get_attribution_report', 'hyros_get_leads', 'hyros_get_sales',
  'hyros_get_calls', 'hyros_get_subscriptions', 'hyros_get_stages',
  'hyros_get_lead_journey', 'hyros_get_lead_clicks', 'hyros_get_domains',
  'hyros_assert_script_presence_on_domain',
  'hyros_check_tracking_parameters_for_integrations',
  'hyros_get_marginal_cac_curve',
];

/** The required tools absent from a tools/list answer (names only). */
export function missingTools(names) {
  const have = new Set(Array.isArray(names) ? names : []);
  return REQUIRED_TOOLS.filter((t) => !have.has(t));
}

export default async function handler(req, res) {
  const access = await checkAccess(req);
  if (!access.ok) return deny(res, access);

  const setup = await setupState();
  const accountId = await accountFromReq(req);
  const out = {
    ok: true,
    templateVersion: TEMPLATE_VERSION,
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
      out.missingTools = missingTools(tools);

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

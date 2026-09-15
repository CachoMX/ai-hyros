/**
 * Mock HYROS MCP — a stateless JSON-RPC server that answers the tools the
 * snapshot pipeline calls with synthetic payloads in the shapes the real MCP
 * returns (Sept 2026 surface: parentId on ad rows, updatedFromDate on leads,
 * marginal CAC curves, domain script checks, tracking-parameter checks).
 *
 *   node scripts/mock-mcp.mjs            # listens on :4322
 *   HYROS_MCP_URL=http://127.0.0.1:4322/mcp HYROS_API_KEY=mock node scripts/pipeline-test.mjs
 *
 * Every request is logged (tool name + the request fields the pipeline
 * sends) so a test can assert WHAT the pipeline asked for, not just what it
 * rendered.
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.MOCK_MCP_PORT) || 4322;
export const calls = [];

/** A tool-level failure: the dispatcher turns it into an isError reply, like the real MCP. */
class ToolError extends Error {}

// Ad accounts of every type the real MCP reports, plus one that is connected
// but broken (9007) so the pipeline's per-account isolation is exercised.
const AD_ACCOUNTS = [
  { id: '9001', name: 'Mock Meta', type: 'FACEBOOK' },
  { id: '9002', name: 'Mock Google', type: 'GOOGLE' },
  { id: '9003', name: 'Mock Snap', type: 'SNAPCHAT' },
  { id: '9004', name: 'Mock LinkedIn', type: 'LINKEDIN' },
  { id: '9005', name: 'Mock Google V2', type: 'GOOGLE_V2' },
  { id: '9006', name: 'Mock Reddit', type: 'REDDIT' },
  { id: '9007', name: 'Mock TikTok (broken)', type: 'TIKTOK' },
];

// The `level` enum of GET /attribution (api-docs.hyros.com), per integration.
// The real MCP rejects any other combination with the message mirrored below.
const LEVELS_FOR = {
  FACEBOOK: ['facebook_campaign', 'facebook_adset', 'facebook_ad'],
  GOOGLE: ['google_campaign', 'google_ad'],
  GOOGLE_V2: ['google_v2_adgroup', 'google_v2_keyword'],
  TIKTOK: ['tiktok_adgroup', 'tiktok_ad'],
  SNAPCHAT: ['snapchat_adsquad', 'snapchat_ad'],
  PINTEREST: ['pinterest_adgroup', 'pinterest_ad'],
  TWITTER: ['twitter_adgroup'],
  BING: ['bing_adgroup', 'bing_ad'],
  LINKEDIN: ['linkedin_campaign'],
  REDDIT: [],
};

const ADSETS = [
  { id: 'as-1', name: 'Prospecting Broad', tag: '@as-1', category: 'Prospecting', cost: 900, revenue: 3200, sales: 24, leads: 80, clicks: 1200 },
  { id: 'as-2', name: 'Powerset', tag: '@as-2', category: 'Retargeting', cost: 300, revenue: 1800, sales: 15, leads: 30, clicks: 400 },
  { id: 'as-3', name: 'Powerset', tag: '@as-3', category: 'Prospecting', cost: 250, revenue: 500, sales: 4, leads: 22, clicks: 350 },
];
const ADS = [
  { id: 'ad-1', name: 'UGC Hook', parentId: 'as-1', parentName: 'Prospecting Broad', cost: 600, revenue: 2400, sales: 18, leads: 55, clicks: 800 },
  { id: 'ad-2', name: 'Static Offer', parentId: 'as-1', parentName: 'Prospecting Broad', cost: 300, revenue: 800, sales: 6, leads: 25, clicks: 400 },
  { id: 'ad-3', name: 'Carousel', parentId: 'as-2', parentName: 'Powerset', cost: 300, revenue: 1800, sales: 15, leads: 30, clicks: 400 },
  { id: 'ad-4', name: 'Founder Story', parentId: 'as-3', parentName: 'Powerset', cost: 250, revenue: 500, sales: 4, leads: 22, clicks: 350 },
];

const lead = (i, joined, updated, stage = 'Lead') => ({
  id: `lead-${i}`, email: `lead${i}@example.test`, firstName: `Lead`, lastName: String(i),
  creationDate: joined, lastUpdatedDate: updated, tags: ['!site', '@as-1'],
  currentStage: { name: stage, date: updated }, adOptimizationConsent: 'GRANTED',
  firstSource: { name: 'Prospecting Broad', tag: '@as-1', organic: false, clickDate: joined },
  lastSource: { name: 'Prospecting Broad', tag: '@as-1', organic: false, clickDate: joined },
  phoneNumbers: [],
});

const CLIENTS = [1, 2, 3, 4, 5, 6, 7].map((i) => ({ accountId: `c${i}`, email: `client${i}@example.test`, companyName: `Client ${i}`, firstName: 'C', lastName: String(i), status: i === 7 ? 'PENDING' : 'APPROVED' }));

const TOOLS = {
  // `_key` / `_client` are the request context the mock server passes in.
  hyros_get_user_info: (args, { key, client }) => (client
    ? { userProfile: { email: `client${client.slice(1)}@example.test`, timezone: '-05:00' }, trueTrackingData: {}, allowedAccounts: [], accessibleAccounts: [] }
    : {
      userProfile: { email: key === 'agency-key' ? 'agency@example.test' : 'mock@hyros.test', timezone: '-05:00' },
      trueTrackingData: { OUTBOUND_CURRENCY: 'USD', LEAD_ATTRIBUTION_TIMEFRAME: '7' },
      allowedAccounts: key === 'agency-key' ? [] : [{ accountId: 'agency-9', email: 'agency@example.test', companyName: 'Agency', status: 'APPROVED' }],
      accessibleAccounts: key === 'agency-key' ? CLIENTS : [],
    }),
  hyros_get_ad_accounts: () => ({ result: AD_ACCOUNTS, nextPageId: null }),
  hyros_get_sources: () => ({
    result: [
      ...ADSETS.map((a) => ({
        name: a.name, tag: a.tag, category: { name: a.category }, trafficSource: { name: 'facebook' },
        adSource: { adSourceId: a.id, adAccountId: '9001', platform: 'FACEBOOK' },
      })),
      // The real source list covers every connected platform, one per source link.
      ...AD_ACCOUNTS.filter((acct) => acct.id !== '9001').map((acct) => ({
        name: `${acct.name} row`, tag: `@${acct.id}-1`, category: { name: 'Prospecting' }, trafficSource: { name: acct.type.toLowerCase() },
        adSource: { adSourceId: `${acct.id}-1`, adAccountId: acct.id, platform: acct.type },
      })),
    ],
    nextPageId: null,
  }),
  hyros_get_attribution_report: ({ request }) => {
    const acct = AD_ACCOUNTS.find((a) => a.id === String(request.ids[0]));
    if (!acct) return { result: [], nextPageId: null };
    const level = String(request.level || '').toLowerCase();
    if (!(LEVELS_FOR[acct.type] || []).includes(level)) {
      throw new ToolError(`Unsupported level type ${level} for user integration: ${acct.type}. Product ID: 1`);
    }
    if (acct.id === '9007') throw new ToolError('Ad account integration is disconnected');
    if (acct.id !== '9001') {
      // One row per non-Meta account so the pipeline can be seen to carry it.
      const row = { id: `${acct.id}-1`, name: `${acct.name} row`, cost: 100, revenue: 300, sales: 2, leads: 5, clicks: 50 };
      return { result: [/_ad$/.test(level) ? { ...row, id: `${acct.id}-ad-1`, parentId: row.id, parentName: row.name } : row], nextPageId: null };
    }
    const rows = /_ad$/.test(level) ? ADS : ADSETS;
    return { result: rows.map((r) => ({ ...r, impressions: r.clicks * 40, totalRevenue: r.revenue, reportedResult: r.revenue * 0.7 })), nextPageId: null };
  },
  hyros_get_stages: () => ({ result: [{ name: 'Lead', amount: 120 }, { name: 'Customer', amount: 40 }], nextPageId: null }),
  hyros_get_leads: ({ request }) => {
    if (request.updatedFromDate) {
      // Incremental pull: one changed lead (stage moved) + one brand-new lead.
      return { result: [lead(1, '2026-09-02T10:00:00-05:00', '2026-09-13T09:00:00-05:00', 'Customer'), lead(9, '2026-09-13T08:00:00-05:00', '2026-09-13T08:00:00-05:00')], nextPageId: null };
    }
    if (request.tags) return { result: [lead(1, '2026-09-02T10:00:00-05:00', '2026-09-02T10:00:00-05:00')], nextPageId: null };
    return { result: [1, 2, 3].map((i) => lead(i, `2026-09-0${i}T10:00:00-05:00`, `2026-09-0${i}T10:00:00-05:00`)), nextPageId: null };
  },
  hyros_get_sales: () => ({ result: [{ id: 's1', lead: { email: 'lead1@example.test', firstName: 'Lead', lastName: '1' }, creationDate: '2026-09-05T12:00:00-05:00', usdPrice: { price: 149, currency: 'USD' }, product: { name: 'Bundle' }, firstSource: { name: 'Prospecting Broad' }, lastSource: { name: 'Prospecting Broad' } }], nextPageId: null }),
  hyros_get_calls: () => ({ result: [], nextPageId: null }),
  hyros_get_subscriptions: () => ({ result: [], nextPageId: null }),
  hyros_get_marginal_cac_curve: ({ request }) => ({
    id: request.id, level: request.level, startDate: request.startDate, endDate: request.endDate,
    attributionModel: 'FIRST_CLICK', daysSampled: 42, cacCeiling: request.cacCeiling ?? 95, ceilingBasis: request.cacCeiling ? 'CALLER_PROVIDED' : 'REALIZED_LTV_90_DAYS',
    curve: [20, 40, 60, 80, 100].map((spend) => ({ dailySpend: spend, averageCac: 40 + spend * 0.3, marginalCac: 40 + spend * 0.8, customers: Math.round(spend / (40 + spend * 0.3)) })),
    saturationPoint: { dailySpend: 70 }, notes: [],
  }),
  hyros_get_domains: () => ['mock.example.test', 'shop.mock.example.test'],
  hyros_assert_script_presence_on_domain: ({ domains }) => Object.fromEntries(domains.map((d, i) => [d, i ? 'SCRIPT_NOT_FOUND' : 'SCRIPT_FOUND'])),
  hyros_check_tracking_parameters_for_integrations: ({ request }) => ({ result: [{ adName: `${request.type} ad 1`, valid: true }, { adName: `${request.type} ad 2`, valid: false, missing: ['gclid'] }] }),
};

export function startMock(port = PORT) {
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const rpc = JSON.parse(body || '{}');
    const reply = (result) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result })); };
    if (rpc.method === 'tools/list') return reply({ tools: Object.keys(TOOLS).map((name) => ({ name })) });
    const key = req.headers['api-key'] || null;
    if (key === 'dead-key') { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":"invalid api key"}'); }
    if (rpc.method === 'tools/call') {
      const { name, arguments: args = {} } = rpc.params || {};
      // The real MCP documents accessible_account_id "on other tools"; the mock honors the ARGUMENT form only.
      const client = args.accessible_account_id || null;
      calls.push({ name, args, apiKey: key, client, headerClient: req.headers['accessible-account-id'] || null });
      const fn = TOOLS[name];
      if (!fn) return reply({ isError: true, content: [{ type: 'text', text: `unknown tool ${name}` }] });
      try {
        return reply({ content: [{ type: 'text', text: JSON.stringify(fn(args, { key, client })) }] });
      } catch (err) {
        if (err instanceof ToolError) return reply({ isError: true, content: [{ type: 'text', text: err.message }] });
        throw err;
      }
    }
    reply({});
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startMock().then(() => console.log(`mock MCP on http://127.0.0.1:${PORT}/mcp`));
}

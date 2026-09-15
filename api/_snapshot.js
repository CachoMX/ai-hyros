/**
 * Snapshot builder — the whole "via the MCP" pipeline.
 *
 * Everything the dashboard renders is produced here, from MCP tool calls only.
 * The output is one flat JSON document; the front end never talks to HYROS.
 *
 * The level model mirrors HYROS's own (SourceNamingUtils.ts). For Meta:
 *   AD_ACCOUNT      -> "Account"
 *   SOURCE_CATEGORY -> "Campaign"     <- NOT a Meta campaign object
 *   SOURCE_LINK     -> "Ad Set"       <- the MCP's FACEBOOK_ADSET level
 *   SOURCE_LINK_AD  -> "Ad"           <- the MCP's FACEBOOK_AD level
 *
 * The MCP exposes no campaign/traffic-source grouping, so those two levels are
 * rolled up from the ad-set base table joined to `hyros_get_sources`, which
 * carries `category` and `trafficSource` per source. That reproduces the real
 * report's Campaign tab exactly.
 */

import { callTool, callToolPaged } from './_mcp.js';
import { runFeatureSteps } from './_features.js';
import { CATALOG, derive, aggregate, rollup } from '../public/shared/metrics.js';

// Request the ENTIRE catalog: the `fields` param drives computation (verified
// empirically — requested fields populate, unrequested come back null), and the
// response carries every key either way, so the marginal wire cost is zero.
// This is what makes column-adding instant client-side instead of per-refresh.
const REPORT_FIELDS = ['NAME', 'PARENT_NAME', ...CATALOG.map((c) => c.f)];

/* ---------------- date helpers (account timezone) ---------------- */

/** Offset like "-06:00" -> minutes. */
function offsetMinutes(tz) {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(tz || '');
  if (!m) return 0;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3]));
}

function ymdInTz(date, tz) {
  const shifted = new Date(date.getTime() + offsetMinutes(tz) * 60_000);
  return shifted.toISOString().slice(0, 10);
}

function addDays(ymd, days) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function buildRanges(now, tz) {
  const today = ymdInTz(now, tz);
  return {
    today:     { label: 'Today',        start: today,             end: today },
    yesterday: { label: 'Yesterday',    start: addDays(today, -1), end: addDays(today, -1) },
    '7d':      { label: 'Last 7 days',  start: addDays(today, -6), end: today },
    '30d':     { label: 'Last 30 days', start: addDays(today, -29), end: today },
  };
}

/* ---------------- normalisation ---------------- */

/**
 * Keep every catalog metric the API populated (null = not computed, dropped),
 * guarantee the core additive base exists so derived math is stable, then
 * re-derive. Null-stripping keeps the stored snapshot far smaller than the
 * wire payload even with the full catalog requested.
 */
const CORE_ZERO = ['cost', 'revenue', 'totalRevenue', 'sales', 'leads',
  'calls', 'clicks', 'impressions', 'reported'];

function normalizeRow(raw) {
  const row = {
    id: String(raw.id ?? ''),
    name: raw.name || null,
    parentName: raw.parentName || null,
    // Ad-level rows carry the parent source id since the Sept 2026 MCP
    // upgrade — the handle that makes ad-under-ad-set linkage exact.
    parentId: raw.parentId != null ? String(raw.parentId) : null,
  };
  for (const entry of CATALOG) {
    const v = entry.k === 'reported' ? raw.reportedResult : raw[entry.k];
    if (v !== null && v !== undefined) row[entry.k] = v;
  }
  for (const k of CORE_ZERO) row[k] = row[k] ?? 0;
  return derive(row);
}

/**
 * Report levels per ad-account type, named as the MCP's `level` enum names
 * them (api-docs.hyros.com, GET /attribution). `adset` is the SOURCE_LINK
 * level every platform has; `ad` exists only where the platform exposes one.
 * Classic Google and LinkedIn are tracked at campaign level, Google V2 stops
 * at ad group, Snapchat calls its ad set an "ad squad". Types missing here
 * (REDDIT, APPLOVIN, WHOP_ADS, …) have no attribution level and are skipped.
 */
export const LEVELS_BY_TYPE = {
  FACEBOOK:  { adset: 'FACEBOOK_ADSET',    ad: 'FACEBOOK_AD' },
  GOOGLE:    { adset: 'GOOGLE_CAMPAIGN',   ad: 'GOOGLE_AD' },
  GOOGLE_V2: { adset: 'GOOGLE_V2_ADGROUP', ad: null },
  TIKTOK:    { adset: 'TIKTOK_ADGROUP',    ad: 'TIKTOK_AD' },
  SNAPCHAT:  { adset: 'SNAPCHAT_ADSQUAD',  ad: 'SNAPCHAT_AD' },
  PINTEREST: { adset: 'PINTEREST_ADGROUP', ad: 'PINTEREST_AD' },
  TWITTER:   { adset: 'TWITTER_ADGROUP',   ad: null },
  BING:      { adset: 'BING_ADGROUP',      ad: 'BING_AD' },
  LINKEDIN:  { adset: 'LINKEDIN_CAMPAIGN', ad: null },
};

/* ---------------- report settings (saved via /api/prefs) ---------------- */

export const REPORT_MODELS = ['LAST_CLICK', 'FIRST_CLICK', 'SCIENTIFIC'];

/** Validate/normalize the saved report settings; unknown values fall to defaults. */
export function normalizeSettings(raw = {}) {
  const model = REPORT_MODELS.includes(raw?.model) ? raw.model
    : (REPORT_MODELS.includes(process.env.HYROS_ATTRIBUTION_MODEL) ? process.env.HYROS_ATTRIBUTION_MODEL : 'LAST_CLICK');
  const windowDays = Number.isInteger(raw?.windowDays) && raw.windowDays >= 0 && raw.windowDays <= 365
    ? raw.windowDays : 0;
  const leadStage = Array.isArray(raw?.leadStage)
    ? raw.leadStage.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim()).slice(0, 10)
    : [];
  return { model, windowDays, leadStage };
}

async function fetchLevel(level, adAccountId, range, settings) {
  const request = {
    attributionModel: settings.model,
    startDate: range.start,
    endDate: range.end,
    level,
    ids: [adAccountId],
    isAdAccountId: true,
    timeGroupingOption: 'SOURCE_LINK',
    pageSize: 250,
    // Newest sources first: on accounts with many inactive sources the
    // oldest-first default fills the page with ads that no longer run.
    newestFirst: true,
    // ALL_SOURCES + report visibility = what the account's own report screens use.
    sourceConfiguration: 'ALL_SOURCES',
    fields: REPORT_FIELDS,
  };
  // Per-query attribution window (LAST_CLICK only, per the API).
  if (settings.windowDays > 0 && settings.model === 'LAST_CLICK') {
    request.windowAttributionDaysRange = settings.windowDays;
  }
  // Funnel-outcome ranking: narrow leads/sales/revenue to leads in these stages.
  if (settings.leadStage.length) request.leadStage = settings.leadStage;

  const body = await callTool('hyros_get_attribution_report', { request });
  const rows = Array.isArray(body) ? body : body?.result || [];
  return rows.map(normalizeRow);
}

/* ---------------- level assembly ---------------- */

/**
 * Build all five report levels for one range from the ad-set + ad base tables.
 * `sourceById` maps an ad-set (source-link) id to its source metadata.
 */
export function buildLevels({ adsetRows, adRows, sourceById, adAccountName }) {
  // Ad-set rows sometimes come back with a null name; resolve from the source
  // table, and carry the source TAG — it's the handle the lead-drill uses
  // (get_leads({tags:[...]}) is a server-side cohort query).
  const adsets = adsetRows.map((r) => ({
    ...r,
    name: r.name || sourceById.get(r.id)?.name || r.id,
    tag: sourceById.get(r.id)?.tag || null,
    _category: sourceById.get(r.id)?.category || 'Uncategorised',
    _traffic: sourceById.get(r.id)?.trafficSource || 'unknown',
    _account: sourceById.get(r.id)?.adAccountId || null,
  }));

  const ads = adRows.map((r) => ({ ...r, name: r.name || r.id }));

  // Rolled-up rows drill with the union of their members' tags (the tags
  // filter on get_leads is OR semantics).
  const withTags = (rows, keyOf) => rows.map((row) => ({
    ...row,
    tags: [...new Set(adsets.filter((a) => keyOf(a) === row.id && a.tag).map((a) => a.tag))].slice(0, 40),
  }));

  return {
    traffic:  withTags(rollup(adsets, (r) => r._traffic, (id) => id), (a) => a._traffic),
    account:  withTags(rollup(adsets, (r) => r._account, (id) => adAccountName.get(id) || id || 'Unknown'), (a) => a._account),
    campaign: withTags(rollup(adsets, (r) => r._category, (id) => id), (a) => a._category),
    adset:    adsets,
    ad:       ads,
  };
}

/* ---------------- CRM ---------------- */

/** Flatten the source object the leads tool returns. */
function flattenSource(src) {
  if (!src) return null;
  return {
    name: src.name || null,
    tag: src.tag || null,
    organic: Boolean(src.organic),
    trafficSource: src.trafficSource?.name || null,
    category: src.category?.name || null,
    clickDate: src.clickDate || null,
  };
}

/**
 * Incremental lead sync (MCP upgrade: updatedFromDate/updatedToDate). Given
 * the previous snapshot's leads and the leads changed since it was built,
 * produce the current window: changed rows replace their older copies, rows
 * that joined before the window drop off. Exported for the self-test.
 */
export function mergeLeads(previousLeads, changedLeads, leadsFrom) {
  const byId = new Map();
  for (const l of previousLeads || []) if (l?.id) byId.set(l.id, l);
  for (const l of changedLeads || []) if (l?.id) byId.set(l.id, l);
  const floor = `${leadsFrom}T00:00:00`;
  return [...byId.values()]
    .filter((l) => !l.joined || String(l.joined).slice(0, 19) >= floor)
    .sort((a, b) => String(b.joined || '').localeCompare(String(a.joined || '')));
}

async function buildCrm({ leadsFrom, leadsTo, previous = null }) {
  // Incremental: when the previous snapshot is recent enough, pull only the
  // leads updated since it was built (a lead's lastUpdatedDate moves on
  // creation too, so new joins are included). Sales/calls/subscriptions have
  // no updated-since filter yet and are pulled in full.
  const prevLeads = previous?.crm?.leads;
  const prevAt = previous?.generatedAt ? String(previous.generatedAt).slice(0, 10) : null;
  const incremental = Array.isArray(prevLeads) && prevAt && prevAt >= addDays(leadsFrom, 1)
    && previous?.crm?.window?.from === leadsFrom;
  const leadsRequest = incremental
    ? { updatedFromDate: addDays(prevAt, -1), updatedToDate: leadsTo }
    : { fromDate: leadsFrom, toDate: leadsTo };

  const [leadsRaw, salesRaw, stagesRaw, callsRaw, subsRaw] = await Promise.all([
    callToolPaged('hyros_get_leads',
      { request: leadsRequest }, { maxPages: 4, pageSize: 250 }),
    callToolPaged('hyros_get_sales',
      { request: { fromDate: leadsFrom, toDate: leadsTo } }, { maxPages: 4, pageSize: 250 }),
    callToolPaged('hyros_get_stages', { request: {} }, { maxPages: 1, pageSize: 250 }),
    callToolPaged('hyros_get_calls',
      { request: { fromDate: leadsFrom, toDate: leadsTo } }, { maxPages: 4, pageSize: 250 }),
    callToolPaged('hyros_get_subscriptions',
      { request: { fromDate: leadsFrom, toDate: leadsTo } }, { maxPages: 2, pageSize: 250 }),
  ]);

  // Income per lead: the lead object has no revenue field, so join sales by email.
  const incomeByEmail = new Map();
  for (const sale of salesRaw) {
    const email = (sale.lead?.email || '').toLowerCase();
    if (!email) continue;
    const amount = sale.usdPrice?.price ?? sale.price?.price ?? 0;
    incomeByEmail.set(email, (incomeByEmail.get(email) || 0) + Number(amount || 0));
  }

  const fetchedLeads = leadsRaw.map((l) => {
    const first = flattenSource(l.firstSource);
    const last = flattenSource(l.lastSource);
    return {
      id: l.id,
      email: l.email || '',
      name: [l.firstName, l.lastName].filter(Boolean).join(' ').trim() || null,
      joined: l.creationDate || null,
      updated: l.lastUpdatedDate || null,
      stage: l.currentStage?.name || null,
      stageDate: l.currentStage?.date || null,
      consent: l.adOptimizationConsent || 'UNSPECIFIED',
      tags: l.tags || [],
      phones: l.phoneNumbers || [],
      firstSource: first,
      lastSource: last,
      lastSourceDate: last?.clickDate || null,
      hasAttribution: Boolean(first || last),
    };
  });

  const leads = (incremental ? mergeLeads(prevLeads, fetchedLeads, leadsFrom) : fetchedLeads)
    // Income is re-joined from the fresh sales pull for every lead, merged or not.
    .map((l) => ({ ...l, income: incomeByEmail.get((l.email || '').toLowerCase()) || 0 }));

  const leadName = (l) =>
    [l?.firstName, l?.lastName].filter(Boolean).join(' ').trim() || null;
  const srcName = (src) => src?.name || null;
  const srcAd = (src) => src?.sourceLinkAd?.name || null;

  const sales = salesRaw.map((s) => ({
    id: s.id,
    email: s.lead?.email || '',
    leadName: leadName(s.lead),
    date: s.creationDate || null,
    amount: s.usdPrice?.price ?? s.price?.price ?? 0,
    currency: s.usdPrice?.currency || s.price?.currency || 'USD',
    product: s.product?.name || null,
    recurring: Boolean(s.recurring),
    refunded: Boolean(s.refundDate),
    firstSource: srcName(s.firstSource),
    lastSource: srcName(s.lastSource),
  }));

  // Calls carry FULL attribution on the call object itself (source, category
  // and the specific ad) — richer than the lead row.
  const calls = callsRaw.map((c) => ({
    id: c.id,
    email: c.lead?.email || '',
    leadName: leadName(c.lead),
    date: c.creationDate || null,
    name: c.name || c.tag || null,
    state: c.state || (c.qualified ? 'QUALIFIED' : 'UNQUALIFIED'),
    qualified: Boolean(c.qualified),
    firstSource: srcName(c.firstSource),
    ad: srcAd(c.firstSource) || srcAd(c.lastSource),
    lastSource: srcName(c.lastSource),
  }));

  const subscriptions = subsRaw.map((x) => ({
    id: x.id || x.subscriptionId || null,
    email: x.lead?.email || x.email || '',
    leadName: leadName(x.lead),
    date: x.startDate || x.creationDate || null,
    name: x.name || x.planId || null,
    price: Number(x.usdPrice?.price ?? x.price?.price ?? x.price ?? 0) || 0,
    periodicity: x.periodicity || null,
    status: x.status || null,
    provider: x.provider?.integration?.name || x.provider || null,
  }));

  return {
    leads,
    sales,
    calls,
    subscriptions,
    stages: stagesRaw.map((s) => ({ name: s.name, amount: s.amount })),
    window: { from: leadsFrom, to: leadsTo },
    sync: { incremental, leadsFetched: fetchedLeads.length },
    totals: {
      leads: leads.length,
      attributed: leads.filter((l) => l.hasAttribution).length,
      customers: leads.filter((l) => l.stage === 'Customer').length,
      income: leads.reduce((sum, l) => sum + l.income, 0),
      calls: calls.length,
      qualifiedCalls: calls.filter((c) => c.qualified).length,
      subscriptions: subscriptions.length,
    },
  };
}

/* ---------------- Scale Advisor: marginal CAC curves ---------------- */


/* Scale Advisor / Tracking Health moved to public/features/<id>/server.js —
 * every feature's server step runs through api/_features.js runFeatureSteps(). */

/* ---------------- top level ---------------- */

export async function buildSnapshot({
  now = new Date(), onProgress = () => {}, prefs = null, previous = null, budgetMs = 52000,
} = {}) {
  const started = Date.now();
  const deadline = started + budgetMs;
  const settings = normalizeSettings(prefs?.settings);
  const model = settings.model;

  onProgress('account');
  const user = await callTool('hyros_get_user_info', {});
  const tz = user?.userProfile?.timezone || '+00:00';
  const acctSummary = (list) => (Array.isArray(list) ? list : []).map((a) => ({
    accountId: a.accountId || null, email: a.email || null, company: a.companyName || null,
    status: a.status || null,
  }));

  onProgress('ad accounts');
  const accountsBody = await callTool('hyros_get_ad_accounts', { request: { pageSize: 250 } });
  let accounts = (Array.isArray(accountsBody) ? accountsBody : accountsBody?.result || []);

  const only = (process.env.HYROS_AD_ACCOUNTS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (only.length) accounts = accounts.filter((a) => only.includes(String(a.id)));
  if (!accounts.length) throw new Error('No connected ad accounts returned by the MCP');

  const adAccountName = new Map(accounts.map((a) => [String(a.id), a.name]));

  onProgress('sources');
  const sourcesRaw = await callToolPaged('hyros_get_sources',
    { request: { includeOrganic: true, includeDisregarded: false } },
    { maxPages: 8, pageSize: 250 });

  const sourceById = new Map();
  for (const s of sourcesRaw) {
    const key = String(s.adSource?.adSourceId ?? '');
    if (!key) continue;
    sourceById.set(key, {
      name: s.name,
      tag: s.tag,
      category: s.category?.name || null,
      trafficSource: s.trafficSource?.name || null,
      adAccountId: s.adSource?.adAccountId ? String(s.adSource.adAccountId) : null,
      platform: s.adSource?.platform || null,
    });
  }

  const ranges = buildRanges(now, tz);
  const out = {};

  // One ad account failing (unsupported level, disconnected integration, …)
  // must not take the whole snapshot down: it is recorded in `warnings`,
  // skipped for the remaining ranges, and the other accounts still report.
  const warnings = [];
  const failed = new Set();
  const reported = new Set();
  const warn = (acct, level, error) => {
    warnings.push({ adAccountId: String(acct.id), name: acct.name || null, type: acct.type || null, level, error: String(error) });
    onProgress(`skip ${acct.name || acct.id}: ${error}`);
  };
  const reportable = accounts.filter((acct) => {
    if (LEVELS_BY_TYPE[acct.type]) return true;
    warn(acct, null, `no attribution report level for ad account type ${acct.type}`);
    return false;
  });
  const fetchLevelSafe = async (acct, level, range) => {
    const id = String(acct.id);
    const key = `${id}:${level}`;
    if (failed.has(key)) return [];
    try {
      const rows = await fetchLevel(level, id, range, settings);
      reported.add(id);
      return rows;
    } catch (err) {
      if (err?.name === 'McpNotConfigured' || err?.code === 'auth') throw err;
      failed.add(key);
      warn(acct, level, err?.message || err);
      return [];
    }
  };

  for (const [key, range] of Object.entries(ranges)) {
    onProgress(`range ${key}`);
    const adsetRows = [];
    const adRows = [];
    for (const acct of reportable) {
      const { adset, ad } = LEVELS_BY_TYPE[acct.type];
      // Sequential per account: keeps us well inside the MCP's per-IP limiter.
      adsetRows.push(...await fetchLevelSafe(acct, adset, range));
      if (ad) adRows.push(...await fetchLevelSafe(acct, ad, range));
    }
    const levels = buildLevels({ adsetRows, adRows, sourceById, adAccountName });
    out[key] = {
      ...range,
      levels,
      totals: aggregate(adsetRows),
    };
  }

  // Nothing reported at all: surface the first failure instead of an empty dashboard.
  if (!reported.size) throw new Error(warnings[0]?.error || 'No ad account could be reported');

  onProgress('crm');
  const today = ymdInTz(now, tz);
  const crm = await buildCrm({ leadsFrom: addDays(today, -29), leadsTo: today, previous });

  // Feature server steps (Scale Advisor, Tracking Health, anything a user
  // adds under public/features/) — best-effort inside the remaining budget.
  const core = { schema: 2, attributionModel: model, settings, adAccounts: accounts.map((a) => ({ id: String(a.id), name: a.name, type: a.type })), ranges: out, crm, warnings, account: { email: user?.userProfile?.email || null, timezone: tz } };
  const featureBlocks = await runFeatureSteps({ snapshot: core, previous, deadline, onProgress });

  return {
    schema: 2,
    generatedAt: new Date().toISOString(),
    origin: 'mcp',
    attributionModel: model,
    settings,
    account: {
      email: user?.userProfile?.email || null,
      timezone: tz,
      currency: user?.trueTrackingData?.OUTBOUND_CURRENCY || 'USD',
      attributionWindowDefault: Number(user?.trueTrackingData?.LEAD_ATTRIBUTION_TIMEFRAME) || null,
      // Agency relationships (MCP upgrade): who manages this account, and
      // which client accounts this one can operate on.
      managedBy: acctSummary(user?.allowedAccounts),
      clients: acctSummary(user?.accessibleAccounts),
    },
    adAccounts: accounts.map((a) => ({ id: String(a.id), name: a.name, type: a.type })),
    sourceCount: sourcesRaw.length,
    ranges: out,
    crm,
    warnings,
    ...featureBlocks,
    buildMs: Date.now() - started,
  };
}

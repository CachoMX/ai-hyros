/**
 * GET /api/drill — the click-through behind the report's numbers (HYROS "deep
 * mode"), metric-aware:
 *
 *   ?tags=@a,@b&metric=leads   -> the lead COHORT that clicked those sources
 *   ?tags=@a,@b&metric=sales   -> the SALES of that cohort
 *   ?tags=@a,@b&metric=calls   -> the booked CALLS of that cohort
 *   ?email=x@y.com             -> one lead's full journey + click history
 *
 * Sales/calls have no server-side tag filter, so those drills run the
 * two-step pipeline: get_leads({tags}) for the cohort ids, then
 * get_sales/get_calls({leadIds}) in batches of 50 (the filter's cap).
 *
 * Honesty note baked into the UI: the cohort is leads that TOUCHED the
 * source, which is not identical to the attribution-credited count in the
 * table cell (models reassign credit; e.g. a later organic click can take it).
 *
 * Dates: sales, calls and clicks come back in the legacy
 * `EEE MMM dd HH:mm:ss zzz yyyy` form (docs); every stored date is ISO.
 *
 * Always live against the selected account's key. Demo-mode drills are
 * generated in the browser (public/demo.js) and never reach this route.
 */
import { checkAccess, deny } from './_auth.js';
import { callTool, callToolPagedInfo, runWithKey } from './_mcp.js';
import { accountFromReq, resolveAccount } from './_accounts.js';
import { parseHyrosDate } from './_dates.js';

const iso = (v) => parseHyrosDate(v);

/** usdPrice (undocumented, live) first, else the documented price object. */
const priceOf = (s) => (s?.usdPrice?.price != null
  ? { amount: Number(s.usdPrice.price) || 0, currency: s.usdPrice.currency || 'USD' }
  : { amount: Number(s?.price?.price) || 0, currency: s?.price?.currency || null });

const flatSource = (s) => (s ? {
  name: s.name || null,
  tag: s.tag || null,
  organic: Boolean(s.organic),
  ad: s.sourceLinkAd?.name || null,
  clickDate: iso(s.clickDate),
} : null);

const compactLead = (l) => ({
  email: l.email || '',
  name: [l.firstName, l.lastName].filter(Boolean).join(' ').trim() || null,
  joined: iso(l.creationDate),
  stage: l.currentStage?.name || null,
  firstSource: flatSource(l.firstSource),
  lastSource: flatSource(l.lastSource),
  tags: (l.tags || []).slice(0, 12),
});

async function cohortLeads(tags) {
  const body = await callTool('hyros_get_leads', { request: { tags, pageSize: 250 } });
  const raw = Array.isArray(body) ? body : body?.result || [];
  return {
    raw,
    leads: raw.map(compactLead),
    ids: raw.map((l) => l.id).filter(Boolean),
    truncated: Boolean(body?.nextPageId),
  };
}

const chunk = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

/** Sales/calls per cohort batch: 4 pages of 250 each before the drawer says "newest shown". */
const BATCH_MAX_PAGES = 4;

async function cohortRecords(metric, tags) {
  const cohort = await cohortLeads(tags);
  const tool = metric === 'sales' ? 'hyros_get_sales' : 'hyros_get_calls';

  const batches = await Promise.all(chunk(cohort.ids, 50).map((leadIds) =>
    callToolPagedInfo(tool, { request: { leadIds } }, { maxPages: BATCH_MAX_PAGES, pageSize: 250 })));
  const raw = batches.flatMap((b) => b.rows);
  const truncated = cohort.truncated || batches.some((b) => b.truncated);

  const records = metric === 'sales'
    ? raw.map((s) => ({
        date: iso(s.creationDate),
        email: s.lead?.email || '',
        name: s.product?.name || null,
        ...priceOf(s),
        state: s.refundDate ? 'REFUNDED' : (s.recurring ? 'RECURRING' : null),
        source: s.lastSource?.name || s.firstSource?.name || null,
      }))
    : raw.map((c) => ({
        date: iso(c.creationDate),
        email: c.lead?.email || '',
        name: c.name || c.tag || null,
        amount: null,
        state: c.state || (c.qualified ? 'QUALIFIED' : 'UNQUALIFIED'),
        source: c.firstSource?.name || c.lastSource?.name || null,
      }));

  return { records, cohortSize: cohort.ids.length, truncated };
}

/** Click history window: bounded (docs recommend a fromDate) but wide enough for a long journey. */
const CLICKS_LOOKBACK_DAYS = 365;

async function liveJourney(email) {
  const fromDate = new Date(Date.now() - CLICKS_LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 19);
  // The clicks call is best-effort: a failure must not blank the journey.
  const [journeyRes, clicksRes] = await Promise.allSettled([
    // Every MCP tool takes its arguments inside `request` (the live server
    // answers "Missing required property: request" otherwise).
    callTool('hyros_get_lead_journey', { request: { emails: [email], includeEvents: true } }),
    // Docs: `email` is deprecated in favour of `emails`; `fromDate` bounds the search.
    callTool('hyros_get_lead_clicks', { request: { emails: [email], fromDate, pageSize: 100 } }),
  ]);
  if (journeyRes.status === 'rejected') throw journeyRes.reason;
  const journeys = journeyRes.value;
  const clicksBody = clicksRes.status === 'fulfilled' ? clicksRes.value : null;
  const clicksError = clicksRes.status === 'rejected' ? String(clicksRes.reason?.message || clicksRes.reason) : null;
  const list = Array.isArray(journeys) ? journeys : (journeys?.result || journeys?.journeys || []);
  const j = Array.isArray(list) ? list[0] : null;
  if (!j) return null;
  return {
    ...(clicksError ? { clicksError } : {}),
    lead: compactLead(j.lead || {}),
    sales: (j.sales || []).map((s) => ({
      date: iso(s.creationDate),
      ...priceOf(s),
      product: s.product?.name || null,
      firstSource: s.firstSource?.name || null,
      lastSource: s.lastSource?.name || null,
      ad: s.firstSource?.sourceLinkAd?.name || null,
    })),
    calls: (j.calls || []).map((c) => ({
      date: iso(c.creationDate),
      name: c.tag || null,
      qualified: Boolean(c.qualified),
    })),
    journey: (j.journey || []).map((e) => ({
      type: e.type, date: iso(e.date), name: e.name || e.tag || '',
      keyword: e.keyword || '', extra: e.extra || null,
      subNames: e.subNames || null,
    })),
    clicks: (clicksBody?.result || []).map((c) => ({
      date: iso(c.date),
      page: c.page || c.trackedUrl || null,
      previousUrl: c.previousUrl || null,
      source: c.sourceLinkName || null,
      platform: c.adspendType === 'NONE' ? null : c.adspendType,
    })),
  };
}

export default async function handler(req, res) {
  const access = await checkAccess(req);
  if (!access.ok) return deny(res, access);
  res.setHeader('cache-control', 'private, max-age=120');

  const url = new URL(req.url, `http://${req.headers.host || 'local'}`);
  const email = url.searchParams.get('email');
  const metric = ['leads', 'sales', 'calls'].includes(url.searchParams.get('metric'))
    ? url.searchParams.get('metric') : 'leads';
  const tags = (url.searchParams.get('tags') || '')
    .split(',').map((t) => t.trim()).filter((t) => t.startsWith('@')).slice(0, 40);

  const accountId = await accountFromReq(req);
  if (!accountId) return res.status(503).json({ ok: false, error: 'not_configured', message: 'No HYROS account is connected yet — add one from the account menu.' });
  let resolved = null;
  try { resolved = await resolveAccount(accountId); }
  catch (err) { return res.status(err.status || 500).json({ ok: false, error: err.code || 'error', message: err.message }); }
  if (!resolved) return res.status(404).json({ ok: false, error: 'not_found', message: `Unknown account "${accountId}".` });
  const live = (fn) => runWithKey(resolved.apiKey, fn, { accessibleAccountId: resolved.accessibleAccountId, clientMode: resolved.clientMode });

  try {
    if (email) {
      const journey = await live(() => liveJourney(email));
      return res.status(200).json(journey
        ? { ok: true, origin: 'mcp', journey }
        : { ok: false, error: 'not_found', message: `No lead found for ${email}.` });
    }
    if (tags.length) {
      if (metric === 'leads') {
        const { leads, truncated } = await live(() => cohortLeads(tags));
        return res.status(200).json({ ok: true, origin: 'mcp', kind: 'leads', leads, truncated });
      }
      const out = await live(() => cohortRecords(metric, tags));
      return res.status(200).json({ ok: true, origin: 'mcp', kind: metric, ...out });
    }
    return res.status(400).json({ ok: false, error: 'bad_request', message: 'Pass ?tags= or ?email=.' });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.name || 'error', message: err.message });
  }
}

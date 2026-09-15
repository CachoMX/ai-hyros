# HYROS MCP — exploration findings

What the MCP can and cannot do when you try to rebuild HYROS's own reporting and
CRM screens as an external app. Everything here was verified against the live
`camel@hyros.com` account, and cross-read against the HYROS source
(`markethero/services`) where behaviour needed explaining.

---

## 1. "Campaign" is not a Meta campaign — this is the headline finding

`hyros_get_attribution_report` with `level: FACEBOOK_CAMPAIGN` and
`isAdAccountId: true` returns `[]`. That looks like a missing feature. It isn't.

`modules/hyros-ui/.../SourceNamingUtils.ts` defines the real level model, and for
Meta it renames every rung:

| Internal level    | Meta display name |
|-------------------|-------------------|
| `AD_ACCOUNT`      | Account           |
| `SOURCE_CATEGORY` | **Campaign**      |
| `SOURCE_LINK`     | **Ad Set**        |
| `SOURCE_LINK_AD`  | **Ad**            |

`ReportSection.tsx:243` confirms it: `{ name: "Campaign", value: SBDataType.SOURCE_CATEGORY }`.

So the **Campaign tab in the real HYROS UI is a source *category***, not a Meta
campaign object. The MCP exposes categories on `hyros_get_sources`
(`category.name`), so the level is fully reconstructible: pull ad-set rows, join
to sources, group by category. That is what `buildLevels()` does, and it
reproduces the real tab.

**Impact: not a blocker.** But you cannot discover it from the MCP alone — the
tool descriptions imply `FACEBOOK_CAMPAIGN` is the campaign level, and it
silently returns an empty array instead of an error.

## 2. Lead attribution IS exposed — with a caveat that looks like a bug

`firstSource` / `lastSource` on `hyros_get_leads` come back fully populated
(name, tag, organic flag, traffic source, category, `clickDate`) — **but only for
leads that arrived via a tracked click.**

Leads created by the Stripe and HubSpot integrations have no click history, so
their source is genuinely `null`. A sample drawn from recent sales looked like
total attribution failure; a sample drawn from recent *leads* showed 9 of 26
attributed. Sample choice completely changes the conclusion.

**Impact: none, once understood.** The dashboard surfaces it explicitly with an
"Attributed only / Unattributed only" filter so the distinction is never mistaken
for missing data.

## 3. Lead `Income` requires a join the MCP does not do for you

The lead object carries no revenue field, so the CRM's Income column has to be
built by pulling `hyros_get_sales` and summing by email. Fine at this account's
size; it is an N+M fetch that grows with lead volume, and there is no server-side
"leads with revenue" query.

## 4. Level totals do not reconcile

Same account, same window (2026-08-14 → 2026-08-20), same attribution model:

| Source                                        | Total cost |
|-----------------------------------------------|-----------:|
| Ad-set level (`FACEBOOK_ADSET`)                | $4,266.30 |
| Campaign rollup (from those ad sets)           | $4,266.30 |
| `hyros_get_ad_account_report`, DAY grouping    | $4,196.62 |
| Ad level (`FACEBOOK_AD`)                       | $2,852.99 |

Ad-set vs account report differs by **$69.68**; ad level accounts for only ~67%
of ad-set spend. Neither is wrong exactly — different visibility rules for
deleted sources, and spend that exists at ad-set level without a corresponding ad
row — but **you cannot treat any level as a cross-check on another**, and a
naive "drill down should sum to the parent" assumption will produce numbers that
look broken.

## 5. Pull-only. No push, no webhooks, no subscriptions

There is no event stream. "Updates itself" can only mean polling. This app
therefore snapshots on a schedule rather than pretending to be live.

## 6. No server-side sort, and almost no server-side filter

The report tools take no sort parameter. Filtering is limited to `status` (only
at `SOURCE_LINK` grouping) and `leadStage`. Every sort and filter in the real UI
has to be reimplemented client-side over a full fetch. Fine at 17 sources;
it would not survive agency scale.

## 7. One query per date range

`isAdAccountId: true` forces `timeGroupingOption: SOURCE_LINK`, so there is no
per-source-per-day breakdown to slice locally. Each of Today / Yesterday / 7d /
30d is its own query per level per ad account — 8 report calls per refresh for a
single ad account, before CRM. Adding ranges multiplies the refresh cost
linearly.

## 8. Response payloads are ~90% null

Every report row returns ~120 fields regardless of what you pass in `fields`. A
3-row response was ~4 KB. The snapshot builder keeps 11 fields and re-derives the
rest, which is roughly a 20× reduction.

## 9. The MCP is serverless-friendly — the best surprise

From `modules/hyros-mcp`:

- `spring.ai.mcp.server.protocol=STATELESS` — stateless streamable HTTP, so every
  call is a self-contained JSON-RPC POST with no session to hold open.
- `MCP_ENDPOINT_PATH = "/mcp"`.
- Auth accepts an `API-Key` header — "the same credential the public REST API
  takes" (`McpAuthenticationType.java`) — alongside OAuth.

That combination is what makes a Vercel function a legitimate MCP client. An
SSE-only, OAuth-only server would have forced a very different architecture.

## 10. The write side is the strongest part of the surface

`create_lead`, `create_click`, `create_order`, `create_call`, `create_cart`,
`create_custom_conversion`, plus `get_tracking_script` and
`assert_script_presence_on_domain`. An external app can install HYROS tracking,
push conversions in, and read attribution back out — the full loop. Writes are
async (~10s to visibility) and dedup is your responsibility via `externalId` /
`orderId`.

---

## Scorecard

| Feature | Fidelity | Limiting factor |
|---|---|---|
| Performance report | **~90%** | Campaign needs a client-side join; no server-side sort/filter |
| CRM / leads | **~85%** | Income needs a sales join; no server-side "leads with revenue" |
| Tracking in/out | **~95%** | Async writes; caller-managed idempotency |
| Live updating | **~40%** | Poll-only; no push of any kind |

## A note on this account's data

$545,266 of $560,292 total revenue sits under **"No Source Data"**, and Meta
shows $4,129.58 cost against $0.00 attributed revenue. The revenue and ROAS
columns are wired correctly and will read zero. Validate against **Cost, Clicks,
Impressions, CTR, CPM, Leads, CPL and Reported Result** — the metrics that
actually carry data here — or you will spend a day debugging a pipeline that is
working fine.

---

## API recommendations — three changes that unlock the rest

Scoping two further features against the MCP (a Plausible-style analytics tab
and a native split-testing tab) reduced every blocker to four root causes:
organic/custom sources are unreportable, there is no aggregate click query, the
URL is not a reporting dimension, and attribution is credit-assignment only.

### The key fact first: the data already exists — the query surface doesn't

Evidence from this account that HYROS already stores click data at the needed
grain:

- `hyros_get_lead_clicks` returns URL-stamped clicks per lead.
- `hyros_create_click` accepts a `sessionId`, and the account config lists
  `SESSION_ID` in `ORIGIN_LEAD_ASSIGNATION_OPTIONS` — anonymous sessions are
  tracked and joined to the lead on identification, not discarded.
- The HYROS leads UI ships "Tracked URL" / "Previous URL" columns.

So the three changes below are query/index work over stored data, not tracking
changes. Session shape (bounce, duration, views-per-visit, exit pages) is the
one thing genuinely not collected, and belongs in a separate, bigger
conversation.

### 1. Platform-agnostic report level (small)

`hyros_get_attribution_report` only addresses ad-platform levels
(`FACEBOOK_ADSET`, `GOOGLE_V2_ADGROUP`, ...). Any source with
`adSource: null` — every organic and custom source — is unreportable: no
clicks, no visits, no leads, nothing. `hyros_get_roas_report` already uses a
generic vocabulary (`AD | SOURCE_LINK | CAMPAIGN | ACCOUNT`); extending that to
sources without an `adSource` (accept plain source tags in `ids`) is the
smallest change with the largest unlock.

Unlocks: channel/source traffic volume in analytics, split-test arms as
first-class reportable objects, partner portals with traffic counts.

### 2. Aggregate clicks endpoint (medium)

Clicks are queryable only per lead. Add a date-range query with
`groupBy: url | source | day`. This single endpoint supplies top pages, entry
pages, traffic timelines, and — critically — the denominator that every
conversion-rate feature needs.

### 3. `attributionMode: CREDIT | TOUCHED` (small)

Today the API can only answer "which source gets credit." A split test or any
cohort analysis needs "conversions among leads whose journey touched source X."
The journey data exists (`hyros_get_lead_journey` renders it per lead); this
exposes it in aggregate.

### Quick wins regardless of the above

- Honor the `fields` projection (~20x smaller payloads; today ~110 of ~120
  fields come back null regardless of the request).
- Return an explicit error for `level: FACEBOOK_CAMPAIGN` instead of `[]`
  (Meta campaigns are `SOURCE_CATEGORY` in the HYROS model; the silent empty
  array reads as missing data).
- Guard or loudly document `sourceConfiguration: PRIORITIZE_PAID` on
  organic-scoped queries — it discards organic clicks before attributing, which
  silently zeroes any organic-source feature.
- An `income`/LTV field on the lead object (removes the N-way sales join).
- A count/groupBy mode on `hyros_get_leads` (today: paginate everything to
  count anything).
- Webhooks on lead/sale/call events (today: pull-only, so "self-updating"
  can only ever mean polling).

### What stays missing even after all three

Bounce rate, visit duration, views-per-visit, exit pages, and true anonymous
visitor counts. Those require the tracking script to emit session structure —
a data-model and product decision, not an API tweak. Pitch separately.

### Bottom line

The MCP is excellent at telling you what traffic was worth and structurally
unable to tell you how much of it there was. Changes 1–3 close exactly that
gap, and they are index/query work over data HYROS already collects.

## Sept 2026 MCP upgrade — what shipped, what the app now does with it

Audited against the live tool schemas on 2026-09-14 (connector bound to
alex@beckermailing.com; the schemas are the authority since that account's ad
accounts are dormant).

Shipped (and wired into the dashboard):

| MCP change | App change |
|---|---|
| Ad-level rows carry `id` + `parentId` + `parentName` | Ads link to ad sets by id (`adsUnder`), so duplicate ad-set names no longer over-match; ad-level lead drill enabled (inherits the parent ad set's tag — the drawer says so) |
| `updatedFromDate` / `updatedToDate` on `hyros_get_leads`, `lastUpdatedDate` on leads | Incremental lead sync: a refresh with a previous snapshot pulls only changed leads and merges (`mergeLeads`). Sales/calls/subscriptions still full pulls |
| `windowAttributionDaysRange` (0–365, LAST_CLICK) | Report settings → attribution window, built into the next refresh |
| `leadStage` filter on the attribution report | Report settings → "rank by funnel stage"; ads ranked by booked calls / approvals etc. |
| `newestFirst` paging | Used on every level pull — active sources first on big accounts |
| `hyros_get_marginal_cac_curve` | **Scale Advisor** tab: avg + marginal CAC vs daily spend, ceiling and saturation point, for every ad account + the top 6 ad sets by 30-day spend |
| `hyros_assert_script_presence_on_domain`, `hyros_check_tracking_parameters_for_integrations`, `hyros_get_domains` | **Tracking Health** tab: script presence per verified domain, Google ads missing tracking params |
| `allowedAccounts` / `accessibleAccounts` on user info | Agency relationships shown in Tracking Health → Account & access |
| 5 new metric fields (LTV 60d / 6mo forecasts, subscription 30d / 60d / 6mo forecasts) | Catalog is 103 metrics; all requestable as columns |
| Async writes with `hyros_get_request_status` (PROCESSED / FAILED + errorMessage) | Not used by the read-only dashboard; noted for the agency-feedback doc — the write path now fails loudly |

Still open (the next upgrade round): server-side sort / top-N; group-by counts
on list endpoints beyond `hyros_get_tags_count`; `updatedSince` on sales,
calls and subscriptions; the bulk conversion-paths endpoint (custom
attribution's main requirement); the traffic / pageview aggregate (the
Plausible clone); and whether the `fields` projection now trims the payload
(unverifiable without report rows on the bound account).

`scripts/mock-mcp.mjs` + `scripts/pipeline-test.mjs` (in `npm run check`)
exercise the whole pipeline against a mock of the new surface: settings on
the wire, parentId linkage, incremental merge, curves and health.

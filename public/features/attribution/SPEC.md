# Attribution Lab

**id** `attribution` | **mode** both | **version** 1.0.0

## Purpose

Compare deterministic attribution models on exactly the same fetched SALE or
CALL cohort, inspect individual touch credit, and export the comparison.
The current core report is a separately labeled reference with its own cohort
and settings. Scientific is never calculated locally or relabeled as a custom
model. Credit allocation is descriptive, not a causal estimate.

## Data

The only live tool is the read-only `hyros_get_conversion_paths`:

```js
callTool('hyros_get_conversion_paths', {
  request: {
    conversionType: 'SALE', // then CALL; alternate subsequent pages
    fromDate: snapshot.ranges['30d'].start,
    toDate: snapshot.ranges['30d'].end,
    windowAttributionDaysRange: 0,
    pageSize: 100,
    // pageId: nextPageId, only for the next page of the same type
  },
}, { timeoutMs: Math.min(15000, timeLeft - 250) });
```

Each type gets at most two pages (four calls total). No retries, no individual
lead queries, no write tools. Check both `timeLeft()` and `deadline` before
every call. Stop the endpoint on rate limiting, auth, configuration or
permission failures. A spent budget makes zero calls, reusing previous data
with explicit stale markers when present. The next refresh starts a new cohort;
previous and current windows are never silently combined.

The documented response is `{ result: ConversionPath[], nextPageId? }`.
`creationDate` and `clickDate` retain their timestamp precision and offset to
filter post-conversion touches correctly. Conversion IDs deduplicate overlapping
pages within a type. Blank identifiers are omitted with a coverage warning.
Native empty paths stay empty; missing flags and prices stay null.

Only allowlisted fields enter the snapshot. Emails and other lead contact
details are discarded; incidental email addresses in labels/errors are redacted.
Labels are bounded. Each type gets 88,000 UTF-8 bytes for conversions; whole
paths are retained or their entire conversion is omitted. Error messages and
page counts are bounded. The complete serialized block stays below 200 KB.

Amounts use native `price.price` only when `price.currency` matches
`snapshot.account.currency`. For a USD account, a documented USD-converted
`usdPrice` can supply that same currency when native price differs. No local
exchange conversion and no fallback currency. Unknown/mismatched prices become
null, even when the conversion still receives count credit. This is native
sale price before separate refund/discount/cost adjustments, not profit or
net revenue. CALL prices are retained when known but never enter SALE revenue.

Contract checked against the official [REST conversion paths documentation](https://api-docs.hyros.com/ai-context/rest-api.txt)
and [MCP tool catalog](https://api-docs.hyros.com/ai-context/mcp.txt), September 2026.

## Block Shape

```json
{
  "checkedAt": "2026-09-23T12:00:00Z",
  "window": { "start": "2026-08-25", "end": "2026-09-23" },
  "conversions": [{
    "id": "sale-1", "leadId": "lead-1", "kind": "SALE",
    "date": "2026-09-20T12:00:00-05:00",
    "amount": 100, "currency": "USD", "firstSale": true,
    "path": [{
      "id": "source-1", "name": "Prospecting",
      "date": "2026-09-18T10:00:00-05:00", "platform": "FACEBOOK",
      "organic": false, "disregarded": false,
      "adId": "ad-1", "adName": "Product video"
    }]
  }],
  "coverage": { "sampled": 1, "withPaths": 1, "complete": false, "truncated": true },
  "errors": []
}
```

`kind` is `SALE` or `CALL`. `amount`, `firstSale`, `leadId`, `date`,
`currency`, and unavailable touch fields can be null. Touch `id` is the native
source-link ID, not the ad ID or unique click ID. `firstSale` on CALL means
first call, not first purchase. `sampled` counts retained unique conversions
of both types; `withPaths` counts their nonempty native paths before local
filters. `complete` means both types finished pagination without omissions;
it does not mean every conversion has a path. `truncated` means the cohort is
incomplete, including failed, unattempted, capped or malformed pages. The
endpoint order is not a random sample; do not extrapolate sampled values.

## Shared Computation

`public/shared/attribution.js` exports:

```js
computeAttribution(conversions, {
  model: 'first', // first | last | linear | position | decay
  halfLifeDays: 7,
  windowDays: 0,
  includeOrganic: true,
  positionWeights: { first: 40, middle: 20, last: 40 }, // optional
});
// { rows: [{ sourceId, name, revenue, conversions, touches }],
//   unattributedRevenue, totalRevenue, attributedRevenue }
```

- `computeAttribution` consumes only SALE. `computeCallAttribution` has the
  same shape but consumes only CALL and all revenue fields remain zero.
- `getTouchCredits(conversion, options)` exposes each original touch, credit
  `weight`, and exclusion `reason`; `uniqueConversions` and `finiteAmount`
  are available to consuming features.
- No mutation of input. Duplicate conversion IDs count once, first occurrence
  wins. Different purchases by the same lead remain different conversions.
  Consumers must normalize IDs; anonymous input rows cannot be deduplicated.
- Filter disregarded touches, timestamps after conversion, missing dates,
  and touches older than the inclusive local window boundary. With organic
  disabled, only explicitly nonorganic touches qualify. Unknown disregarded
  flags remain unknown and are not inferred as exclusions.
- Eligible touches are sorted chronologically, preserving native order on
  timestamp ties. A legacy timestamp with no offset is interpreted as UTC
  deterministically; current native timestamps include their offset.
- First/last assign all credit to one eligible touch. Linear splits equally
  by occurrence, so repeated source visits combine into one source row.
  Position normalizes endpoint and pooled middle weights; one touch gets 100%,
  two use endpoint weights, and all-zero applicable weights fall back to an
  equal split. Time decay uses `2 ** (-ageDays / halfLifeDays)`, normalized
  relative to the latest eligible touch to avoid numerical underflow.
- Source identity uses source-link ID, with platform/name fallback only when
  no ID is available. A missing source identity cannot receive credit.
- `touches` counts all eligible occurrences including zero-credit assists.
  `conversions` is fractional model credit, not a unique-lead count.
- Missing amounts receive conversion credit but add no invented revenue.
  Empty or completely excluded paths leave all known SALE revenue unattributed.
  No rounding occurs before aggregation. Conservation holds within normal
  floating-point tolerance, including negative native amounts.

## View States

Fresh, previous/stale, skipped, error, null and empty objects render safely,
including the conformance check's fake DOM. Optional DOM methods are guarded.
The selected core range narrows the fetched window when fully contained in
it; otherwise the fetched window remains explicitly labeled. Unknown dates
cannot enter a narrower range. Coverage always identifies the parent cohort.

Controls compare two models, expose position weights/decay half-life, choose
the touch window and organic inclusion, and switch SALE/CALL. Conversion
evidence is paginated and expandable with original touch dates, exclusions,
and both weights. CSV contains raw amounts, fractional credit, an unattributed
row, model parameters, currency, window and cohort coverage. Cells are quoted
and formula-like labels are neutralized. CSV downloads remain local.

## Demo

The deterministic seed is the sum of the feature ID's character codes.
Inputs are the existing demo snapshot's 30-day ads, average order values,
currency and timestamps. It emits at most eight sample sales per selected ad
and one call. Paths, organic assists, dates and repeat flags are illustrative;
empty paths are intentional. This cohort neither reconciles to the entire
core report nor reproduces its synthetic model redistribution. The view and
block disclose this explicitly. No demo rows enter live build results.

## Porting Notes

Copy this feature folder and `public/shared/attribution.js`; the shared module
has no dependencies. Demo also imports the host's deterministic `rng` helper.
Provide the standard `render(ctx)` formatters and tokens, and register
`attribution` ahead of features that consume `snapshot.attribution`. The
runner must include account currency and earlier feature blocks in snapshot.
The independent check is `node scripts/attribution-test.mjs`.

## Open Limitations

As observed in `CONTEST-RESEARCH.md` and the tracked-click limitation in
`FINDINGS.md`, a real conversion can have no path. This alone is not proof of
broken tracking. Recorded paths can already be restricted by native tracking
timeframes. Native Scientific and core refunds/settings cannot be reproduced
by this cohort model, so the reference totals must remain separate. Real
connector integration is verified by the main runner; the focused suite uses
documented response fixtures and performs no external data mutations.

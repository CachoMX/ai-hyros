# Ad LTV

**id** `adltv` | **mode** both | **version** 2.0.0

## Purpose

Inspect observed revenue by lead and opening source, repeat-purchase flags,
mature first-purchase cohorts, native report LTV, and evidence-backed
hidden-winner candidates. Keep these populations and measures distinct.

## Data

No tool calls or fetches. Reads `snapshot.attribution` (the normalized
conversion-path contract), `snapshot.crm`, and `snapshot.ranges['30d']`.
Attribution must run first and the runner must expose earlier feature blocks.

Native LTV comes only from numeric `ltv30Days`, `ltv60Days`, `ltv90Days` in
the core ad report, using account currency. Forecasts are not treated as LTV.
Native values are not summed, blended with observed revenue, or relabeled
as an independently verified mature cohort.

## Block Shape

Live blocks use `mode: 'observed'`:

```js
{
  mode: 'observed', checkedAt, window: { start, end }, pathStatus, pathReason,
  summary: { sales, first, repeat, unclassified, unlinked },
  totals: [{ currency, sales, first, repeat, unknown, revenue, unknownAmounts }],
  rows: [{ key, name, adId, platform, currency, leads, sales, first, repeat,
    unknown, revenue, unknownAmounts }],
  leads: [{ leadId, source, sourceKey, currency, sales, first, repeat,
    unknown, revenue, unknownAmounts }],
  candidates: [{ key, name, adId, platform, conversions, late, multiTouch,
    examples: ['sale-id'], native: null | { currency, ltv30, ltv60, ltv90 } }],
  native: [{ id, name, currency, ltv30, ltv60, ltv90, stale, window }],
  cohorts: { basis: 'observed-first-purchase-cohorts', window, checkedAt,
    complete, reason, rows: [{ key, name, currency, customers,
      horizons: [{ days: 0 | 30 | 60 | 90, mature, immature, unknown,
        revenue, value, status: 'mature' | 'immature' | 'unknown' }] }] },
  coverage: { sampled, complete, truncated }, truncated, errors: []
}
```

The existing demo/legacy view is preserved for blocks without the live
discriminator: `{ window, rows: [{ rank, name, adset, campaign, customers,
revenue60, ltv0, ltv30, ltv60, mult, assists }], callLeaders }`. Its two-month
LTV, assist percentages, and closed-call counts are seeded illustrations.
Old snapshots still render; live builders never substitute synthetic data.

## Verified History Contract

Path-date sales alone never satisfy this contract, even when all path pages
were fetched. Cohort computation needs separately verified lead sales:

```js
snapshot.attribution.history = {
  basis: 'lead-sales', complete: true, truncated: false, stale: false,
  checkedAt: 'ISO timestamp', window: { start: 'ISO/date', end: 'ISO/date' },
  sales: [{ id, leadId, date, amount, currency, firstSale,
    source: { id, name, adId, adName, platform } }]
};
```

This optional extension is not fabricated by the path builder. If absent,
the feature can use core CRM sales only when pagination explicitly finished
(`crm.sync.truncated.sales === false`), the CRM window is known, and rows
carry exact boolean firstSale flags. CRM sales join to lead IDs by leadId or
email; only IDs enter the output block. Existing core snapshots that omit
firstSale therefore correctly display unknown cohorts.

## Rules Honoured

- Only SALE contributes purchase counts/revenue; CALL firstSale is never
  used. Duplicate sale IDs count once. Repeats require firstSale === false;
  recurring is ignored, and absent flags stay unknown.
- Each observed sale belongs to its earliest eligible path touch, ordered
  by timestamp, excluding disregarded, undated and post-conversion touches.
  Empty paths go to `No eligible touch`. Source/ad identity and currency
  partition rows. A lead can appear under several observed opening sources.
- Observed revenue is before independent refunds/cost adjustments. Null
  amounts remain unknown, partial totals disclose missing amounts, and
  currencies are never added together. Counts do not require known prices.
- A cohort anchor requires exactly one confirmed first purchase per lead.
  Time 0 is that purchase's amount, not lifetime revenue or first observed
  sale. Day N is cumulative lead sales through the inclusive N-day boundary.
- A mature value requires known currency/amounts, consistent lead currency,
  complete nonstale history beginning at/before the first purchase, and
  coverage through the entire horizon. Unknown dates, contradictory earlier
  sales, truncation and missing coverage make the value unknown. Too-young
  customers are immature. Date-only coverage ends include that full day,
  capped at the current observation time.
- Horizon averages use only eligible mature leads, disclose mature,
  immature and unknown counts, and may have different denominators. These
  are observed first-purchase cohorts, not all acquired customers of an ad.
- Candidates are opening/pre-close sources with a >=7-day delay or more
  than one eligible touch. They carry sale IDs and evidence counts. A single
  exact ad-ID match can add nonstale native LTV evidence. No name matching,
  causal-lift claim, winner guarantee, or automatic budget recommendation.
- Up to 2,000 sales, 120 source and lead rows, 100 native/cohort rows, and
  40 candidates. Omissions are explicit. Entire leads' histories remain
  intact during computation; display caps do not change denominators.

## View States

Fresh, stale, bare skipped, error, null and empty objects are tolerated.
Stale path data carries its own checkedAt and says previous. Missing paths
can still show native LTV. Native report freshness is separately labeled.
Spent budgets make no calls and preserve previous data with stale markers.

Controls filter observed/native/cohort tables by currency, sort sources,
search lead IDs/sources, and select candidates. Global sample KPIs and
candidate evidence remain across all currencies. Optional DOM APIs are
guarded for conformance stubs. All data strings are escaped.

## Porting Notes

Copy this folder; analytics/server code has no imports outside it. The
preserved demo also imports the host's seeded demo helpers. Provide feature
context formatters and design tokens. Focused verification:
`node scripts/journey-analytics-test.mjs`.

## Open Limitations

The normal 30-day snapshot often cannot certify 60/90-day cohorts. That
absence is unknown, not zero or a modeled estimate. Native HYROS LTV uses
its own underlying populations and windows. Refund history, margin and
full acquisition cohorts are outside this feature's observed revenue data.

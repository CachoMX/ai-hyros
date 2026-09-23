# Funnel & Journey

**id** `funnel` | **mode** both | **version** 2.0.0

## Purpose

Inspect observed conversion paths, opening/closing/interior source roles,
and individual conversion evidence. Show core CRM activity as independent
period counts, never as a strict lead-to-call-to-sale conversion funnel.

## Data

`server.js` reads `snapshot.attribution` produced earlier in the refresh and
the core `snapshot.crm` lists. It makes no tool calls or fetches. Register
`attribution` before `funnel`; the runner must expose earlier built blocks.

The input is `{ checkedAt, window: { start, end }, conversions, coverage,
errors }`. Each conversion has `{ id, leadId, kind: 'SALE' | 'CALL', date,
amount, currency, firstSale, path }`. Each touch has `{ id, name, date,
platform, organic, disregarded, adId, adName }`. Nulls remain unknown.

## Block Shape

The live discriminator is `mode: 'paths'`:

```js
{
  mode: 'paths', checkedAt, window: { start, end },
  pathStatus: 'ready' | 'error' | 'skipped' | 'unavailable', pathReason,
  summary: { conversions, sales, calls, withPaths, noTouch, multiTouch,
    late, avgTouches, avgDays },
  sources: [{ key, name, platform, organic, opening, closing, assists,
    touched, sales, calls }],
  flows: [{ steps: ['source', 'source', 'Sale'], kind, count }],
  journeys: [{ id, leadId, kind, date, amount, currency, firstSale,
    days, eligibleTouches, path: [{ id, name, date, platform, organic,
      disregarded, exclusion, adId, adName }] }],
  coverage: { sampled, complete, truncated, analyzed, evidence },
  crm: { window: { start, end }, checkedAt, leads, calls, sales,
    qualifiedCalls, stale, partial },
  errors: []
}
```

The original 1.1 demo block remains supported: `stages`, `value`, `entering`,
`converting`, `paths`, `avgTouches`, `avgDaysToConvert`. `demo.js` continues
deriving stages and refund-adjusted unit values from report totals; its
journeys and source shares are illustrative. A block with `stages` and no
live discriminator follows the existing demo view. This compatibility branch
also supports snapshots generated before the upgrade. Demo data is never
used as a fallback by the live builder.

## Rules Honoured

- Deduplicate conversion IDs within SALE/CALL; count distinct purchases by
  the same lead separately. Never equate CALL firstSale with first purchase.
- Eligible touches have dates at/before the conversion, are not explicitly
  disregarded, and are sorted chronologically. Organic touches are included.
  The explorer preserves native chain order and all excluded touches.
- Opening/closing are first/last eligible touches. An assist is an interior
  touch. Count each source at most once per role per conversion; a source
  may fill several roles. Source identity is the native source ID, falling
  back to platform/name/organic only when absent.
- Empty and wholly excluded paths retain the conversion and appear as
  `No eligible touch -> Sale/Call`, with no invented source credit.
- Delay uses the first eligible touch. Missing dates stay unknown. The
  average touch count uses conversions with eligible paths; average delay
  uses only conversions with known nonnegative delays.
- Flow percentages use observed conversions, not CRM leads or account totals.
  Sample completeness means completed path pagination, not an acquisition
  cohort or a random sample. No extrapolation and no causal claims.
- CRM leads, calls, qualified calls and sales are independent list counts.
  Missing lists are unknown; empty lists are zero. CRM time/partial/stale
  flags are separate from attribution time/coverage.
- Monetary evidence retains its currency. Unknown amount/currency is not
  converted to zero or silently presented in the account currency.
- Up to 2,000 conversions analyzed, 80 sources, 20 compact flows, and 60
  whole evidence chains. A conservative 90 KB evidence budget omits entire
  chains rather than clipping the middle. Omissions are disclosed.

## View States

Fresh, stale, skipped, error, null and empty objects render safely, including
fake DOM roots without querySelector. A stale dependency marks the block
previous and displays its own checkedAt. A spent budget reuses previous data
with stale markers, stripping old error markers; a fresh build removes them.
Missing path data can still show independent CRM activity.

Controls sort source roles, filter evidence by SALE/CALL, and select a full
chain. All labels/IDs/errors are escaped. Tables scroll within their section
on narrow screens, and chains wrap. No core files or new routes are required.

## Porting Notes

Copy this folder. Live code uses standard JavaScript only; provide the feature
context and existing CSS tokens. The preserved demo requires the host's demo
snapshot. Run `node scripts/journey-analytics-test.mjs` in this repository.

## Open Limitations

Native conversion paths may already be restricted by upstream attribution
windows. Missing paths alone do not establish broken tracking. CRM list
periods can differ from the path-date window, and a call is not evidence of
a closed sale. Original native evidence order can differ from the sorted
eligible flow. Very large samples are explicitly bounded in the snapshot.

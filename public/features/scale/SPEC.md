# Scale Advisor — feature spec

**id** `scale` · **mode** both (live + demo) · **version** 1.1.0

## Purpose
For every ad account and the six biggest ad sets by 30-day cost, show how
the cost of the NEXT customer rises with daily spend, and where it crosses
the CAC ceiling (the saturation point).

## Data (server step, `server.js`)
- `hyros_get_marginal_cac_curve` per target: `{ request: { id, level:
  ACCOUNT | SOURCE_LINK, startDate, endDate, cacCeiling? } }`. ACCOUNT
  level accepts at most 90 days, so the window is `end - 89 days → end` of
  the 30d range.
- **Ceiling.** Ad-set calls never send `cacCeiling`: HYROS derives the
  realized-LTV break-even ceiling (`ceilingBasis: LTV_BREAKEVEN`,
  `ltvWindow: 90_days` by default). Account level has no LTV, so the ceiling
  is the caller's or none: `cacCeiling` is sent only when
  `ctx.env.HYROS_CAC_CEILING` is a positive number (then
  `ceilingBasis: CALLER_PROVIDED`); otherwise it is omitted and the account
  curve has no ceiling and no saturation point.
- ~8 MCP calls, 15 s each, honoured against `ctx.timeLeft()`; a target
  that cannot run in time is stored `{ skipped: 'time budget' }`. Out of
  time before the first call → the previous block is kept with
  `stale: true, skipped`, or a bare `{ skipped }` when there is none.
- **Documented reply** (REST `GET /attribution/marginal-cac-curve`, mirrored
  by the tool): `curve[].{ spendPerDay, days, newCustomers, avgCac,
  marginalCac }` ordered by spend, `saturationPoint.{ efficientSpendPerDay,
  saturatedSpendPerDay, reason } | null`, `cacCeiling`, `ceilingBasis:
  CALLER_PROVIDED | LTV_BREAKEVEN`, `ltvWindow`, `daysSampled`,
  `attributionModel`, `notes: [NO_SPEND_DATA | NO_CUSTOMERS |
  INSUFFICIENT_DATA | LTV_CEILING_UNAVAILABLE]`. `normalizeCurve` reads
  these first and older spellings (`dailySpend`, `averageCac`, `customers`,
  `saturationPoint.dailySpend`) as fallbacks, and unwraps a REST
  `{ result }` envelope.
- **Known limitation (Sep 2026):** on some accounts the tool answers HTTP
  404. Every curve then carries `error`, and the view shows one card
  ("HYROS did not answer the CAC curve tool … ask HYROS support") instead
  of per-entity "not enough data".

## Block shape (`snapshot.scale`)
```json
{ "checkedAt": "ISO", "window": { "start": "YYYY-MM-DD", "end": "YYYY-MM-DD" },
  "curves": [{ "id": "", "name": "", "level": "ACCOUNT|SOURCE_LINK", "category": null,
               "attributionModel": "FIRST_CLICK", "daysSampled": 84,
               "ceiling": 52, "ceilingBasis": "CALLER_PROVIDED|LTV_BREAKEVEN|null", "ltvWindow": "90_days|null",
               "saturationSpend": 2274.75, "efficientSpend": 1490.1, "saturationReason": "MARGINAL_CAC_ABOVE_CEILING|null",
               "points": [{ "spend": 812.4, "days": 28, "customers": 594, "avgCac": 38.29, "marginalCac": null }],
               "notes": [],
               "error": "optional", "skipped": "optional" }],
  "stale": "optional true", "skipped": "optional" }
```
`saturationSpend` is the first wasteful spend level (`saturatedSpendPerDay`);
`efficientSpend` the last efficient one. Both `null` when saturation was not
reached (or no ceiling exists).

## View states
Fresh · stale (`stale: true` → "showing curves from a previous refresh" with
`fmt.datetime(checkedAt)`) · bare `{ skipped }` · `{ error }` · all curves
errored (one "did not answer" card). "Entities analyzed" counts only curves
that were actually requested (per-curve `{ skipped }` excluded).

## Demo
`demo.js` builds curves from the demo snapshot's ad sets with a
deterministic RNG in the exact block shape above; ad sets carry an
`LTV_BREAKEVEN` ceiling, ad accounts none (no caller ceiling on the Demo
account); every third entity keeps scaling (no saturation).

## Rules honoured
- Never fails the refresh: every error lands inside the block.
- No env var is required; `HYROS_CAC_CEILING` is optional and only read
  through `ctx.env`.
- Chart is inline SVG in the app's tokens (no chart library).

## Porting notes
Another app needs the block above; `view.js` + `style.css` reuse unchanged.
HYROS-specific: the 90-day cap at account level, the `{ request }`
argument wrapper, UPPERCASE `level` values.

## Open limitations
The tool currently returns 404 on some accounts (see FINDINGS.md); until
HYROS enables it, the tab shows the "did not answer" card on those accounts.

# Scale Advisor — feature spec

**id** `scale` · **mode** both (live + demo) · **version** 1.2.0

## Purpose
Compare observed average and marginal CAC with daily spend and explicit
CAC ceilings. Curves describe sampled history; they are not predictions
or evidence that raising a budget will reproduce an outcome.

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
- All connected ad accounts plus the six largest ad sets, preserving the
  existing target-list contract. Unrequested targets retain skipped rows.
  The first call
  uses `ctx.slowTimeout(2000)` when offered; all later calls stay on the
  15 s default lane. Every timeout is capped by the remaining budget minus
  2 s. A target
  that cannot run in time is stored `{ skipped: 'time budget' }`. Out of
  time before the first call → the previous block is kept with
  `stale: true, skipped`, or a bare `{ skipped }` when there is none.
- Partial refreshes retain the previous curve for failed/skipped entities
  with `stale: true`, the original `checkedAt` and its own `window`.
  Rate-limit and account-access failures stop subsequent calls in that
  step. Timeouts and rate limits advise the next refresh, without retries.
- Malformed replies produce errors, not empty success. Only finite numeric
  samples are accepted; invalid/negative spend is omitted. Curves are
  bounded to 120 buckets and 30 provider notes, with truncation notes.
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
  "configuredCeiling": null,
  "notes": [],
  "coverage": { "requested": 2, "eligible": 2, "shown": 2, "fresh": 1, "failed": 1, "skipped": 0 },
  "curves": [{ "id": "", "name": "", "level": "ACCOUNT|SOURCE_LINK", "category": null,
               "attributionModel": "FIRST_CLICK", "daysSampled": 84,
               "ceiling": 52, "ceilingBasis": "CALLER_PROVIDED|LTV_BREAKEVEN|null", "ltvWindow": "90_days|null",
               "saturationSpend": 2274.75, "efficientSpend": 1490.1, "saturationReason": "MARGINAL_CAC_ABOVE_CEILING|null",
               "points": [{ "spend": 812.4, "days": 28, "customers": 594, "avgCac": 38.29, "marginalCac": null }],
               "notes": [],
               "checkedAt": "optional ISO", "window": { "start": "date", "end": "date" },
               "error": "optional", "errorCode": "optional", "retry": "optional next refresh",
               "stale": "optional true", "skipped": "optional" }],
  "stale": "optional true", "skipped": "optional" }
```
`saturationSpend` is the first wasteful spend level (`saturatedSpendPerDay`);
`efficientSpend` the last efficient one. Both `null` when saturation was not
reached (or no ceiling exists).

## View states
Fresh · stale (`stale: true` → "showing curves from a previous refresh" with
`fmt.datetime(checkedAt)`) · bare `{ skipped }` · `{ error }` · all curves
errored (one "did not answer" card). "Entities analyzed" counts only curves
that returned fresh results (failed, stale and skipped curves excluded).
Provider notes remain visible even when a curve has points. A missing
ceiling or saturation point never becomes a "room to scale" claim.

The comparison ceiling is a positive numeric input held locally in the
view; it neither changes the configured account request ceiling nor writes
HYROS settings. Its chart line and labels are separate from the provider's
ceiling and saturation point. Reset returns to the provider's ceiling.
Observed-bucket selection compares that exact bucket's marginal CAC with
the threshold. It does not interpolate, extrapolate or project customer
counts. The sample table exposes days, customers and CAC per bucket.

Attribution labels use returned `attributionModel` only: FIRST_CLICK is
acquisition credit, LAST_CLICK is closing credit; other or missing models
are explicitly labeled. The UI does not infer role from an ad name or
claim both models are available when only one was returned.

## Demo
`demo.js` builds curves from the demo snapshot's ad sets with a
deterministic RNG in the exact block shape above; ad sets carry an
`LTV_BREAKEVEN` ceiling, ad accounts none (no caller ceiling on the Demo
account). Saturation is consistent with the illustrative points and
ceiling. Every demo scenario is visibly labeled as a sample.

## Rules honoured
- Never fails the refresh: every error lands inside the block.
- No env var is required; `HYROS_CAC_CEILING` is optional and only read
  through `ctx.env`.
- Chart is inline SVG in the app's tokens (no chart library).

## Porting notes
Another app needs the block above; `view.js`, `analysis.js` and `style.css`
reuse unchanged. New fields are optional for old snapshots.
HYROS-specific: the 90-day cap at account level, the `{ request }`
argument wrapper, and the `level` vocabulary. The REST docs spell the
levels `ad | source_link | campaign | account` (lowercase); the MCP tool is
sent them **UPPERCASE** (`ACCOUNT`, `SOURCE_LINK`) — that casing is
undocumented and mirrors the other report tools (see FINDINGS.md
"Undocumented behaviour the app relies on").

## Open limitations
- Earlier checks returned HTTP 404 on some accounts. The 2026-09-23
  research probe timed out at 15 s; that did not validate a live curve or
  establish that the endpoint was disabled. This implementation was tested
  with deterministic replies, not a new live HYROS query.
- `cacCeiling` is optional with no default: without `HYROS_CAC_CEILING`
  the account-level curves have no ceiling and therefore no saturation
  point (documented behaviour, not a bug).
- The `notes` enum and `saturationPoint.reason` values beyond
  `MARGINAL_CAC_ABOVE_CEILING` are documented only as prose; the view maps
  the four documented notes to plain words and shows any other value
  verbatim.

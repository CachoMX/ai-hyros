# Creative Intelligence

**id** `creative` | **mode** `both` | **version** `1.0.0`

## Purpose

Inspect configured name dimensions and the actual revenue share carried by each ad. Concentration is an observed distribution subject to operator evidence thresholds; it is not a claim of significance, creative quality, fatigue, or causation.

## Data

The server copies native `ctx.snapshot.ranges[*].levels.ad` rows with the shared economics capture helper. Parent ad-set identities enrich platform/account only through an actual `parentId` join. No additional MCP calls, external writes, or inferred media assets. The demo copies core demo rows without changing names, metrics, or creating historical points.

## Block shape

The block matches Profit Engine's captured range shape with `level: "ad"`. Every range has `start`, `end`, `rows`, `sourceCount`, `complete`, and `errors`; top-level fields are `checkedAt`, `model`, `currency`, `ranges`, `errors`, and `comparison`.

`comparison` is null unless a complete actual previous block contains an adjacent, equal-length, completed period using the same model and currency. At most one comparison is retained, prioritized 30d, 7d, then yesterday, to bound snapshot size. Its shape is `{ rangeKey, start, end, rows, sourceCount, complete, errors, model, currency, checkedAt }`. An unchanged window is not a trend. Today is not compared to a completed day. Stale or skipped previous blocks cannot establish a new comparison. Existing comparable history may survive subsequent refreshes of the same completed window.

Each current range is capped at 200 rows or 35,000 bytes of row data; the four ranges plus one comparison stay below the feature's 200 KB budget for normal scalar metadata. Capping is explicit. Native missing metrics remain absent or null.

## Grouping and evidence

Both current and comparison blocks include `context`, a stable encoding of attribution-window and lead-stage settings. Missing or changed context suppresses trends. Incomplete report coverage suppresses concentration flags, even though the observed shares of captured rows remain inspectable. CSV exports include capture time and stale status.

- Naming settings are local per account and initially unconfigured. Default slots are concept, angle, hook, format, variation, with `_` delimiter; defaults are not applied until the operator enables name slots.
- The five positions can be reordered or ignored. Duplicate slot assignments are rejected. Blank segments stay unknown. Segments beyond the fifth are joined into the final slot. An empty delimiter treats the whole name as the first slot.
- Configured groupings use the selected parsed dimension. Missing concept names fall back to the actual parent ad set, explicitly labeled. Unclassified rows remain visible. Platform and ad account scope keep unrelated groups separate.
- Metrics are summed before ROAS is derived. Total revenue is preferred and never has rebills added again; the same fallback and caveats as Profit apply.
- Variant means an individual native ad row. Share is its revenue divided by the group revenue. A zero/missing total or any negative variant revenue makes concentration unavailable. Zero spend produces null ROAS.
- Concentration requires share strictly above the configured percentage, at least the configured number of variants, and configured minimum spend and sales. Default threshold: over 70%, at least three variants; minimum spend/sales initially zero. These are editable observation thresholds, not statistical tests.
- Group ROAS change is shown only when the retained periods are comparable, revenue basis matches, ad IDs match exactly, and comparison ROAS is positive. Ad mix changes and missing IDs suppress the percentage. Overlapping 7d/30d ranges are never used to imply trends.

## View states

Fresh, stale, bare skipped, error, null, and empty states render against the feature-check fake DOM. A stale result names its own previous capture time. Controls include a naming editor, evidence thresholds, dimension/platform/evidence filters, search, sorting, expansion to all parsed slots and actual ad IDs, and filtered CSV export with settings and source caveats. Settings are visibly browser-local; storage failures fall back to the session.

## Rules honoured

No extra calls or required environment variables. A spent server budget retains previous evidence with correct markers. Deterministic demo, bounded blocks, defensive localStorage, scoped styles using app tokens, mobile layout, and null-aware arithmetic. No inferred images, generated performance history, or causal recommendations.

## Porting notes

Copy this folder, `public/shared/profit.js`, and `public/features/profit/ui.js` (shared status and CSV helpers). `analysis.js` is otherwise dependency-light pure JavaScript, usable in Node or browser. The grouping/parser logic adapts Mosaide's pure algorithms while fixing zero-spend ratios, unknown revenue, default naming assumptions, and cross-account grouping.

## Open limitations

Asset URLs and image/video content are not in the current core report, so creative assets are unavailable. Names cannot verify creative content. Ad-level coverage may differ from other report levels; warnings and truncation remain visible. Historical comparisons need actual earlier completed snapshots and commonly remain unavailable. No synthetic fatigue or significance score is supplied. See `FINDINGS.md` and `CONTEST-RESEARCH.md` for source coverage limits.

## Validation

`node scripts/economics-test.mjs` covers parsing, actual concentration shares, thresholds, missing/zero/negative values, account boundaries, comparable periods, changed ad mixes, deterministic demo, all render states, bounded capture, and the tool-free server path.

# Scale Advisor — feature spec

**id** `scale` · **mode** both (live + demo) · **version** 1.0.0

## Purpose
For every ad account and the six biggest ad sets by 30-day cost, show how
the cost of the NEXT customer rises with daily spend, and where it crosses
the CAC ceiling (the saturation point).

## Data (server step, `server.js`)
- `hyros_get_marginal_cac_curve` per target: `{ id, level: ACCOUNT |
  SOURCE_LINK, startDate, endDate, cacCeiling? }`. ACCOUNT level accepts at
  most 90 days, so the window is `end - 89 days → end` of the 30d range.
- ACCOUNT calls pass `cacCeiling` from `HYROS_CAC_CEILING` (default 100);
  ad-set calls let HYROS derive the ceiling (`ceilingBasis`).
- ~8 MCP calls, ≤15s each, honoured against `ctx.timeLeft()`; a target that
  cannot run in time is stored `{ skipped: 'time budget' }`.

## Block shape (`snapshot.scale`)
```json
{ "window": { "start": "", "end": "" },
  "curves": [{ "id": "", "name": "", "level": "ACCOUNT|SOURCE_LINK", "category": null,
               "attributionModel": "FIRST_CLICK", "daysSampled": 60,
               "ceiling": 120, "ceilingBasis": "CALLER_PROVIDED|REALIZED_LTV_90_DAYS",
               "saturationSpend": 900, "notes": [],
               "points": [{ "spend": 0, "avgCac": 0, "marginalCac": 0, "customers": 0 }],
               "error": "optional", "skipped": "optional" }] }
```
The point keys are read tolerantly (`normalizeCurve`) because the tool's
documented shape is loose.

## Demo
`demo.js` builds curves from the demo snapshot's ad sets with a deterministic
RNG; every third entity keeps scaling (no saturation).

## Rules honoured
- Never fails the refresh: every error lands inside the block.
- Chart is inline SVG in the app's tokens (no chart library).

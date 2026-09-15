# Funnel & Journey — feature spec

**id** `funnel` · **mode** demo · **version** 1.0.0

## Purpose
Show the visitor-to-customer funnel stage by stage, where customers enter
(share of new leads by campaign), where they convert (share of customers by
credited campaign), and the most common tracked paths to purchase.

## Data
- Reads `snapshot.ranges['30d']` — totals (`clicks`, `carts`, `leads`,
  `uniqueCustomers`) and the campaign level rows.
- Demo only today: the path list is illustrative. A live version needs the
  per-lead click history (`hyros_get_clicks` / `hyros_get_lead_journey` per
  lead, ≤ 50 leads per call) aggregated server-side — expensive without a
  bulk endpoint, see FINDINGS.md "Aggregate clicks endpoint".

## Block shape (`snapshot.funnel`)
```json
{ "stages": [{ "label": "", "sub": "", "value": 0 }],
  "entering": [{ "name": "", "value": 0, "share": 0.0 }],
  "converting": [{ "name": "", "value": 0, "share": 0.0, "cvr": 0.0 }],
  "paths": [{ "pct": 44, "steps": ["", ""] }],
  "avgTouches": 3.4, "avgDaysToConvert": 5.2 }
```

## View states
Demo-only today, but the view renders every runner state: a block without
`stages` (`{ error }`, `{ skipped }`, `{}`) shows a status line instead of
throwing; a stale block (`stale: true, skipped`) shows the data with
"Showing the previous result".

## Rules honoured
- Stages are monotonic; a conversion ratio over 100% (credit reassignment)
  is hidden, never shown.
- Whole-dollar formatting follows `ctx.fmt` (cents off in demo mode).

## Porting notes
Everything the view needs is in the block; another app only has to produce
the block shape above to reuse `view.js` + `style.css` unchanged.

## Open limitations
- Illustrative: stages come from the report totals, but the entry/convert
  shares and the paths are generated, not measured.
- **Closest live path today:** the reports `groupBy: JOURNEY` family
  (`hyros_generate_public_report` → `hyros_poll_public_report_result`; 30 journeys per call, asynchronous, each
  journey with its `journeySteps`) — see FINDINGS.md "Sept 2026 MCP
  upgrade". Paging 30 journeys at a time keeps it out of a single refresh
  budget for anything but a small sample; a proper live version still waits
  on the aggregate clicks endpoint (FINDINGS.md "Aggregate clicks
  endpoint").

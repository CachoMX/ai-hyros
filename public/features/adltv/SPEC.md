# Ad LTV — feature spec

**id** `adltv` · **mode** demo · **version** 1.0.0

## Purpose
For the top 5 ads by credited revenue: how the value of the customers each
ad created grows over 60 days (first purchase → LTV 30 → LTV 60), which
OTHER traffic sources those customers also clicked, and which assisting
source produced the most closed calls.

## Data
- Reads `snapshot.ranges['30d']` ad + ad-set rows (name, parentName,
  revenue, sales, uniqueCustomers).
- Demo only today. Two possible live paths:
  1. **Per-lead assembly**, per top ad: the customer cohort
     (`hyros_get_leads` filtered by the ad's source tag), their sales over
     60 days (`hyros_get_sales` by `leadIds`; the documented REST LTV field
     is `60_days_ltv` — the MCP `fields` enum casing for it is undocumented,
     so verify against `tools/list` before relying on `LTV_60_DAYS`), their
     click history (`hyros_get_clicks` / `hyros_get_lead_journey`) and calls
     (`hyros_get_calls`). All exist but are per-lead.
  2. **Reports**: `hyros_generate_public_report` (+ `hyros_poll_public_report_result`) with `groupBy: JOURNEY` (the
     customer paths, `journeySteps` per journey) and `groupBy:
     SALE_ITEM_LTV` (LTV per sale item) — async (generate, then poll), and
     the closest thing to a bulk endpoint today; see FINDINGS.md "Sept 2026
     MCP upgrade".
- **Caps to budget for** (FEATURES.md "MCP limits"): ≤ 50 `leadIds` /
  `emails` per call; `hyros_get_lead_journey` ≤ 50 leads per call;
  `pageSize` ≤ 250; one rate limit per HYROS account, shared by every key
  of the account (an agency's clients included); `accessible_account_id` is
  already applied by `ctx.callTool`. Budget the server step against
  `ctx.timeLeft()` (see FEATURES.md "server.js").

## Block shape (`snapshot.adltv`)
```json
{ "window": { "start": "YYYY-MM-DD", "end": "YYYY-MM-DD" },
  "rows": [{ "rank": 1, "name": "", "adset": "", "campaign": "", "customers": 0,
             "revenue60": 0, "ltv0": 0, "ltv30": 0, "ltv60": 0, "mult": 1.5,
             "assists": [{ "name": "", "kind": "email|organic|ads", "pct": 0.4, "touched": 0, "closedCalls": 0 }] }],
  "callLeaders": [{ "name": "", "kind": "", "closedCalls": 0, "touched": 0 }] }
```

## View states
Demo-only today, but the view still renders every runner state: a block
without `rows` / `callLeaders` (`{ error }`, `{ skipped }`, `{}`) shows a
status line; a stale block (`stale: true, skipped`) shows the data with
"Showing the previous result". Every data string, including the top ad's
name in the KPI sub, goes through `ctx.esc`.

## Rules honoured
- One row per distinct creative (the same ad name in several ad sets keeps
  its best instance).
- Money through `ctx.fmt.money` (whole dollars in demo mode).

## Porting notes
Everything the view needs is in the block; another app only has to produce
the block shape above to reuse `view.js` + `style.css` unchanged.

## Open limitations
- Illustrative numbers: cohorts, LTV steps, assists and closed calls are
  generated from the demo snapshot, not measured.
- Going live needs either the per-lead assembly (50 leads per call, so
  ~5 ads × cohort size / 50 calls) or the `JOURNEY` / `SALE_ITEM_LTV`
  reports; what is still missing for a cheap version is the aggregate
  clicks endpoint (FINDINGS.md "Aggregate clicks endpoint") and a
  `TOUCHED` attribution mode (FINDINGS.md "`attributionMode: CREDIT |
  TOUCHED`").

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
- Demo only today. A live version needs, per top ad: the customer cohort
  (`hyros_get_leads` filtered by the ad's source tag), their sales over 60
  days (`hyros_get_sales` by leadIds, `LTV_60_DAYS` field), their click
  history (`hyros_get_lead_clicks`) and calls (`hyros_get_calls`). All exist
  but are per-lead; budget the server step (see FEATURES.md "server.js").

## Block shape (`snapshot.adltv`)
```json
{ "window": { "start": "YYYY-MM-DD", "end": "YYYY-MM-DD" },
  "rows": [{ "rank": 1, "name": "", "adset": "", "campaign": "", "customers": 0,
             "revenue60": 0, "ltv0": 0, "ltv30": 0, "ltv60": 0, "mult": 1.5,
             "assists": [{ "name": "", "kind": "email|organic|ads", "pct": 0.4, "touched": 0, "closedCalls": 0 }] }],
  "callLeaders": [{ "name": "", "kind": "", "closedCalls": 0, "touched": 0 }] }
```

## Rules honoured
- One row per distinct creative (the same ad name in several ad sets keeps
  its best instance).
- Money through `ctx.fmt.money` (whole dollars in demo mode).

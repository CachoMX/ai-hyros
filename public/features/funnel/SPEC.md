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
  per-lead click history (`hyros_get_lead_clicks` / `hyros_get_lead_journey`
  per lead) aggregated server-side — expensive without a bulk endpoint, see
  FINDINGS.md "Aggregate clicks endpoint".

## Block shape (`snapshot.funnel`)
```json
{ "stages": [{ "label": "", "sub": "", "value": 0 }],
  "entering": [{ "name": "", "value": 0, "share": 0.0 }],
  "converting": [{ "name": "", "value": 0, "share": 0.0, "cvr": 0.0 }],
  "paths": [{ "pct": 44, "steps": ["", ""] }],
  "avgTouches": 3.4, "avgDaysToConvert": 5.2 }
```

## Rules honoured
- Stages are monotonic; a conversion ratio over 100% (credit reassignment)
  is hidden, never shown.
- Whole-dollar formatting follows `ctx.fmt` (cents off in demo mode).

## Porting notes
Everything the view needs is in the block; another app only has to produce
the block shape above to reuse `view.js` + `style.css` unchanged.

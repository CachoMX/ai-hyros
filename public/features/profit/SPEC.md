# Profit Engine

**id** `profit` | **mode** `both` | **version** `1.0.0`

## Purpose

Inspect contribution, net profit, and observed break-even ROAS for native ad-set rows with explicit cost and refund assumptions. Missing margins or unavailable inputs remain unknown.

## Data

The live builder uses only `ctx.snapshot.ranges[*].levels.adset`. No MCP calls, required environment variables, or external writes. Native rows preserve absent metrics; the core's higher-level aggregation can turn absent additive metrics into zero and is deliberately not used. Each of the four standard ranges is capped at 200 rows and 35,000 bytes of row data, with coverage errors when capped. The deterministic demo copies the existing demo report; no extra synthetic economics or default margin is supplied.

## Block shape

```json
{
  "checkedAt": "2026-09-23T12:00:00Z",
  "level": "adset",
  "currency": "USD",
  "model": "LAST_CLICK",
  "ranges": {
    "30d": {
      "start": "2026-08-25",
      "end": "2026-09-23",
      "rows": [{ "id": "set-1", "name": "Set", "cost": 100, "totalRevenue": 200, "refund": 0 }],
      "sourceCount": 1,
      "complete": true,
      "errors": []
    }
  },
  "errors": []
}
```

Rows may also preserve `parentId`, `parentName`, `_account`, `_traffic`, `productId`, `offerId`, `offer`, `revenue`, `recurringRevenue`, `hardCosts` (or `hardCost`), and `sales`. Values stay unformatted; absence is distinct from zero. Dates and row names are not rewritten. Copied ranges retain their own evidence even when the runner reuses the block as stale.

## Shared API

The block also records `context`, a stable JSON encoding of the source attribution-window and lead-stage settings, or null when those settings are unavailable. Creative uses this for comparison eligibility. CSV exports include source capture time and stale status.

`public/shared/profit.js` has no DOM, package, or Node dependencies. The public API is:

- `loadProfitSettings(account)` returns normalized settings. `null` account means `default`; the demo UI uses the distinct `demo` key.
- `saveProfitSettings(account, settings)` returns `{ settings, persisted }`. Storage failures keep an isolated in-memory session copy. No server persistence or external mutation occurs.
- `computeProfit(row, settings)` returns `{ revenue, contribution, netProfit, breakEvenRoas, configured, issues }`, plus `revenueBasis`, `spend`, `overhead`, `refundDeduction`, `marginPct`, and `roas` for evidence. Unknown numeric values are `null`. `configured` describes cost/refund configuration, not source completeness; consumers must also inspect `netProfit` and `issues`.
- `computeProfitRows(rows, settings, window)` applies account overhead once to an inclusive date window and returns each calculation with its original `row`.

Settings: `defaultMarginPct` (0..100 or null), `productMargins` and `offerMargins` (ID-to-percentage maps), `dailyOverhead` (account currency, default 0), `costBasis` (`margin` or `native`), `refundTreatment` (`unknown`, `included`, `subtract`), and `nativeCostsIncludeRefunds` (boolean or null). Product overrides precede offer overrides, then the default. Only explicit row identities match; ad names never imply products. The view exposes mapping inputs only when those identities exist in the captured rows.

For a standalone row calculation, nonzero daily overhead requires an explicit `settings.overhead` allocation. Without it, `netProfit` stays null. War Room can use `computeProfitRows` for complete row sets or supply its own documented allocation. Do not charge the whole account overhead independently to each row.

## Calculations

- Prefer finite `totalRevenue`, including zero. Never add rebills to this value.
- If total revenue is missing, use `revenue + recurringRevenue` only when both inputs exist, with an issue naming that fallback. With only `revenue`, preserve it and flag unknown rebill coverage. Recurring revenue alone cannot stand in for total revenue.
- Margin basis: `contribution = revenue * margin / 100 - refundDeduction`. The margin already represents variable costs, so native hard costs, COGS, taxes, shipping, and the core's derived `profit` are not subtracted again.
- Native basis: `contribution = revenue - hardCosts - refundDeduction`; no margin cost is also applied.
- `included` means revenue already has refunds deducted. `subtract` uses the magnitude of the actual `refund` field. Native hard costs that already include refunds absorb this deduction; net revenue combined with refund-inclusive native costs is blocked because it would count refunds twice. Unknown native refund inclusion is also blocked where relevant.
- Unknown refund treatment is permitted only for an explicitly zero refund field. Missing refunds are not zero.
- `netProfit = contribution - adSpend - allocatedOverhead`.
- `breakEvenRoas = (1 + allocatedOverhead / adSpend) / (contribution / revenue)` only when spend, revenue, and contribution are positive and overhead is known. This uses the observed cost/refund mix; it is not a forecast. Zero-spend ROAS and break-even ROAS are null.
- Overhead is allocated in proportion to spend across all captured rows before filtering. With all-zero spend, allocate equally. Missing spend or invalid dates prevents nonzero overhead allocation. Unknown components make displayed aggregate economics unknown, rather than a partial sum presented as complete.

## View states

Fresh, stale, bare skipped, error, empty, and null blocks render without requiring full DOM methods. Stale blocks explicitly show the previous result and its own `checkedAt`. Controls include account-local settings, search, profit-state filter, sort, native evidence expansion, and a CSV export of filtered rows with calculation settings and coverage issues. CSV text beginning like a formula is escaped.

## Rules honoured

No tools or external fetches. A spent budget returns previous data with fresh stale markers or a bare skip. Demo is deterministic. Styles use the existing design tokens and horizontally scroll wide tables on narrow screens. No higher-level ROAS averaging or automatic recommendation occurs.

## Porting notes

Copy this feature folder and `public/shared/profit.js`. Provide the standard feature context and formatting helpers. `ui.js` is also used by Creative for status and CSV generation; copy it when moving that feature. Settings intentionally remain browser-local and are visibly identified as such.

## Open limitations

The report usually lacks product/offer identities. CRM sales are not joined heuristically to ads. Cost coverage is not business-wide completeness: untracked expenses, return inventory recovery, and mixed product economics require configured assumptions or additional source data. Native refund inclusion requires operator confirmation; the code does not infer undocumented HYROS semantics. No future LTV, payback period, or financial prediction is invented. Relevant source gaps are described in `FINDINGS.md` and `CONTEST-RESEARCH.md`.

## Validation

`node scripts/economics-test.mjs` covers margin absence, explicit zero, rebills, refunds, mutually exclusive costs, allocation, zero spend, account isolation, all view states, source limits, and live builds without extra tools. Optional `--browser` uses an installed Playwright package and the existing local preview at port 4321 to check settings, filters, expansion, CSV download, and desktop/mobile page overflow; screenshots go to a temporary directory.

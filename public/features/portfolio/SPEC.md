# Agency Portfolio

**id** `portfolio` / **mode** `both` / **version** `1.0.0`

## Purpose
Compare registered account performance and identify accounts requiring attention.
Rows show spend, total revenue including rebills, ROAS including rebills, calls,
leads, reporting dates, snapshot age, and connection health.

## Data
`GET /api/portfolio?range=30d` uses the existing dashboard password gate,
`listAccounts({ withStatus: false })`, and `readSnapshot(id)`. It makes no HYROS
requests and no writes. Only registered `acc_` / `cli_` IDs are read; request
parameters cannot select a different snapshot namespace. Clients require an
approved relationship, present agency, working key status, and verified client
mode. Accounts with invalid keys are gated before reading their snapshots.

The response whitelists summary fields. Personal/email registry labels, keys,
raw errors, CRM rows, ad rows, and agency relationship identifiers are omitted.
Business company labels are retained; otherwise labels use the account ID suffix.
HTTP responses are private and not cached. Unauthenticated requests return 401,
other methods 405, invalid ranges 400, and unavailable storage 503.

`server.js` only returns the current account's lightweight summaries. No MCP
tools, packages, Node built-ins, credentials, or external services are required
by feature files. The view loads the complete registry through `ctx.api`.

Demo data consists of exactly three deterministic, explicitly named demo
accounts in USD and EUR, derived from the demo snapshot totals. One is stale.
The view uses these fixtures only when `ctx.demo` is true and makes no API calls
in demo mode. Live rendering ignores demo accounts and seed snapshots.

## Block Shape
```json
{
  "checkedAt": "2026-09-23T12:00:00.000Z",
  "current": { "30d": { "id": "", "label": "Current account" } },
  "accounts": []
}
```
`current` contains one summary per range (`today`, `yesterday`, `7d`, `30d`).
The demo block has `current: {}` and `accounts: [{ id, ranges: { "30d": summary } }]`.
An endpoint response contains `{ ok, checkedAt, range, staleAfterHours, accounts,
totals }`, where `accounts` is a flat list of summaries for the requested range.

```json
{
  "id": "acc_0123456789ab",
  "label": "North Studio",
  "kind": "key",
  "agency": false,
  "currency": "USD",
  "status": "fresh",
  "reason": null,
  "generatedAt": "2026-09-23T11:00:00.000Z",
  "ageHours": 1,
  "window": { "start": "2026-08-25", "end": "2026-09-23" },
  "metrics": { "spend": 100, "totalRevenue": 320, "roas": 3.2, "calls": 6, "leads": 24 },
  "partial": false,
  "canOpen": true,
  "demo": false
}
```
Missing metrics are `null`, never inferred from CRM counts or initial revenue.
`status` is `fresh`, `stale`, `error`, or `not_connected`. Reasons are fixed codes
defined by `model.js`; upstream error messages never leave the endpoint.

## View States
Fresh data, previous/stale data, bare skipped, error, null, and empty blocks all
render safely with minimal fake DOM roots. Requests are aborted on re-render;
identity and sequence guards discard old account/range responses and hidden or
disconnected roots. Failed reloads clear rows, including on authentication loss.
Filtering preserves input focus; currency and metric sorts keep currencies
separate. CSV exports visible rows with status, date range, currency, and demo
markers. String cells are protected against spreadsheet formula execution.

## Rules Honoured
- Revenue uses stored `totals.totalRevenue`, which includes rebills. ROAS is
  total revenue divided by spend; it is unavailable when spend is zero.
- Each currency is aggregated independently; there is no grand monetary total
  and no currency conversion. Account IDs are deduplicated before aggregation.
- Partial, errored, disconnected, and unknown-currency accounts are excluded
  from totals. Missing metric components keep the aggregate metric unknown.
- Snapshots older than 36 hours are stale. Unknown/future timestamps and runner
  stale flags also prevent a fresh status. Totals label included stale snapshots
  and differing reporting windows. Skipped ranges do not become zero totals.
- The view uses local design tokens, a responsive table, and guarded DOM calls.
- A spent feature budget returns the previous block marked stale, or a bare
  skipped marker. Zero MCP calls are made in all cases.

## Porting Notes
Register `portfolio` in `public/features/registry.js`. Deploy `api/portfolio.js`
with the existing auth, registry, and snapshot helpers. The local development
server must explicitly route authenticated GET `/api/portfolio`; it does not
automatically discover serverless handlers. An in-memory preview adapter can
use `createPortfolioHandler` with injected read-only dependencies, but production
must use the default authenticated handler and persisted snapshots.

The parent listens for the bubbling event
`hyros:account` with `detail: { accountId, view: 'warroom' }` and performs the
account switch. Demo rows do not dispatch synthetic account IDs.

Run focused tests with `node scripts/portfolio-test.mjs`. Add this command to the
parent test workflow when integrating; the feature agent does not edit registry,
package scripts, development routing, auth/store helpers, or core app files.

## Open Limitations
The portfolio reflects stored snapshots, not a live API poll. The existing store
helper fails soft: a missing snapshot and a KV read failure both return null and
are shown as unavailable. A registry read that returns an empty array cannot
distinguish an empty registry from a store outage with the existing helper API.
Account labels may be generic when the registry only has a person's email.
Accounts can have different reporting dates or attribution settings; date
differences are shown. Distinct registered keys or agency/client reports may
cover overlapping attribution, so totals are account-report sums rather than
deduplicated business revenue. The UI warns when an agency row is present.

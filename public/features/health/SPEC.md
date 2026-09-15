# Tracking Health — feature spec

**id** `health` · **mode** both (live + demo) · **version** 1.0.1

## Purpose
Answer "is tracking actually working?" with HYROS's own checks: the
universal script's presence on each verified domain, and whether Google ad
links carry the tracking parameters attribution needs.

## Data (server step, `server.js`)
1. `hyros_get_domains` → verified domains (first 20).
2. `hyros_assert_script_presence_on_domain { domains: [url…] }` for up to 5
   domains → `{ url: 'SCRIPT_FOUND' | 'SCRIPT_NOT_FOUND' }`.
3. If any ad account is Google: `hyros_check_tracking_parameters_for_integrations
   { request: { type } }` for `SEARCH` and `PERFORMANCE_MAX` (rows capped at 50).
Each step is independent; failures append to `errors` and never fail the
refresh. `ctx.timeLeft()` is checked before the FIRST call (zero calls on a
spent budget: the previous block is kept marked `stale`, or a bare
`{ skipped }` is returned); every call uses a 15 s timeout. Reply shapes
are undocumented and read tolerantly; a script-check reply that is not a
`{ url: status }` map (or an array of `{ url, status }`) is recorded as
`errors: ['script: unexpected reply shape']` instead of an empty result.

## Block shape (`snapshot.health`)
```json
{ "checkedAt": "ISO", "domains": ["example.com"],
  "scripts": { "https://example.com/": "SCRIPT_FOUND" },
  "trackingParams": [{ "type": "SEARCH", "rows": [{ "adName": "", "valid": true, "missing": ["gclid"] }] }],
  "errors": [] }
```
The parameter rows' shape is whatever HYROS returns; the view flags a row
when `valid === false`, `missing` exists, or the row text mentions
missing/invalid.

## Also shown
Account & access — ad accounts, `managedBy` / `clients` from
`snapshot.account`, and the account's default attribution window. An ad
account that appears in `snapshot.warnings[]` (`{ adAccountId, name, type,
level, error, kind }`, kind ∈ unsupported | rate_limited | error |
truncated | time budget) gets a pill with the kind (e.g. "skipped:
unsupported") and the message as its title.

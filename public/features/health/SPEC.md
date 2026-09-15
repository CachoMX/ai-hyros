# Tracking Health — feature spec

**id** `health` · **mode** both (live + demo) · **version** 1.0.1

## Purpose
Answer "is tracking actually working?" with HYROS's own checks: the
universal script's presence on each verified domain, and whether Google ad
links carry the tracking parameters attribution needs.

## Data (server step, `server.js`)
1. `hyros_get_domains` → verified domains (first 20). The REST side
   documents `GET /domains` → `string[]`; the tool reply is read as a bare
   array or `{ result | domains: [string | { domain | name | url }] }`.
2. `hyros_assert_script_presence_on_domain { domains: [url…] }` for up to
   5 domains → expected `{ url: 'SCRIPT_FOUND' | 'SCRIPT_NOT_FOUND' }`.
3. If any ad account is Google:
   `hyros_check_tracking_parameters_for_integrations { request: { type } }`
   for `SEARCH` and `PERFORMANCE_MAX` (rows capped at 50).

**Undocumented shapes.** Neither the request nor the response shape of
tools 2 and 3 is documented (mcp.txt lists the tools by name only; see
FINDINGS.md "Undocumented behaviour the app relies on"). The argument
shapes above are the app's guess, and the replies are read tolerantly: a
script-check reply that is a `{ url: status }` map, a `{ result: map }`
envelope, or an array of `{ url | domain, status | result | present }` is
accepted; anything else is recorded as `errors: ['script: unexpected reply
shape']` instead of an empty result. Parameter rows are taken from a bare
array, `result`, `ads`, or a single object; the view flags a row when
`valid === false`, `missing` exists, `ok === false`, or the row text
mentions missing/invalid.

Each step is independent; failures append to `errors` and never fail the
refresh. `ctx.timeLeft()` is checked before the FIRST call (zero calls on a
spent budget: the previous block is kept marked `stale`, or a bare
`{ skipped }` is returned) and before every call after it; every call uses
a 15 s timeout (FEATURES.md rule: per-call timeouts ≤ 15 s).

## Block shape (`snapshot.health`)
```json
{ "checkedAt": "ISO", "domains": ["example.com"],
  "scripts": { "https://example.com/": "SCRIPT_FOUND" },
  "trackingParams": [{ "type": "SEARCH", "rows": [{ "adName": "", "valid": true, "missing": ["gclid"] }] }],
  "errors": [],
  "stale": "optional true", "skipped": "optional" }
```
The parameter rows' shape is whatever HYROS returns (see above).

## View states
- **fresh** — the block above.
- **stale** — `{ ...data, stale: true, skipped: 'time budget' }`: the note
  says "Skipped this refresh (…) — showing the previous check from
  `fmt.datetime(checkedAt)`".
- **bare skipped** — `{ skipped }`: "nothing was checked yet. Hit Refresh
  again"; every KPI shows "—" and the panels say "Not checked this
  refresh".
- **error** — `{ error }`: the message in the note bar.
- **Honest empty states** (fresh block, nothing to show): "No verified
  domains on this account — add one in HYROS to enable the check" · "No
  script check result" · "No Google ad accounts connected — nothing to
  check" · "No ads reported by the check in the last hour". No state
  invents a green result.

## Also shown
Account & access — ad accounts, `managedBy` / `clients` from
`snapshot.account`, and the account's default attribution window. An ad
account that appears in `snapshot.warnings[]` (`{ adAccountId, name, type,
level, error, kind }`, kind ∈ unsupported | rate_limited | error |
truncated | time budget) gets a pill with the kind (e.g. "skipped:
unsupported") and the message as its title.

## Porting notes
Another app needs the block above; `view.js` + `style.css` reuse
unchanged. HYROS-specific: the three tools, the `{ domains }` /
`{ request: { type } }` argument guesses, and `snapshot.warnings` (core
snapshot) for the access pills.

## Open limitations
- Tools 2 and 3 have no documented contract; a captured live payload is
  the only way to confirm the shapes (until then the "unexpected reply
  shape" error is the honest outcome of a mismatch).
- `hyros_check_tracking_parameters_for_integrations` is documented as
  covering "active integrations" — the app assumes a `type` filter and
  only checks the two Google channels; other integrations are not checked.
- The demo block fakes one missing script and one ad missing `gclid`; it
  is illustrative, not a captured result.

# <Name> — feature spec

**id** `<id>` · **mode** demo | live | both · **version** 0.1.0

## Purpose
One paragraph: the question this tab answers and for whom.

## Data
- Which HYROS MCP tools the server step calls, with the request shape and
  the limits honoured (page size, time budget, max calls).
- What the demo generator fakes and how (seed, ranges used).
- **MCP limits reminder** (FEATURES.md "MCP limits"): ≤ 50 ids / emails /
  tags per call; `pageSize` ≤ 250; per-call timeouts ≤ 15 s; one rate limit
  per HYROS account, shared across every key of the account and across an
  agency's clients; `accessible_account_id` (and the API key) are already
  applied by `ctx.callTool` — never pass them yourself.

## Block shape (`snapshot.<id>`)
```json
{ "window": { "start": "YYYY-MM-DD", "end": "YYYY-MM-DD" }, "rows": [{ "name": "", "value": 0 }], "errors": [] }
```

## View states
The view renders every state the runner can hand it: fresh · stale
(`{ ...data, stale: true, skipped }` → "showing the previous result" with
`fmt.datetime`) · bare `{ skipped }` · `{ error }` · `null` / `{}`. It
never throws (`scripts/feature-check.mjs` renders all of them).

## Rules honoured
- Metrics re-derived after summing (never averaged); money via `ctx.fmt`.
- Errors land inside the block; a missing block renders an empty state.
- `server.js` checks `ctx.timeLeft()` before the first call (zero MCP calls
  on a spent budget) and strips `stale`/`skipped` from `previous` before
  reusing it.

## Porting notes
What another app must provide (the block shape above) to reuse `view.js`
and `style.css` unchanged; anything HYROS-specific in `server.js`.

## Open limitations
What is illustrative vs live, and which missing MCP capability would make
it fully live — cite the FINDINGS.md section by title (e.g. "Aggregate
clicks endpoint", "Undocumented behaviour the app relies on").

# Features — the plug-and-play contract

A **feature** is one tab of the dashboard, shipped as one folder under
`public/features/<id>/`. The core app knows nothing about individual
features: it reads `public/features/registry.js`, loads each folder, mounts
a tab and a section, runs each feature's server step during refresh, and
hands the feature a `ctx` object to render with. A feature folder can be
zipped, moved to another fork of this app (or any app that produces the
same block shape), and installed with one command.

```
public/features/<id>/
  feature.json   manifest (required)
  view.js        export render(ctx)         — the tab (required)
  demo.js        export demo(snapshot)      — the Demo account block (required unless mode: live)
  server.js      export build(ctx)          — the live data step run by /api/refresh (live/both)
  style.css      feature-scoped styles      — optional (manifest "style": true)
  SPEC.md        the portable spec          — required
```

Registry: `public/features/registry.js`
```js
export const FEATURES = ['funnel', 'adltv', 'scale', 'health'];   // tab order
```
Remove an id to unplug a feature without deleting it. Folders whose name
starts with `_` are ignored (`_template`).

## feature.json

| field | type | meaning |
|---|---|---|
| `id` | string | folder name; `^[a-z][a-z0-9-]{1,30}$`; the snapshot key (`snapshot[id]`) |
| `name` | string | human name (spec, errors) |
| `tab` | string | tab label |
| `version` | semver | bump on every change to the block shape |
| `description` | string | one sentence, shown as the tab tooltip |
| `mode` | `demo` \| `live` \| `both` | `demo`: tab only on the Demo account. `live`: only on real accounts. `both`: wherever the block exists |
| `demo` | boolean | `demo.js` present (required for `demo`/`both`) |
| `server` | boolean | `server.js` present — runs during refresh |
| `style` | boolean | `style.css` present — linked when the feature loads |
| `needs` | string[] | snapshot paths the view requires, e.g. `["ranges.30d"]`; tab hides when missing |
| `tools` | string[] | MCP tools `server.js` calls; the conformance check enforces the list |
| `author` | string | who to ask |

## The block

`snapshot[<id>]` is the feature's whole world. `server.js` produces it for
real accounts; `demo.js` produces it for the Demo account. **Same shape,
one view.** Document the shape in `SPEC.md` — that is the porting contract.

Conventions inside a block:
- `{ error: "message" }` when the step failed entirely; `errors: []` for
  partial problems; `{ skipped: "time budget" }` when there was no time.
- Dates as `YYYY-MM-DD` strings; money as plain numbers in the account
  currency; nothing pre-formatted.
- Keep it small (a few hundred rows at most). The snapshot is one JSON
  document in KV and one download per page load.

## view.js — `render(ctx)`

Called every time the tab is shown, the account/range changes, or demo mode
toggles. Must be idempotent: build the HTML and assign
`ctx.root.innerHTML`; wire events with `ctx.root.querySelectorAll` after.
Must tolerate `ctx.block === null` (render an empty state; never throw).

`ctx`:

| key | what |
|---|---|
| `root` | the feature's `<section>` |
| `snapshot` | the whole current snapshot (core + every feature block) |
| `block` | `snapshot[id]` or `null` |
| `demo` | `true` on the Demo account |
| `account`, `range`, `level` | current account id, report range key (`today`/`yesterday`/`7d`/`30d`), report level |
| `fmt` | `money(v)`, `int(v)`, `pct(v)`, `date(iso)`, `datetime(iso)` — honours the demo "no cents" rule |
| `esc(s)` | HTML-escape — use on every data string |
| `kpis(list)` | KPI tiles HTML: `[{ label, value, sub?, cls?: 'good'\|'bad' }]`; wrap in `<div class="kpis">` |
| `formatCell(col, value)` | the report's metric formatter (for catalog metrics) |
| `note(msg, isErr)` | the report-page notice bar |
| `openJourney(email)` | open the lead journey drawer for an email |
| `api(path, opts)` | password- and account-scoped fetch to this app's own `/api/*` (never HYROS) |
| `selectView(id)` | switch tabs |
| `manifest` | this feature's manifest |

Shared markup kit (already styled): `.note`, `.kpis`/`.kpi`, `.fpanel` +
`h3` + `.fhint`, `.fcols` (2-up grid), `.fshare` bars, `.pill` (`.ok`,
`.bad`, `.stage`, `.warn`), `.clip.clip-l`, `.empty`, `.sub`, `.good`/`.bad`
text. Prefix feature-specific classes with the feature id. Colors and fonts
come from the tokens in `styles.css` (`UI-STYLE-GUIDE.md`).

## demo.js — `demo(snapshot)`

Pure and deterministic: seed a generator with `rng(n)` from
`public/demo.js` (also `jitter`, `round2`, `ymd`, `daysAgo`, `pick`). Read
the demo snapshot (`snapshot.ranges['30d'].levels.campaign` …) so numbers
reconcile with the report. Return the block. Runs in the browser and in
Node (`make-seed`, `feature-check`), so no DOM and no `fetch`.

## server.js — `build(ctx)`

Runs inside `/api/refresh` after the core snapshot (account, ad accounts,
ranges, CRM) is built, for every feature with `"server": true`, in registry
order, within the function's remaining time budget. Returns the block.

`ctx`: `callTool(name, args, { timeoutMs })`, `callToolPaged(name, args,
{ maxPages, pageSize })`, `snapshot` (core), `previous` (this feature's
block from the last snapshot — use it to sync incrementally), `deadline`,
`timeLeft()` ms, `log(step)`, `env` (`HYROS_CAC_CEILING`), `now`.

Rules: check `timeLeft()` before every call; catch every error into the
block; page sizes ≤ 250; per-call timeouts ≤ 15 s; the whole refresh has
about 50 s for everything, so budget a feature at ≤ 10 s; list every tool
you call in the manifest `tools`. No Node built-ins, no packages.

Account context (which HYROS key, agency client id) is already applied to
`callTool` — a feature never sees keys.

## Lifecycle

```
registry.js ─► loadFeatures() ─► tab + <section id="view-<id>"> + style.css link
                                   │
refresh ─► core snapshot ─► runFeatureSteps(): server.js build() ─► snapshot[id] ─► KV
Demo   ─► buildDemoSnapshot() ─► applyDemoFeatures(): demo.js demo() ─► snapshot[id]
tab shown ─► featureVisible(manifest, snapshot) ─► view.js render(ctx)
```

A broken feature (bad manifest, import error, render throw) is contained:
the tab is skipped or shows an inline error, and the rest of the dashboard
is unaffected.

## SPEC.md — the portable idea

Every feature carries a spec so the idea can be re-implemented in another
fork even if the code cannot be dropped in. Sections (see `_template/SPEC.md`):
Purpose · Data (tools, limits, what the demo fakes) · Block shape (JSON) ·
Rules honoured · Porting notes · Open limitations (which missing MCP
capability from `FINDINGS.md` would make it fully live).

## Export / import

```
node scripts/feature-pack.mjs <id>              # -> dist/features/<id>-<version>.zip
node scripts/feature-pack.mjs --install x.zip   # -> public/features/<id>/ + registry, runs the check
node scripts/feature-pack.mjs --list
```
The zip is the folder, nothing else. Installing into another fork of this
app is enough; installing into a different app means implementing the
block shape from `SPEC.md` and reusing `view.js` + `style.css`.

## Conformance — `npm run check` → `scripts/feature-check.mjs`

Manifest validity · required files · exports · no imports of `app.js`/`api/`
· no external `fetch` · no `Math.random` in demo · `demo()` deterministic ·
`render()` runs against the demo snapshot and against a missing block ·
`build()` runs against a stub MCP, only calls listed tools, and honours a
spent time budget.

## Adding a feature, step by step

1. `cp -r public/features/_template public/features/<id>`; set `id`,
   `name`, `tab`, `mode`, `tools` in `feature.json`.
2. Design the block in `SPEC.md` first. Small, flat, documented.
3. `demo.js`: produce that block from the demo snapshot.
4. `view.js`: render it. Run `node scripts/devserver.mjs`, open the Demo
   account, look at the tab.
5. `server.js` (live features): produce the same block from the MCP.
   Check `FINDINGS.md` for the tools that exist and their limits.
6. Add the id to `registry.js`; `npm run check`.
7. Bump `version` whenever the block shape changes.

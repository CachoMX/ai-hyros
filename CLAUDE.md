# AI HYROS — build rules for any LLM working in this repo

You are working on a **plug-and-play HYROS dashboard**: a snapshot of a
HYROS account (built from the HYROS MCP) rendered as tabs, where every tab
beyond the two core ones is a self-contained **feature folder**. People
fork this repo, add features, and export them to other forks. Keep it that
way.

## Read order
1. `FEATURES.md` — the feature contract (folder layout, manifest, `ctx`
   APIs, lifecycle, demo rules, spec format, pack/install). **Read before
   adding or changing any tab.**
2. `UI-STYLE-GUIDE.md` — tokens, type, components. Read before any visual
   change; never invent colors or fonts.
3. `README.md` — architecture (MCP → snapshot → KV → static page), setup
   flow, files.
4. `FINDINGS.md` — what the HYROS MCP can and cannot do. Read before
   designing a live data feature; it tells you which questions are
   answerable with today's tools.
5. `public/features/scale/` and `public/features/health/` — worked examples
   of a live feature (server step + demo + view + spec);
   `public/features/funnel/` and `adltv/` — demo-only examples;
   `public/features/_template/` — the skeleton to copy.

## Hard rules
- **The browser never talks to HYROS.** Only `/api/refresh` (through a
  feature's `server.js`) calls the MCP. Views read `snapshot` only.
- **One snapshot, flat, per account.** A feature's data lives at
  `snapshot[<feature id>]`, produced by its `server.js` (live) and its
  `demo.js` (Demo account) in the SAME shape. Never write to other keys.
- **Derived metrics are re-derived after summing, never averaged.** Use
  `derive`/`aggregate` from `public/shared/metrics.js` for anything with a
  ratio (ROAS, CPL, CTR, …).
- **Money and numbers go through `ctx.fmt`.** It knows the Demo account
  hides cents.
- **Escape every string from data** with `ctx.esc` before putting it in
  HTML.
- **Features never import `app.js` or anything under `api/`.** They get
  everything through `ctx`. `scripts/feature-check.mjs` fails otherwise.
- **Never fail the refresh.** A server step catches its own errors and
  puts them inside its block (`{ error }`), checks `ctx.timeLeft()` before
  each MCP call, and stores `{ skipped: 'time budget' }` when out of time.
- **Demo is honest and deterministic.** `demo.js` uses the seeded `rng`
  from `public/demo.js`, never `Math.random`; the funnel never shows a
  >100% conversion; nothing real (no customer emails, no real revenue)
  ships in the repo — `data/seed.json` is generated from the demo.
- **No frameworks, no dependencies, no build step.** Vanilla ES modules
  served from `public/`; `api/` is plain Vercel functions with `fetch`.
- **No env vars for setup.** The first-run screen (password + HYROS key)
  is the only setup path; do not add required environment variables.
- **Every feature ships a `SPEC.md`** — that is how an idea travels to
  another fork even when the code does not.
- Do not put model identifiers (Claude, GPT, …) in commits, code or docs.

## Adding a feature (short version — details in FEATURES.md)
1. `cp -r public/features/_template public/features/<id>` and edit
   `feature.json` (id must equal the folder name).
2. Write `demo.js` first (the block shape), then `view.js`, then
   `server.js` if it is a live feature, then `SPEC.md`.
3. Add the id to `public/features/registry.js`.
4. `npm run check` (runs `scripts/feature-check.mjs`), then
   `node scripts/devserver.mjs` and look at the tab on the Demo account.
5. `node scripts/feature-pack.mjs <id>` to export a zip for other forks.

## Verify (after every change)
```
npm run check                          # metrics parity, store, FEATURE CONFORMANCE, pipeline + setup
node scripts/devserver.mjs             # http://127.0.0.1:4321  (password: dev)
DEV_SETUP_STATE=needs_setup node scripts/devserver.mjs   # first-run flow
node scripts/feature-pack.mjs --list   # registered features
```
There is no MCP in the sandbox; the pipeline test runs against
`scripts/mock-mcp.mjs`. A live feature is verified on a deployed preview by
hitting Refresh and reading the snapshot block.

## Layout
```
public/index.html, app.js, styles.css   core shell: sign-in, setup, accounts, report, CRM, drawer
public/shared/metrics.js                metric catalog + derive/aggregate/rollup (server + client)
public/shared/features.js               feature loader (browser + Node)
public/features/registry.js             which features are on, in tab order
public/features/<id>/                   one feature: feature.json view.js demo.js server.js style.css SPEC.md
public/demo.js                          the Demo account (core snapshot + shared demo helpers)
api/_snapshot.js                        core snapshot pipeline; calls api/_features.js for feature steps
api/_features.js                        runs every feature's server.js inside the refresh budget
api/_setup.js, _auth.js, _accounts.js   first-run config, password gate, multi-account registry
scripts/feature-check.mjs               feature conformance (in npm run check)
scripts/feature-pack.mjs                export / install feature zips
```

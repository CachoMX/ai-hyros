---
name: add-feature
description: Add a new dashboard tab (feature) to this AI HYROS app the plug-and-play way — feature folder, manifest, demo, view, optional server step, spec, conformance check. Use when asked to add a report, tab, analysis, chart or "feature" to the dashboard.
---

# Add a feature

Read `FEATURES.md` and `CLAUDE.md` first; look at `public/features/scale/`
(live) and `public/features/funnel/` (demo-only) as worked examples.

1. Pick an id (`^[a-z][a-z0-9-]{1,30}$`). Copy the skeleton:
   `cp -r public/features/_template public/features/<id>` and set `id`,
   `name`, `tab`, `description`, `mode`, `demo`, `server`, `style`,
   `needs`, `tools` in `feature.json`.
2. Write `SPEC.md` — purpose, data (which MCP tools, limits), block shape
   as JSON, rules, porting notes, open limitations. Check `FINDINGS.md` to
   confirm the MCP can answer the question before promising a live mode.
3. `demo.js`: produce the block from the demo snapshot with the seeded
   `rng` (never `Math.random`). Numbers must reconcile with the report.
4. `view.js`: `render(ctx)` builds HTML into `ctx.root.innerHTML` using
   the shared kit (`.note`, `.kpis` via `ctx.kpis`, `.fpanel`, `.fcols`,
   `.fshare`, `.pill`); escape every data string with `ctx.esc`; format
   numbers with `ctx.fmt`; tolerate a `null` block.
5. Live feature: `server.js` `build(ctx)` — check `ctx.timeLeft()` before
   each `ctx.callTool`, catch errors into the block, keep calls ≤ 15 s and
   the step ≤ 10 s, list the tools in the manifest.
6. `style.css` only for feature-specific classes, prefixed with the id,
   using tokens from `styles.css`.
7. Register the id in `public/features/registry.js`.
8. Verify: `npm run check` must pass (feature conformance is part of it);
   `node scripts/devserver.mjs`, sign in with `dev`, switch to the Demo
   account and look at the tab.
9. Commit the folder + registry change. Export with
   `node scripts/feature-pack.mjs <id>` if it should travel.

Never edit `public/app.js` or `api/_snapshot.js` to add a tab. If the `ctx`
API is missing something a feature needs, extend `featureCtx()` in
`app.js` once, document it in `FEATURES.md`, and keep it generic.

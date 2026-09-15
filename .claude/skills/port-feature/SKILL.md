---
name: port-feature
description: Bring a feature into this AI HYROS app from a zip or from another fork's SPEC.md, or export one for another fork. Use when asked to import, install, export, share or port a dashboard feature.
---

# Port a feature

**Import a pack (same app family):**
`node scripts/feature-pack.mjs --install <zip>` — unzips into
`public/features/<id>/`, registers the id, runs the conformance check.
Read the feature's `SPEC.md`; if its `needs` or `tools` reference something
this fork lacks (check `FINDINGS.md`), say so before enabling it.

**Export:** `node scripts/feature-pack.mjs <id>` → `dist/features/<id>-<version>.zip`.
The zip is the folder alone; nothing outside it is needed.

**Port from a spec only (code not reusable):** treat `SPEC.md` as the
requirement. Implement the block shape it documents with this app's
`server.js`/`demo.js` conventions (see `/add-feature`), reuse `view.js`
and `style.css` if they were provided, keep the `id` and `version` from
the spec, and note in the new `SPEC.md` what changed.

Always finish with `npm run check` and a look at the tab on the Demo
account via `node scripts/devserver.mjs`.

# AI HYROS

Your HYROS **Performance Report**, **CRM / Leads**, **Scale Advisor** and
**Tracking Health** as a standalone dashboard, built entirely on the HYROS MCP.
One click deploys it to your own Vercel account; the first load walks you
through a password and your HYROS API key, and a **Demo account** is always
there to explore before (or without) connecting anything.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fzssai13%2Fai-hyros&project-name=ai-hyros&repository-name=ai-hyros&stores=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22upstash%22%2C%22productSlug%22%3A%22upstash-redis%22%7D%5D)

Exploratory build: the goal is as much to map where the MCP falls short of
powering an external tracking app as it is to ship the dashboard.
**Read [`FINDINGS.md`](./FINDINGS.md) for that map.**

The UI is the HYROS product-window system (cream ground, white windows, mono
labels, serif figures, one purple accent; Sep 2026).
**Before ANY visual change, read [`UI-STYLE-GUIDE.md`](./UI-STYLE-GUIDE.md).**

---

## Set up in three minutes

1. **Deploy.** Click the button above (or import `zssai13/ai-hyros` in
   Vercel; framework preset *Other*, no build step, output `public`). The
   clone flow offers to create the free **Upstash Redis** store — accept it.
   That store is the ONLY thing the app needs from Vercel: it holds
   snapshots, settings and your encrypted API keys.
2. **Open the URL.** The first load is one screen: **paste your HYROS API
   key** (HYROS → Settings → API) and **choose the dashboard password**.
   Tick *agency key* to add every client account you have access to. The
   first snapshot builds right away. Nothing is set in Vercel — the
   password lives in your database.
3. **Optional hardening.** Two secrets were generated for you and stored in
   the database. The last setup step shows them with copy buttons: paste
   them into Vercel as `ACCOUNT_KEY_SECRET` and `CRON_SECRET`, redeploy,
   click *I added them* — the database copies are dropped once they match.
   Everything works without this step; it keeps the encryption secret out
   of the same store as the encrypted keys and signs the daily refresh.

Skipped the store? The dashboard opens on the Demo account with a
**Storage needs to be set up** guide (Vercel → Storage → Create Database →
Upstash Redis → redeploy) and a *Check again* button.

No environment variables are required, and none of them decide whether the
dashboard is set up — only the database does. The HYROS MCP endpoint
(`https://mcp.hyros.com/mcp`) is built in. A first run is a fresh start: it
wipes whatever an earlier install left in the store.

### Optional environment variables

| Variable | Effect |
|---|---|
| `ACCOUNT_KEY_SECRET` | Encrypts stored API keys. Generated on first load if absent; the setup screen helps you move it here. |
| `CRON_SECRET` | Signs the daily refresh. Generated on first load if absent. Until it is set in Vercel the cron is recognised by its user agent and limited to one run per hour. |
| `REPORT_PASSWORD` | Optional MASTER password: accepted in addition to the one created on first load (recovery if someone else reached the first-run screen first). It never blocks or replaces setup. |
| `HYROS_MCP_URL` | Override the MCP endpoint (staging, mocks). |
| `HYROS_CAC_CEILING` | Scale Advisor CAC ceiling (default 100). |
| `HYROS_ATTRIBUTION_MODEL`, `HYROS_AD_ACCOUNTS` | Snapshot defaults. |

### Setup & security (account menu)

Change the password, see where each secret lives, show the pending
secrets again, or **factory reset** — every account, snapshot, setting and
the password are deleted from the database and the dashboard returns to
first-load setup. The Vercel project and your HYROS accounts are untouched.

---

## Adding features (plug and play)

Every tab beyond Performance Report and CRM is a **feature folder** under
`public/features/<id>/` — manifest, view, demo data, optional server step,
styles and a portable `SPEC.md`. The core app discovers them from
`public/features/registry.js`; nothing else needs editing. Zip one with
`node scripts/feature-pack.mjs <id>` and install it in another fork with
`--install`. **Read [`FEATURES.md`](./FEATURES.md)** for the contract and
[`CLAUDE.md`](./CLAUDE.md) for the build rules an LLM session must follow;
`.claude/skills/add-feature` and `port-feature` drive the workflow.

## What it does

**Performance Report** — five levels (Traffic source · Account · Campaign ·
Ad Set · Ad), 103 selectable metrics, date-range chips, client-side
sort/filter/search, sticky totals, CSV export, click-through from any number
to the lead cohort behind it and on to each lead's journey.

**CRM / Leads** — the real column set (Joined on, Lead, Name, First Source,
Last Source, Last Source Date, Income, Stage, Ad O.C., Tags), sales, calls,
subscriptions, stage and attribution filters, search, CSV export.

**Scale Advisor** — marginal CAC curves per account and top ad set
(`hyros_get_marginal_cac_curve`), with the saturation point called out.

**Tracking Health** — domains, script presence per URL, Google tracking
parameters per integration.

**Accounts** — any number of HYROS accounts in one dashboard, switched from
the top-left menu. An agency key adds every approved client account (5 per
call) and the daily refresh rotates through the stalest ones.

**Demo account** — always in the account menu. Synthetic, profitable-looking
data generated in the browser with the same math as the live pipeline; also
unlocks the Funnel & Journey and Ad LTV preview tabs.

## How it works

```
Vercel Cron (daily)  ─┐
Refresh button       ─┴─►  /api/refresh  ──►  HYROS MCP  (POST /mcp, API-Key)
                                          │
                                          ├─► builds one flat snapshot per account
                                          └─► Upstash Redis
                                                   │
                          browser  ◄── /api/data ◄─┘
```

The browser never talks to HYROS. `/api/refresh` is the only MCP client, and it
speaks plain JSON-RPC over `fetch` — no SDK, no dependencies.

This works because the HYROS MCP runs Spring AI's **stateless** transport on
`/mcp` and accepts an `API-Key` header. Stateless means no session to hold
open, which is what makes a serverless function a viable MCP client at all.

### Levels

HYROS's Meta level names are display names over its own hierarchy:
**Campaign = source category**, **Ad Set = source link**. The MCP has no
campaign or traffic-source grouping, so those levels are rolled up from the
ad-set base table joined to `hyros_get_sources`. Derived metrics (ROAS, ROI,
CTR, CPM, CPL) are always **re-derived** after summing, never averaged.

## Files

```
api/_mcp.js        JSON-RPC client (stateless HTTP, JSON + SSE framing, per-account key context)
api/_snapshot.js   the pipeline: MCP calls -> levels -> CRM -> scale -> health -> one snapshot
api/_store.js      Upstash Redis via REST, fails soft
api/_setup.js      first-run config: password hash, generated secrets, hardening, factory reset
api/_auth.js       password gate (env or KV), timing-safe; cron recognition
api/_accounts.js   multi-account registry, AES-256-GCM key storage, agency client import
api/setup.js       GET state / POST set-password | change-password | harden | reset
api/accounts.js    list / add / import-clients / replace-key / remove
api/refresh.js     rebuild + persist (cron rotates accounts; on demand per account)
api/data.js        the selected account's snapshot
api/drill.js       number -> lead cohort -> journey (live)
api/health.js      prove the MCP leg without building anything
public/app.js      dashboard shell;  public/demo.js  the Demo account
public/shared/metrics.js   metric definitions + rollups (shared server & client)
public/shared/features.js  feature loader (browser + Node)
public/features/   registry.js + one folder per feature (FEATURES.md); _template/ to copy
api/_features.js   runs every feature's server.js inside the refresh budget
scripts/feature-check.mjs  feature conformance (in npm run check)
scripts/feature-pack.mjs   export / install feature zips
data/seed.json     SYNTHETIC preview snapshot for the local dev server (no customer data)
scripts/devserver.mjs   local preview on :4321 (DEV_SETUP_STATE=ready|needs_storage|needs_password)
scripts/selftest.mjs    metric parity + seed integrity
scripts/pipeline-test.mjs   the whole pipeline + accounts + setup against a mock MCP
```

## Run locally

```bash
node scripts/devserver.mjs                          # http://127.0.0.1:4321  (password: dev)
DEV_SETUP_STATE=needs_password node scripts/devserver.mjs   # walk the first-run flow
npm run check                                       # metric parity + store + pipeline + setup
```

## Verification

`npm run check` asserts the metric engine against numbers read off a **live
HYROS Performance Report** (2026-08-13→19, Traffic source, Last Click):

| Metric | HYROS UI | Formula |
|---|---:|---|
| Profit | 556,162.19 | `revenue - cost` |
| Reported vs Revenue | 559,391.77 | `revenue - reported` |
| ROI | 13,467.77% | `(revenue - cost) / cost * 100` |
| ROAS | 135.68 | `revenue / cost` |

All four match exactly. The suite also covers divide-by-zero behaviour, the
re-derive-don't-average rollup rule, seed integrity, the incremental lead
sync, agency client import, key encryption, and the whole first-run setup
(password, generated secrets, hardening, factory reset).

## Security notes

- The dashboard shows customer emails, phone numbers and revenue: pick a long
  password. `noindex, nofollow`, `X-Frame-Options: DENY`, `nosniff` and
  `strict-origin-when-cross-origin` ship in `vercel.json`. Consider Vercel
  Deployment Protection on top.
- API keys are AES-256-GCM encrypted at rest and never leave the server; the
  browser only ever sees account ids and labels.
- The first-load screen is first-come: whoever opens a fresh deployment
  first sets the password. Open your URL right after deploying. If that
  ever goes wrong, set `REPORT_PASSWORD` in Vercel as a master password,
  sign in with it and factory-reset.

# Setting up AI HYROS with Claude — context + walkthrough

*Give this file to Claude together with the app zip. It tells Claude what
you are trying to do, what the app is, where you are, and what "done" looks
like at each step. The path is always the same: **unzip → your own GitHub
repo → Vercel → storage → connect screen.** Claude drives; you do the
clicks in HYROS, GitHub and Vercel that only a human can do.*

---

## Paste this as your first message

> I was given the AI HYROS dashboard app as a zip and unzipped it into this
> folder. It is not on git yet; I want it in my own GitHub repo, deployed
> on my own Vercel account, connected to my HYROS account. Read
> `SETUP-WITH-CLAUDE.md` first, then `CLAUDE.md` and `README.md`. Walk me
> through the setup one step at a time. I am at step **___** (say "0" if
> you are starting). Before each step tell me what it does and what I will
> need to do myself; after each step verify it worked before moving on.
> Do not skip ahead.

---

## What this app is (so Claude has the picture)

- A **standalone HYROS dashboard**: Performance Report, CRM / Leads, plus
  plug-in feature tabs (Scale Advisor, Tracking Health, and demo-only
  Funnel & Journey / Ad LTV). Vanilla HTML/JS, no build step, no packages.
- It runs on **Vercel** (free Hobby plan is fine). Vercel functions in
  `api/` call the **HYROS MCP** (`https://mcp.hyros.com/mcp`, built in)
  with the user's HYROS API key, build one snapshot per account, and store
  it in a free **Upstash for Redis** database attached to the Vercel project.
  The browser only ever reads that snapshot.
- **Nothing is configured through environment variables.** The only thing
  Vercel must provide is the Upstash store. Password and HYROS key are
  entered on the app's own first-run screen.
- A **Demo account** with synthetic data is always available, even before
  anything is connected.
- Features are folders under `public/features/<id>/`; `FEATURES.md` is the
  contract and `/add-feature` is the skill. That is for later — setup first.

## What Claude can and cannot do here

- **Can**: read and explain the code, run `npm run check` and the local
  dev server, initialise git and write the commands to push, tell you
  exactly which buttons to click in GitHub/Vercel/HYROS, and verify each
  step by asking you for a URL and reading `https://<your-url>/api/setup`
  (a public JSON status: `needs_storage` → `needs_setup` → `ready`).
- **Cannot**: click inside HYROS, GitHub or Vercel, or see your API key.
  Never paste the HYROS API key or the password into the chat — they go
  into the app's setup screen only.

---

## The steps

Each step has a **Goal**, **You do**, **Claude does**, and **Done when**.
Tell Claude which step you are on; it should confirm the previous step's
"done when" before continuing.

### Step 0 — Unpack and look around
- **Goal**: Claude has the app in front of it and knows the rules.
- **You do**: unzip `ai-hyros.zip` — it contains one folder, `ai-hyros/`.
  Open that folder in Claude Code (or upload it to the chat). It is a plain
  folder, not a git checkout: there is no history and no remote yet.
- **Claude does**: reads `CLAUDE.md`, `README.md`; runs `npm run check`
  (needs Node 20+; nothing to install) and reports "all checks pass".
- **Done when**: checks pass. Optional: `node scripts/devserver.mjs`,
  open `http://127.0.0.1:4321`, password `dev`, look at the Demo account.

### Step 1 — Get the HYROS API key (and optionally connect the HYROS MCP to Claude)
- **Goal**: you hold the key the app will use.
- **You do**: in HYROS go to **Settings → API** and copy your API key.
  Keep it somewhere safe; you will paste it into the app in step 5.
  **MCP access is enabled per account by HYROS support** — it is not
  self-serve and there is nothing to switch on in the HYROS app. If you
  are not sure your account has it, ask support before step 5; a key from
  an account without it is rejected at setup with a permission hint.
  *Optional*: connect the **HYROS MCP** connector to Claude (claude.ai →
  Settings → Connectors) so Claude can sanity-check the account
  (`hyros_get_user_info`, ad accounts) — this is a convenience for
  troubleshooting, the dashboard itself does not need it.
- **Claude does**: explains what the key unlocks (read access to reports,
  leads, sales, calls), and if the connector is attached, confirms the
  account email and how many ad accounts it sees.
- **Done when**: you have the key. Agency? Note whether you will tick
  "agency key" in step 5 — it pulls in every client account you can access.

### Step 2 — Put the app in your own GitHub repo
- **Goal**: Vercel deploys from a git repo you own. The zip is the whole
  app; nothing is pulled from anyone else's repo.
- **You do**: on github.com create a new **empty** repo (private is fine),
  e.g. `<you>/ai-hyros`. Do not tick "add a README" or ".gitignore" — the
  zip already has them.
- **Claude does** (inside the unzipped `ai-hyros/` folder; needs git and a
  GitHub login on your machine — `gh auth login` or a saved credential):
  ```
  git init
  git add -A
  git commit -m "AI HYROS dashboard"
  git branch -M main
  git remote add origin https://github.com/<you>/ai-hyros.git
  git push -u origin main
  ```
  No git on the machine? Alternative: on the empty repo page click
  **"uploading an existing file"** and drag in the CONTENTS of `ai-hyros/`
  (not the folder itself). Afterwards check on GitHub that `api/`,
  `public/`, `vercel.json`, `package.json` and `.gitignore` are there; the
  web uploader sometimes drops dot-files, and `.claude/` (Claude skills)
  is optional.
- **Done when**: the repo on GitHub shows `api/`, `public/` and
  `vercel.json` at the top level (not inside an extra folder).

### Step 3 — Deploy to Vercel
- **Goal**: the app is live at a `*.vercel.app` URL.
- **You do**: vercel.com → **Add New → Project** → **Import** the GitHub
  repo you just created (connect your GitHub account to Vercel if asked).
  Settings: Framework preset **Other**, leave Build Command empty, Output
  Directory **`public`**, Root Directory `./`. No environment variables.
  Click **Deploy**.
- **Claude does**: waits for your URL, then reads
  `https://<url>/api/setup`. It expects `"state":"needs_storage"` — the
  store is added next.
- **Done when**: the URL loads and shows the Demo dashboard under a
  "Storage needs to be set up" card. That is correct; go to step 4.

### Step 4 — Set up storage (Upstash for Redis)
- **Goal**: the app has a database for snapshots, keys and the password.
- **You do**: Vercel → the project → **Storage** tab → **Create Database**
  → **Upstash for Redis** (Marketplace, free plan) → Continue → connect
  to this project for **all environments**. Vercel adds the connection
  variables itself (`KV_REST_API_*` or `UPSTASH_REDIS_REST_*`); you never
  type any. **It must be Upstash for Redis**: the marketplace also lists a
  product called just "Redis" (Redis Cloud, `REDIS_URL`), which the app
  does not speak. Then **Deployments → latest → ⋯ → Redeploy** (required —
  functions read variables only at deploy time).
- **Claude does**: after the redeploy, reads `/api/setup` again and
  expects `"storage":true` and `"state":"needs_setup"`. If it still says
  `needs_storage`, the redeploy was skipped or the store is connected to a
  different environment — Claude tells you which to check.
- **Done when**: the app opens on "Connect your HYROS account" (or you
  click **Check again** on the storage screen and it advances).

### Step 5 — Enter the API key and choose the password
- **Goal**: the dashboard is yours.
- **You do**: on the app's connect screen, paste the HYROS API key, tick
  "agency key" if it is one, type a password twice, click **Connect &
  build my dashboard**. The key is checked with HYROS first (a bad key
  changes nothing), then everything is stored and the first snapshot
  builds — usually a minute or two, up to 5 minutes on a large account.
- **Claude does**: reads `/api/setup` and expects `"state":"ready"` (the
  account count is only returned once signed in with the password, in the
  `x-report-key` header). Asks you whether the report shows your ad
  accounts and the badge reads **Live**.
- **Done when**: you see your own numbers. Do this promptly after the
  deploy: the connect screen is first-come.

### Step 6 — Optional: lock it down, add accounts
- **Hardening** (optional): the last setup screen shows two generated
  secrets with copy buttons. Vercel → Settings → Environment Variables →
  add `ACCOUNT_KEY_SECRET` and `CRON_SECRET` with those values → Redeploy
  → click **I added them**. Claude expects `"pendingSecrets":false`
  afterwards. Everything works without this step.
- **More accounts**: account menu (top left) → **+ Add account**.
- **Daily refresh**: automatic (Vercel cron). Without `CRON_SECRET` it is
  limited to once per hour; with it, signed.
- **Start over**: account menu → Setup & security → type `RESET`.

### Step 7 — Next: build on it
- Ask Claude to read `FEATURES.md` and use `/add-feature`. Every tab is a
  folder under `public/features/<id>/`; `npm run check` enforces the
  contract; `node scripts/feature-pack.mjs <id>` exports a feature for
  another fork.

---

## Where I am (fill in and keep updated)

```
Step:            ___
App URL:         https://________________.vercel.app
GitHub repo:     https://github.com/________/ai-hyros
Agency key?:     yes / no
Last /api/setup: { state: "________" }
Blocked on:      ________________________________
```

## If something goes wrong

| Symptom | Likely cause | What Claude should do |
|---|---|---|
| `/api/setup` returns 404 | functions not deployed — usually the repo has an extra top-level folder (`ai-hyros/ai-hyros/…`) | either move the files up on GitHub, or set Vercel → Settings → General → Root Directory to that folder; redeploy |
| still `needs_storage` after adding the store | no redeploy, or store connected to another project/env | Storage → database → Projects; redeploy |
| "HYROS rejected that key" | key mistyped or copied from the wrong account | copy again from HYROS Settings → API; nothing was stored |
| "the key is valid but MCP access is not enabled" (permission error) | MCP access is granted per account by HYROS support | ask HYROS support to enable MCP on the account, then retry; nothing was stored |
| first build times out | very large account | press Refresh again; the lead sync is incremental and every refresh keeps what the previous one fetched |
| sign-in screen instead of connect screen on a fresh deploy | an older deployment already set a password in this store | Setup & security → RESET (or `REPORT_PASSWORD` in Vercel as a master password if locked out) |

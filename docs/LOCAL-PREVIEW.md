# Local Preview and Validation

Run commands from the repository root. Use Node 20.6+ for the live preview's `--env-file` option. Public repository: [CachoMX/ai-hyros](https://github.com/CachoMX/ai-hyros).

## Synthetic Rehearsal

No HYROS credential, KV store, or LLM provider is required:

```powershell
node scripts/devserver.mjs
```

Open `http://127.0.0.1:4321` and choose Demo without signing in. This development server uses synthetic data and API stubs; its connected-looking account states are not evidence of a live HYROS connection. Keep it for local rehearsal. Follow the English [five-minute talk track](CONTEST-DEMO.md#five-minute-presenter-talk-track).

## Read-Only Live Preview

Provide your HYROS credential through the default server-side variable `HYROS_API_KEY` in the ignored `.env.development.local` file. Do not put its value in documentation, screenshots, browser storage, or committed files. The npm script requires that environment file to exist.

```powershell
$previewPassword = Read-Host 'Local preview password' -AsSecureString
$env:PREVIEW_PASSWORD = [System.Net.NetworkCredential]::new('', $previewPassword).Password
$env:PORT = '4322'
npm run preview:live
```

`HYROS_API_KEY` is the default key variable. Optionally set `PREVIEW_HYROS_KEY` to another configured variable's **name**, not its credential value. `PREVIEW_ACCOUNT_LABEL` optionally changes the display label; its default is `Local account`. Use a generic label for shared material. The password prompt above masks input and keeps password values out of the documented commands.

Open `http://127.0.0.1:4322` and sign in with `PREVIEW_PASSWORD`. The server listens on loopback only and keeps the HYROS key server-side. If the port is occupied, choose another `PORT` and use the same address for `PREVIEW_URL` in tests. Do not expose this preview directly to the Internet.

- The first authenticated load can build a snapshot; Refresh rebuilds it through read-only MCP requests. Wait for completion and inspect the timestamp and coverage before presenting it as live evidence.
- Snapshots and report preferences stay in process memory. The preview does not write KV and loses that state when restarted. `persisted: false` is expected here.
- Account creation and record-level drill are disabled. Conversion evidence remains available in Attribution Lab.
- Demo remains available without signing in and uses separate synthetic data. Starting this live-preview process still requires a configured key, even if only Demo is opened.
- Margin settings, decisions, and inbox read marks are scoped to this browser and account. They can survive a server restart through browser storage; they are not shared server state.
- Generative-provider capability is disabled in this preview adapter. Copilot uses deterministic snapshot rules, including when provider variables exist elsewhere.

Use Demo for public recordings. Real account labels, aggregate counts, spend, revenue, and exports remain private even when contact details are hidden.

## Verification

Install test dependencies and run the local suites:

```powershell
npm ci
npx playwright install chromium
npm test
```

`npm test` runs the 16-suite check runner with local fixtures and doubles. It requires no HYROS credential and does not establish live-provider or production-webhook behavior.

With the synthetic server running on port 4321, use a second terminal:

```powershell
$env:PREVIEW_URL = 'http://127.0.0.1:4321'
npm run test:browser
```

This command checks Demo at desktop/mobile sizes and runs the intercepted account-response regression. Demo screenshots go to `shots/`, which is ignored by git. The browser scripts default to port 4322 if `PREVIEW_URL` is omitted, so set it explicitly for the synthetic server.

For live validation, keep the read-only live preview running and use a second terminal with the same password and port:

```powershell
$env:PREVIEW_URL = 'http://127.0.0.1:4322'
$previewPassword = Read-Host 'Local preview password' -AsSecureString
$env:PREVIEW_PASSWORD = [System.Net.NetworkCredential]::new('', $previewPassword).Password
npm run test:browser:live
```

The live browser test signs in to the preview and checks its real snapshot, including Portfolio-to-War-Room navigation. If no snapshot exists, the app can initiate the initial read-only MCP refresh. This test does not create sales or modify advertisements. A pass records the displayed coverage; it does not turn partial data into complete data.

The [validation record](VALIDATION.md) preserves the prior 16-suite and 52-view-check results. Re-run for the current candidate and record fresh outcomes, failures, or unavailable checks separately. Keep logs and live snapshots out of public evidence.

## Optional Deployment Configuration

- [Copilot](COPILOT.md) documents the optional generative provider and per-question opt-in. The deployed handler needs complete configuration; this preview adapter remains on local rules.
- [Webhooks](WEBHOOKS.md) documents the signed receiver, storage, subscriptions, and refresh markers. Local preview does not register subscriptions or validate production delivery.
- Starting a preview changes neither the deployed cron schedule nor production storage. Webhook receipt marks an account for a later eligible refresh; it is not an immediate snapshot rebuild.

# Changelog

All notable changes to the AI HYROS dashboard template are recorded here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project uses [Semantic Versioning](https://semver.org/).

## [0.2.0] — 2026-09-15

Audit release: every MCP call site checked against the September 2026
HYROS docs (REST API v1.42, MCP v1.0, Webhooks v1.2).

### Added
- `templateVersion` in every snapshot, in `/api/health` and in Setup &
  security; `/api/health` also lists `missingTools` (tools the account's
  `tools/list` lacks).
- `snapshot.warnings[]` with kinds `unsupported`, `rate_limited`, `error`,
  `truncated` and `time budget`; `crm.sync.truncated`, `crm.sync.stale`,
  `sourcesTruncated` and `ranges[key].skipped` mark partial data.
- "Copy diagnostics" button and "Report a problem" link in Setup &
  security.
- Structured JSON event lines (`logEvent`) in the Vercel runtime logs for
  refresh, setup and MCP failures; no keys, no personal data.
- CRM-only accounts (no reportable ad account) build with an empty report
  and a warning instead of failing.
- GitHub Actions workflow running `npm run check` on push and pull request;
  `npm test` as an alias of `npm run check`.
- `CHANGELOG.md`; README sections *Before you start*, *Limits*, *Getting
  updates*, *Diagnostics & support* and *Licence*.

### Changed
- The refresh is budgeted for Vercel Fluid compute: `/api/refresh` runs
  up to **300 s** (`maxDuration` in `api/refresh.js` and `vercel.json`)
  and a build spends up to 290 s, so a large account can take up to 5
  minutes to refresh. Every share derives from `REFRESH_MAX_S` in
  `api/_budget.js`; the daily cron gives each account up to 120 s and
  keeps refreshing the stalest accounts until the run budget is spent.
  Hobby projects without Fluid compute must lower `maxDuration` to 60 in
  `vercel.json` (one line) and `REFRESH_MAX_S` to match.
- Attribution levels follow the documented per-platform enum (classic
  Google `google_campaign` / `google_ad`, Google V2 `google_v2_adgroup`,
  Snapchat `snapchat_adsquad` / `snapchat_ad`, LinkedIn
  `linkedin_campaign`, Twitter `twitter_adgroup`, …); ad-account types
  with no level (REDDIT, APPLOVIN, WHOP_ADS) are skipped with a warning
  instead of failing the account.
- Per-account failures are isolated: one bad ad account no longer fails
  the whole refresh.
- Feature server steps get a fair share of the remaining refresh budget;
  a skipped step keeps the previous block and marks it `stale`.
- Attribution rows, sources and CRM lists are paginated within the refresh
  budget; the CRM shows "1,000+" when a list hit its cap.
- HTTP 429 backs off using `Retry-After` and retries inside the deadline;
  a rate-limited account is never marked as failed.
- HTTP 403 is `forbidden`, not an invalid key; only 401 marks a key
  invalid (agency keys are no longer locked out by one client).
- Incremental lead sync runs whenever the previous window overlaps the new
  one, so the daily cron is incremental too.
- IANA timezones (`America/New_York`) are understood; every date parameter
  is sent as an ISO datetime with the account's offset.
- Legacy `EEE MMM dd HH:mm:ss zzz yyyy` dates on sales, calls and
  subscriptions are parsed instead of showing "—".
- `leadStage` report settings are validated against `hyros_get_stages`
  when saved; unknown names are dropped with a warning.
- Scale Advisor parses the documented curve shape (`spendPerDay`,
  `newCustomers`, `avgCac`, `marginalCac`, `saturationPoint`,
  `ceilingBasis: CALLER_PROVIDED | LTV_BREAKEVEN`) and shows the live
  tool's HTTP 404 as an explicit error state. `HYROS_CAC_CEILING` is
  optional with no default (LTV break-even is used when absent).
- Tracking Health shows honest empty states when a check returned nothing.
- The feature template view and the conformance check handle `{ skipped }`,
  `{ error }` and stale blocks.
- Unauthenticated `GET /api/setup` returns only `state`, `storage` and
  `pendingSecrets`.
- `scripts/feature-pack.mjs` is pure Node (no `zip`, `unzip`, `cp`, `ls`)
  and runs on Windows.
- `FINDINGS.md` rewritten against the September docs: webhooks, reports
  `groupBy`/`sorting`, rate limits and caps, auth status, level enum,
  legacy dates, the CAC curve 404, undocumented fields the app relies on,
  and the updated asks for the API team. `CLAUDE.md` and the skills point
  at it and at <https://api-docs.hyros.com/llms.txt>.
- README: dev-server states, Upstash for Redis (not "Redis" / Redis
  Cloud), MCP enabled per account by HYROS support, `noindex` is a meta
  tag, generic import instructions for the beta.

### Fixed
- Malformed `vercel.json`.
- Stray `@upstash/redis` dependency removed (the app has none).
- `.vercelignore` comment (the seed is read by the dev server and the
  self-test, never by `api/data.js`); `.github`, `.claude` and scratch
  files are excluded from the deployment bundle.

## [0.1.0] — 2026-09-14

### Added
- Initial template: Performance Report (five levels, 103 metrics), CRM /
  Leads, Scale Advisor, Tracking Health, multi-account with agency import,
  Demo account, first-run setup (password + HYROS key), Upstash for Redis
  storage, daily cron, plug-and-play feature folders with pack/install,
  `npm run check` (metric parity, store, feature conformance, pipeline
  against a mock MCP).

[0.2.0]: ./CHANGELOG.md#020--2026-09-15
[0.1.0]: ./CHANGELOG.md#010--2026-09-14

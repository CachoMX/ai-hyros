# Release Validation

## Release Candidate Recheck

On 2026-09-23 the release candidate passed `npm test` (all 16 suites), `npm run test:browser` (26 synthetic view checks plus the account-switch regression), and `npm run test:browser:live` (26 local live-snapshot view checks). No page errors were reported. A scan of publishable files found no matching locally available secret values. Production's public setup endpoint reported ready, with storage configured and no pending generated secrets. These checks do not certify authenticated production workflows or a live LLM/webhook integration.

## Previously Recorded Results

Recorded on 2026-09-23 in local Windows, Node 26, and Chromium through Playwright. These are prior logged results, not a fresh run against every subsequent edit or evidence of a production deployment. Re-run the commands in [Local Preview](LOCAL-PREVIEW.md#verification) for the release candidate.

| Check | Recorded result | Evidence boundary |
| --- | --- | --- |
| `npm test` | **16 suites passed.** | Local tests and fixtures; runner: [check.mjs](../scripts/check.mjs). This does not mean 16 live integrations. |
| `npm run test:browser` | 13 views at 1440x1000 and 390x844: **26 view checks** passed, without page errors or global horizontal overflow. | Synthetic Demo; [browser-test.mjs](../scripts/browser-test.mjs). |
| Account-switch regression | A delayed account response did not overwrite the newly selected account, snapshot, selector, or persisted selection. | Intercepted responses; [browser-race-test.mjs](../scripts/browser-race-test.mjs). Separate from the view-check count. |
| `npm run test:browser:live` | The same 13 views at both sizes: **26 view checks** passed, including Portfolio-to-War-Room navigation. | Previously fetched live snapshot; [browser-live-test.mjs](../scripts/browser-live-test.mjs). No claim of complete business-data coverage. |

The two browser runs total **52 view checks**. They check rendering and selected interactions, not every feature state or external integration. Previously exercised controls include model comparison, evidence expansion and export, profit settings, diagnostic workflows, filters, local CAC scenarios, decision status and journal, period selection, and Copilot questions, fallback, and export. Demo screenshots were visually inspected. Screenshots in `shots/` and test logs are ignored by git.

## Observed Live States

The prior local run used a server-side HYROS credential without printing it, changing the main credential, or writing snapshots to KV. Public evidence records states only; private account names, key aliases, business metrics, and aggregate sample counts are omitted.

| Area | Previously observed state | Interpretation |
| --- | --- | --- |
| Snapshot | Standard report periods, CRM, and registered feature blocks built. | Local in-memory result, not production persistence. |
| Attribution | Conversion paths available; sample partial and truncated. | A bounded sample, not the full account report or a random sample. |
| Scale | Curves available for some entities; other entities lacked points. | No points are invented for missing, failed, or insufficient results. |
| Tracking | Domain and script checks completed; tracking-parameter query returned empty. | Empty is not proof that every advertisement has correct tracking. |
| Coverage | Unsupported reporting-level and CRM truncation warnings remained visible. | These limitations are part of the result, not hidden validation failures. |
| Brief history | No live comparison baseline was established. | Comparison rules and the 14-entry bound were tested with controlled fixtures. |

## Evidence Acceptance Checklist

Use this checklist during the release rehearsal. An unchecked item is pending; mark a check only after observing it or linking a passing test. Record the candidate revision, command result, and evidence type (synthetic, fixture, or observed live) without attaching private snapshots.

- [ ] **Presentation:** the entire contest talk track is English; the public recording stays in Demo and identifies its figures as synthetic. Capture period, currency, model, timestamp, and coverage where available.
- [ ] **War Room:** expand Evidence, follow Review, set monitoring, and save a generic owner, hypothesis, and review date. Confirm the saved journal stays in the same browser/account and performs no campaign mutation.
- [ ] **Attribution:** compare models on one unchanged SALE sample, expand a conversion's credit/exclusions, and show CALL separately. Confirm known revenue is conserved across attributed and unattributed credit, unknown amounts remain disclosed, and the native report is labeled separately. Check [attribution-test.mjs](../scripts/attribution-test.mjs).
- [ ] **Journey and LTV:** label demo paths/curves illustrative. For live or controlled fixtures, inspect opening/closing roles, explicit repeat flags, and unknown or immature cohorts. Keep native LTV separate from observed cohorts and CRM activity counts. Check [journey-analytics-test.mjs](../scripts/journey-analytics-test.mjs).
- [ ] **Profit:** start with an unconfigured margin and show unknown profit. Save explicit cost/refund assumptions in Demo, inspect row evidence, and verify exported settings. Missing costs/revenue stay unknown; rebills and refunds are not counted twice. Check [economics-test.mjs](../scripts/economics-test.mjs).
- [ ] **Creative:** expand a group to its actual ad rows, verify the configured naming dimensions and concentration thresholds, and show unavailable comparisons when no eligible prior period exists. Names are not media verification and concentration is not statistical significance.
- [ ] **Tracking:** walk through an issue's correction checklist and export its note. Demo recheck is disabled. For live or fixture verification, require a fresh positive result before claiming repair; empty, failed, skipped, and previous states stay distinct. Check [diagnostics-test.mjs](../scripts/diagnostics-test.mjs).
- [ ] **Scale:** change and reset the local comparison ceiling, select a bucket, and inspect its days/customers/CAC evidence. Preserve provider ceiling, model, coverage, and missing-point notices. Describe observed history, with no projected customers or promised budget outcome.
- [ ] **Portfolio:** verify separate totals by currency and visible stale/partial states. In live validation, open an eligible account into its War Room and run the account-switch regression. Synthetic portfolio rows do not open real accounts.
- [ ] **Daily Brief:** inspect an alert, change a read mark, and open History. Comparisons require compatible snapshots of the same window; no baseline means no claimed change. Read does not mean resolved. Check [brief-test.mjs](../scripts/brief-test.mjs).
- [ ] **Copilot:** ask Review priorities, open a cited source, and try an unsupported question. Confirm the engine is disclosed, unsupported answers stay unverified, and the transcript exports. Demo/local preview use snapshot rules; provider mocks do not certify a live LLM. Check [copilot-test.mjs](../scripts/copilot-test.mjs).
- [ ] **Exports and disclosure:** export War Room evidence in Redacted mode and review its context, findings, and limitations. Publish synthetic artifacts only; redacted live packs still contain private business metrics. State that webhook subscriptions, external delivery, and campaign actions were not demonstrated.
- [ ] **Release checks:** re-run the 16-suite runner and both browser commands for the candidate. Record each outcome separately, including the 26 synthetic and 26 live view checks and any skipped or unavailable checks. Do not carry forward a prior pass as a current result.

## Not Verified or Enabled

- No production deployment or storage migration was verified by the recorded local run.
- Webhook signatures, deduplication, and refresh-marker handling were tested with doubles. No external subscription or production Redis integration was verified. Receiver code alone does not enable instant synchronization; see [Webhooks](WEBHOOKS.md).
- Generative-provider transport, limits, citations, and fallback were tested with mocked responses. No billable provider call was made in the recorded validation. Local live preview reports the provider as unconfigured; see [Copilot](COPILOT.md).
- Email/Slack delivery, real ad media, and budget/campaign mutations require additional authorized connectors.
- Browser-local settings and decisions are not shared collaboration. Local preview loses snapshots on restart; fixture history does not establish a live longitudinal record.

These checks establish implementation behavior within the stated coverage. They do not establish commercial impact, causal improvement, future profit, or an award outcome. The presenter route and optional MCP prompts are in [Contest Demo](CONTEST-DEMO.md).

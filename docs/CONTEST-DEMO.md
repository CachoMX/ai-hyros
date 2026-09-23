# Mosaide x HYROS: Demo Walkthrough

Public repository: [CachoMX/ai-hyros](https://github.com/CachoMX/ai-hyros).

## Before Recording

- Start with [Local Preview](LOCAL-PREVIEW.md), choose Demo, and select the 30-day period. Use a fresh browser profile so saved decisions and margin settings do not change the opening state.
- Rehearse one finding, one conversion, and one creative group. Keep a generic decision owner, hypothesis, and review date ready. Use clearly labeled illustrative cost assumptions only in Demo.
- Keep the Demo indicator, period, currency, model, and coverage visible. Demo figures are synthetic; a conversion-path sample is separate from the full report.
- Use Demo for public screenshots and exports. Redaction removes some identifiers but retains business metrics. Never publish private account names, sample counts, revenue, spend, customer records, private URLs, or credentials.
- Check the [acceptance checklist](VALIDATION.md#evidence-acceptance-checklist). Confirm contest requirements independently before submission; this document asserts no contest schedule or award outcome.

## Five-Minute Presenter Talk Track

The timed route stays in Demo throughout. Quotes are suggested spoken lines; actions use existing controls. A missing value or unavailable control is part of the evidence, not a reason to invent a result.

| Time | Show and do | Say |
| --- | --- | --- |
| 0:00-0:40 | **War Room:** expand one finding's Evidence, use Review, and return. Set it to monitoring; save a generic owner, hypothesis, and review date in Decision journal. | "This is Mosaide x HYROS. All figures in this recording are synthetic. We start with a review priority, its evidence, and a recorded decision. Saving a decision changes this browser's journal; it does not change an advertising campaign." |
| 0:40-1:30 | **Attribution Lab:** compare first-touch and last-touch on the same SALE cohort; switch to linear. Expand one conversion, point to unattributed credit, then switch to CALL. | "The cohort stays fixed while credit changes. Unattributed revenue remains visible, and calls stay separate from sales. The native report is a separate reference. Scientific is not reproduced by these local models, and attribution credit does not establish causality." |
| 1:30-2:00 | **Funnel & Journey / Ad LTV:** show a demo path and an illustrative LTV row. | "These demo journeys and LTV curves are illustrations. Live views distinguish observed opening and closing touches, repeat-purchase flags, and native LTV. Missing purchase history leaves mature cohort values unknown. CRM period counts are not a verified lead-to-sale funnel." |
| 2:00-2:45 | **Profit:** show unknown profit before configuration, then save the rehearsed margin and refund treatment. **Creative:** expand a group to its individual ad rows. | "Revenue is not net profit. Profit needs explicit costs and refund assumptions; these inputs are illustrative. Creative groups expose the underlying ads and their revenue shares. Names do not verify image or video content, and concentration does not prove creative quality." |
| 2:45-3:25 | **Tracking Health:** open an issue, Review correction, then Continue to recheck. Show the disabled Demo recheck and export a remediation note. | "The checklist proposes a correction. Demo cannot run a live recheck. In a connected account, a fresh positive result is required to verify a repair; checking a box or losing a row is not proof. Empty, failed, skipped, and previous checks stay distinct." |
| 3:25-3:55 | **Scale Advisor:** change the local comparison ceiling, select an observed bucket, and reset. Point to its sample details and provider ceiling. | "This compares CAC against a threshold within the shown sample. Here the sample is synthetic. Live curves describe observed history; they do not predict the result of a budget increase. This control makes no campaign changes." |
| 3:55-4:25 | **Portfolio:** inspect status, dates, and separate currency totals. **Daily Brief:** open an alert and History. | "Portfolio shows snapshot coverage across accounts without adding currencies together. Brief history is bounded. Eligible comparisons describe revisions to the same reporting window, not growth between periods. Read marks are local; email and Slack delivery are unavailable." |
| 4:25-5:00 | **Copilot:** select Review priorities and open a cited source. Return to War Room; choose Redacted and Export evidence. | "This answer uses snapshot rules, not a configured LLM. Demo never calls a provider. We finish with a reproducible evidence pack: context, calculations, findings, and limitations. No campaign action, measured business improvement, or instant webhook synchronization is demonstrated." |

## Evidence Boundaries

- **Synthetic demo:** proves the interaction flow with fixtures. Funnel and Ad LTV retain illustrative demo layouts; they are not recordings of live cohort analysis. Demo portfolio rows do not switch to real accounts.
- **Observed live:** prior read-only validation exercised real snapshots with partial coverage. It is documented in [Validation](VALIDATION.md#observed-live-states); no private metrics are needed in public material. In an authorized private session, show the snapshot timestamp and coverage before describing a value as observed.
- **Missing margins or history:** keep unknown values visible. Margin-based profit requires a configured margin and applicable refund inputs; native-cost mode requires its own complete inputs. Neither observed revenue nor native LTV establishes complete net profit.
- **Unconfigured LLM:** the default is deterministic snapshot rules. The local live-preview adapter also disables provider use. Deployment configuration and per-question opt-in are described in [Copilot](COPILOT.md); a mocked transport test is not a live provider call.
- **Unconfigured webhooks:** receiver and refresh integration exist, but need deployment secrets, writable storage, and a registered subscription. Signed events mark an account for a later eligible refresh; receipt does not itself rebuild a snapshot. See [Webhooks](WEBHOOKS.md).

## Reproducible MCP Workflow

These are optional prompts for a separate, authorized client connected to the official HYROS MCP. They are not actions performed by the five-minute Demo. Keep outputs private until reviewed; request parameters, coverage, and errors without credentials or customer details. All queries are read-only.

### 1. Inventory and Limits

> Use tools/list and hyros_get_user_info to verify access. Do not print keys or the full profile. Summarize only the timezone, currency, and available tools. Discover advertising accounts with hyros_get_ad_accounts and explicitly report pagination. Do not perform writes.

### 2. Controlled Comparison

> Using hyros_get_conversion_paths, query SALE and CALL separately over the same 30-day interval. Start with pageSize 100, at most two pages per type, and a 15-second timeout. Preserve complete paths, flag truncation, and exclude post-conversion or disregarded touches. Compare first, last, and linear attribution while conserving known SALE revenue across attributed credit and the unattributed group. Disclose unknown amounts. Do not equate this sample with the full report or a causal experiment.

### 3. Investigate a Decision

> For a candidate source, show available spend, total revenue including rebills, conversion count, observed conversion lag, and coverage. Keep report totals and conversion-path samples separate. Explain what changes under another model. State when margin data or sufficiently mature history is missing. Propose a review with evidence, not an automatic budget change.

### 4. Tracking Audit

> Use hyros_get_domains, hyros_assert_tracking_scripts, and hyros_get_tracking_param_errors according to tool availability. Distinguish successful, empty, failed, skipped, and previous checks. Prepare a correction checklist. Do not use tools that save configuration or create rules without approval.

### 5. Deliverable

> Produce a report covering the window, currency, model, queries, sample coverage, limitations, calculations, evidence, recommendation, and review criteria. Redact names, emails, private URLs, and IDs. For public material, replace private business metrics and sample counts with validation states or explicitly synthetic examples. Do not claim sales improvements or savings that have not been measured after a real action.

## Technical Feedback for HYROS

- Distinguish `revenue` from `totalRevenue`: rebills affect ROAS and profit after ad spend.
- Expose pagination by conversion type and complete-history metadata for cohorts.
- Clarify reporting capabilities by platform; a connected integration does not guarantee every reporting level.
- Separate tools that retrieve a script from those that also save configuration.
- Provide verifiable webhook examples for signatures, retries, and deduplication.
- Preserve the difference between an empty result, a timeout, and a successful check.

## Operational Limits

- Local preview snapshots and report preferences last only until the process restarts. The production storage path uses KV; prior local validation does not verify a production deployment.
- Margin settings, decision journals, and inbox read marks belong to this browser and account. They are not shared multi-user state.
- Daily Brief keeps at most 14 refresh summaries, not a complete historical archive or financial audit trail.
- Email/Slack delivery, real ad media, and Meta/Google campaign mutations require additional authorized connectors.
- The demonstrated outcome is an inspectable decision and its evidence. It is not proof of causal lift, future profitability, or a contest result.

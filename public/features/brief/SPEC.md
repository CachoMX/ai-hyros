# Daily Brief

**id** brief / **mode** both / **version** 1.0.0

## Purpose
A read-only daily brief, account alert inbox, and compact refresh history.
The brief always describes the stored **7-day** report window, printed above
the metrics, independently of the report tab's selected range.

## Data
No tools or external requests. server.build(ctx) reads the fresh core and
upstream feature blocks from ctx.snapshot. ctx.previous is the previous
**brief block**, never the previous full snapshot. The source generatedAt is
preferred; a valid Date, ISO string, or epoch ctx.now is the fallback.
An unavailable timestamp returns an error instead of inventing a time.

Revenue comes only from totals.totalRevenue, including rebills. Unknown
revenue stays null even when initial revenue is present. No CRM rows, site
URLs, campaign names, emails, raw errors, credentials, or pagination cursor
values enter the stored brief. Entity-based tracking findings use opaque
stable IDs. The JSON export rebuilds every record from a whitelist.

## Block Shape
~~~json
{
  "version": 1,
  "checkedAt": "2026-09-23T12:00:00.000Z",
  "current": {
    "id": "snapshot-12345678",
    "generatedAt": "2026-09-23T12:00:00.000Z",
    "range": "7d",
    "window": { "start": "2026-09-17", "end": "2026-09-23" },
    "currency": "USD",
    "model": "LAST_CLICK",
    "contextKey": "12345678",
    "totalRevenue": 2000,
    "cost": 500,
    "calls": 40,
    "sales": 30,
    "coverage": {
      "report": "complete",
      "tracking": "complete",
      "crm": "complete",
      "attribution": "complete",
      "warningCount": 0,
      "unknownMetrics": [],
      "pagination": {
        "report": { "truncated": false, "cursorPresent": false, "pages": null, "sampled": null, "total": null }
      }
    }
  },
  "history": [],
  "comparison": {
    "comparable": false,
    "reason": "first_snapshot",
    "previousId": null,
    "previousGeneratedAt": null,
    "changes": null
  },
  "alerts": [],
  "alertCount": 0,
  "alertsTruncated": false,
  "newIssues": 0,
  "delivery": { "inApp": true, "email": false, "slack": false, "configured": false }
}
~~~
History includes the current summary and at most 13 earlier summaries, newest
first. Repeated builds at the same timestamp replace the current entry rather
than appending duplicates. Older out-of-order inputs preserve the previous
brief with a stale marker. History entries contain only the summary shape,
not recursive briefs. The view and export derive each entry's comparison
metadata against its next retained predecessor. The oldest retained entry has
no baseline. This is refresh history, not a permanent archive.

Coverage statuses are complete, partial, missing, stale, skipped, or error.
Pagination metadata has the same compact shape for report, tracking, CRM,
and attribution; cursor presence is a boolean, never the cursor value.
Each alert has id, rule, severity, numeric evidence, an opaque evidenceKey,
firstSeenAt, lastSeenAt, readToken, and change. Fixed titles, messages, and
review destinations come from RULES. At most 40 alerts are kept and truncation
is explicit. Maximum-sized fixtures remain below 200 KB.

## Comparisons
Differences require identical window start/end, currency, attribution model,
and report-setting context, complete reports, and ordered timestamps.
Different rolling 7-day windows are **not comparable**. Eligible changes are
same-window snapshot revisions, not period-over-period business performance.
Null values and zero baselines never produce invented percentage changes.
CRM or attribution sampling caveats do not by themselves invalidate complete
report totals; their own coverage alerts remain visible.

## Alert Rules
- Missing, skipped, stale, errored, or partial report/tracking coverage.
- Explicit fresh missing-script and invalid-parameter diagnostics. A stale
  check does not establish a new tracking defect.
- Incomplete CRM pagination and incomplete attribution samples.
- Revenue below spend: complete report, known currency/model, at least
  10 sales and 100 account-currency units of ad spend.
- Revenue revised down: comparable complete snapshots, at least 10 sales
  and 100 spend in both, baseline revenue at least 500, and a decrease of
  at least 20 percent and 100 account-currency units.

Thresholds are fixed, visible in finding evidence, and apply to observed
attribution. Revenue minus ad spend is not a profit estimate. No campaign
or tracking changes are executed.

An unseen issue is marked new only after a completed baseline for its scope
and an untruncated prior alert list. Otherwise it is merely observed.
An ongoing issue keeps its first-seen time and stable ID. Changed evidence
or recurrence changes its read token. Disappearance is not proof of resolution.

## View States
Fresh, previous/stale, bare skipped, error, null, and empty blocks render on
minimal fake DOM roots. The view never calls an API or initiates delivery.
Demo blocks are used only in demo context. Demo data is deterministic, has
four same-window snapshots and explicit demo labeling, and derives metrics
from the demo snapshot where present.

Read marks are stored in browser localStorage under the account ID, with
a separate demo namespace. At most 400 read tokens are retained per account.
Storage denial is reported in-app without changing server state. A read mark
does not mean resolved. Filters combine severity and read state; history
shows timestamps, context, metrics, coverage, and comparison metadata.

The export button downloads sanitized JSON containing summary history,
alert metadata, and demo status. It excludes local read marks and account IDs.
Email and Slack delivery are explicitly not configured. No subscriptions,
sends, background polling, or external delivery hooks are implemented.

## Porting Notes
Register brief after health and attribution so their current blocks are
available. No core changes or new routes are required. The parent adds
node scripts/brief-test.mjs to its test workflow.
The only host hooks used are root, block, account, demo,
optional fmt.datetime, and optional selectView.

## Open Limitations
History starts on installation and stores only the last 14 refresh summaries.
Daily rolling windows usually cannot be compared; the UI states this.
Site/ad identifiers are opaque in the inbox, so Review opens the source tab
for detailed diagnostics. Missing tracking coverage cannot prove lost revenue.
Read state belongs to one browser, is not synchronized, and may be cleared
by browser storage policies. External notification delivery is unavailable.

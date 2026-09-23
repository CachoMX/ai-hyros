# Optional Evidence Copilot Provider

Evidence Copilot defaults to deterministic local snapshot rules. No provider
request occurs merely by opening the tab, checking capability, asking locally,
using demo mode, or leaving configuration incomplete.

## Configuration

Enable only after choosing a model and approving provider use. All three
server environment variables must be present:

| Variable | Required value |
| --- | --- |
| `HYROS_COPILOT_PROVIDER` | Exactly `openai` |
| `OPENAI_API_KEY` | A server-only API credential |
| `OPENAI_MODEL` | An explicit model ID compatible with Responses structured output |

There is no default model, browser key field, automatic model discovery or
provider fallback. Unsupported models fall back to snapshot rules. Removing
any required setting disables provider calls. This implementation does not
change environment files, provision credentials or enable a provider.

The browser first calls capability GET. It keeps local rules selected even
when configured. The unchecked **Use OpenAI for next question** control must
be selected before each external request; it resets after submission and
when the tab/account/range is rendered again. Suggestions follow the same
selection. Demo never calls the provider.

## Endpoint

Both methods require `checkAccess` and return `Cache-Control: private, no-store`.

`GET /api/copilot` returns only:

```json
{ "ok": true, "configured": false, "provider": null }
```

When configured, provider is `openai`. GET never reads an account snapshot,
requests a completion, reveals a model/account ID, or returns a key.

`POST /api/copilot?account=<local-account-id>` accepts only:

```json
{ "question": "What needs review?", "range": "7d", "useProvider": true }
```

Question is nonempty and at most 2,000 characters. Ranges are `today`,
`yesterday`, `7d`, `30d`. The JSON body is capped at 12 KiB. Additional fields
are rejected, including client snapshots, provider/model overrides and tool
definitions. Invalid account selectors cannot fall through to the default.
POST resolves `accountFromReq`, calls `readSnapshot`, generates `decisionBrief`,
and calls `evidencePack(brief, { redact: true })` on the server.

Successful replies carry `engine`, `fallbackReason`, `answer.text`, validated
`answer.citations`, and the local `account`, `range`, and `generatedAt`.
The account value stays within this app and lets the client reject a reply
from a different account. Failed provider requests still return HTTP 200 with
an honest snapshot-rules answer and a static reason. Authentication, invalid
input, missing snapshots and internal route failures use 401, 400/413, 404
and 503 respectively, without raw exception details.

## Provider Contract

The only destination is `https://api.openai.com/v1/responses`; redirects are
refused. The request specifies the configured model, `store: false`,
`stream: false`, a 1,000-output-token limit, and strict JSON through
`text.format`. It has no tools, previous response, conversation identifier,
assistant history, retrieval, web access or action execution.

The provider sees the redacted question and at most 12 aggregate findings,
report totals, currency, dates, coverage and caveats. A second field allowlist
after `evidencePack` removes raw records and arbitrary snapshot properties.
Campaign names/IDs, local account IDs, source/conversion/lead records, contact
fields and tracking URLs are not sent. Common email addresses, URLs, ID/key
patterns and phone-like values in the user question are scrubbed. Freeform
question redaction is heuristic, not a general personal-name detector.

Question and evidence are delimited as untrusted data. Instructions forbid
following embedded commands, inventing metrics, converting unknowns to zeros,
claiming causal lift, or performing actions. The model must return:

```json
{ "text": "Review the report coverage.", "citationIds": ["brief"] }
```

Only `brief`, an available `report`, and the actual `finding-N` IDs in that
request can be cited. The server requires 1-8 unique known IDs and at most
3,000 text characters. It supplies citation labels/navigation from its own
catalog. Unknown, duplicate, inline or excessive citations suppress the
entire generated answer. Incomplete responses, refusals, tool-call output,
invalid JSON/schema, detected contact data, transport errors and timeouts
also fall back. Citations validate provenance IDs, not every prose claim;
generated answers are visibly labeled for evidence review.

## Limits

- Provider input data: at most 20,000 UTF-8 bytes.
- Provider response body: at most 64,000 bytes, checked during streaming read.
- One provider request per opted-in question; no retries.
- Provider request and body-read deadline: 12 seconds, then abort and local fallback.
- Configured KV: one atomic `EVAL` reserves both limits before a call, with
  counters sharing the `{copilot}` Redis Cluster slot. Limit is 6 requests per
  account per minute and 60 per deployment per hour. Keys contain a hash of
  the account, never prompts, answers or credentials.
- KV guard deadline: 2 seconds. Unavailable/invalid guard results fail closed
  to local rules. Failed provider calls still consume their reservation.
- Without configured KV, there is no shared quota; request byte/token/deadline
  bounds still apply. The standard snapshot reader normally has no persisted
  snapshot in that case. No fake snapshot is substituted.

These are call/token controls, not an exact dollar budget. Configured model
pricing and provider-side limits still determine spend. Fixed-window counters
can admit adjacent-window bursts. Clearing a transcript does not refund an
already reserved or billed provider call.

## Integration And Checks

The parent app must add `/api/copilot` to `ACCOUNT_SCOPED`. Local preview should
answer capability GET with `configured: false`; it must not forward provider
requests. No CSS or shared decision rules are required to change.

`createCopilotHandler(deps)` accepts injected auth, account resolution,
snapshot read, environment, fetch, store availability, raw KV, clock and short
test deadlines. Provider helpers in `api/_copilot.js` can also be tested
independently. Run `node scripts/copilot-test.mjs`. Tests use mock provider
responses only, including timeout, schema, citation, privacy, limit and
account/range race cases. Browser histories are bounded and held in memory;
exporting a transcript is an explicit local download.

The implementation follows the official [Structured Outputs guide](https://developers.openai.com/api/docs/guides/structured-outputs)
for `text.format`, required fields, strict schemas and refusals, and the
[Responses migration guide](https://developers.openai.com/api/docs/guides/migrate-to-responses)
for the typed output array and explicit `store: false`. That setting disables
response storage, not a promise of zero retention under every account policy.

# Evidence Copilot

## Purpose

Answer account questions using the same deterministic decision brief as War
Room. Local snapshot rules are the default. An optional OpenAI provider can
explain a server-generated, redacted aggregate brief after explicit opt-in
for an individual question. Neither engine executes external actions.

## Data And Engines

Local answers use `decisionBrief(snapshot, range)` and `answerQuestion` from
`public/shared/decisions.js`. The existing feature block and refresh step are
unchanged. Rendering tolerates null, skipped, error, empty and previous/stale
blocks, and does not require DOM methods absent from conformance stubs.

On a real account, capability `GET /api/copilot` returns only provider and
configured flags. It sends no prompt or snapshot. Demo skips capability and
provider requests completely. The checkbox starts unchecked, stays disabled
until a successful capability check, and resets after one submission or any
new account/range render. Suggestions obey the same opt-in selection.

`POST /api/copilot` receives `{ question, range, useProvider: true }`, with the
account scoped by the parent API helper. The server authenticates, reads its
own snapshot, creates the decision brief, calls `evidencePack` with redaction,
and applies an additional aggregate-only allowlist. No browser-supplied brief,
record, API key or model is accepted. OpenAI configuration requires all three
of `HYROS_COPILOT_PROVIDER=openai`, `OPENAI_API_KEY` and explicit `OPENAI_MODEL`.
Missing configuration means no provider request.

The response contains `{ ok, account, range, generatedAt, engine,
fallbackReason, answer: { text, citations } }`. Engine is `snapshot-rules` or
`openai`. Each citation has a server-validated `id`, `title`, and supported
feature `view`. Unknown citations or malformed output discard the generated
answer and return deterministic text with a disclosed fallback reason.

## View Behavior

Each turn discloses its engine. Generated answers are marked for verification
against cited evidence. Errors use static user-facing reasons, never raw
provider responses or exceptions. Answers and questions are escaped as text.
Citation buttons only navigate to an allowed local feature.

History is in memory, bounded to 30 turns per account/range and 40 sessions.
No previous turns are sent to OpenAI. Account/range renders invalidate old
requests and reset opt-in; late capability/answer responses cannot update the
new context. POST account, range and snapshot timestamp must match. Clear
invalidates pending replies as well as clearing history. Transcript export
is a local JSON download with per-turn engines and fallback reasons.

## Limits And Failures

Question length is at most 2,000 characters. The provider receives at most
12 findings and 20 KB of aggregate data, with a 1,000-token output cap and
12-second network/body deadline. At most 8 unique known citations and 3,000
answer characters are accepted. There are no retries or tools. With KV
configured, a single atomic reservation enforces 6 account requests/minute
and 60 deployment requests/hour; unavailable rate guards fall back locally.

Structured output and valid citations do not prove that every generated
claim is correct. Local rules remain available without configuration or
after a provider failure. Native missing states and coverage caveats are
part of the evidence. Freeform question redaction removes common contact
patterns but is not a general personal-name detector.

## Porting And Validation

The host supplies `ctx.api`, `ctx.snapshot`, account/range, escaping,
formatters, feature navigation and existing Copilot styles. The parent adds
`/api/copilot` to `ACCOUNT_SCOPED`. Local preview returns capability disabled.
The optional backend is `api/copilot.js` plus `api/_copilot.js`; configuration,
privacy boundaries, factories and official API references are documented in
`docs/COPILOT.md`. Run `node scripts/copilot-test.mjs`; provider transport and
KV are mocked, with no external LLM calls or environment changes.

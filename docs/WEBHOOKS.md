# Optional HYROS Webhooks

This receiver is optional and is **not active until deployed, configured, and
registered with HYROS**. This implementation does not create a subscription or
change HYROS data. Registering subscriptions is an operator action outside this
change. No registration has been performed.

Protocol reviewed on 2026-09-23 against the official
[documentation index](https://api-docs.hyros.com/llms.txt) and
[webhook reference](https://api-docs.hyros.com/ai-context/webhooks.txt), version 1.2.
HYROS signs each delivery using the subscription's `secretKey`, not an API key
or public key. The reference documents all eleven supported event types in
`EVENT_TYPES` in `api/_webhook.js`.

## Configuration

Set the server-only environment variable `HYROS_WEBHOOK_ACCOUNTS` to a JSON
object mapping **existing local registry account IDs** (`acc_...` or `cli_...`)
to subscription credentials. An account accepts one object or an array for
multiple subscriptions:

```json
{
  "acc_012345abcdef": [
    { "subscriptionId": "sub-example", "secretKey": "REPLACE_WITH_SUBSCRIPTION_SECRET" }
  ],
  "cli_abcdef012345": {
    "subscriptionId": "sub-client-example",
    "secretKey": "REPLACE_WITH_CLIENT_SUBSCRIPTION_SECRET"
  }
}
```

Use the subscription `secretKey` from HYROS, available at subscription creation
or in its webhook subscription settings. Keep it in deployment secrets; never
put it in a public environment variable, repository, browser, URL, or logs.
Mapping a subscription to the correct local account is the operator's
responsibility. The receiver does not resolve accounts through the registry or
HYROS. The legacy `env` account ID is not a connected account in this app.
Duplicate subscription IDs across mappings are rejected. Bounds are 100
accounts, 20 subscriptions per account, 256 KiB configuration and 4096 bytes per
secret. A deployment with a missing, empty, or invalid map returns a clear 503.

Writable KV storage is also required. The existing `_store.js` credential
resolution and `kvRaw` interface are reused, including canonical Upstash/Vercel
variables and custom prefixes. Redis must permit `EVAL`, `TYPE`, `TIME`, `GET`,
`SET`, `DEL`, `ZREMRANGEBYSCORE`, `ZSCORE`, `ZCARD`, `ZADD`, and `EXPIRE`.
Missing storage or an unsuccessful atomic write returns 503, never a success
that discards a notification. Nothing falls back to process-local memory.

The future subscription target is `https://YOUR_DEPLOYMENT/api/webhook`.
There are no query credentials, account selection parameters, or dashboard
password requirements. The signed envelope's `subscriptionId` selects its
configured account and secret; extra payload fields cannot choose an account.

## Verification and Responses

Only POST is supported (`405` with `Allow: POST` otherwise). Send uncompressed
UTF-8 `application/json`. The route disables the Vercel body parser. It reads
the original bytes, enforces a 1 MiB limit on both declared and actual length,
and allows at most 10 seconds for body receipt. Parsed objects and decoded
request streams are rejected rather than serialized to manufacture a body.

`X-Hyros-Signature` must be `t=<epoch seconds>,v1=<64 lowercase hex digits>`.
The expected value is `HMAC_SHA256(secretKey, timestamp + '.' + rawBody)` and
comparison uses `timingSafeEqual`. Timestamps more than 300 seconds in either
direction are rejected. Keep the deployment clock synchronized. The deprecated
SHA1 header is not accepted. HYROS re-signs retries with a fresh timestamp;
deduplication uses the event ID, not the signature or signature timestamp.

The envelope requires `subscriptionId`, `eventId`, `type`, an ISO-style
`timestamp`, and an object `body`. All eleven documented events dirty the
account. Unknown event types return 400 until support is added. The envelope's
timestamp can be old on a retry; only the signature timestamp controls replay
protection. Nested lead/sale data is neither interpreted nor persisted.

| Status | Meaning |
| --- | --- |
| 200 | Durably marked dirty, or already accepted; JSON includes `duplicate` |
| 400 | Invalid JSON/UTF-8, envelope, length, incomplete body, or event type |
| 401 | Unknown subscription, incorrect signature, missing signature, or replay |
| 405 | Unsupported method |
| 408 | Body receipt timed out |
| 413 | Payload exceeds 1 MiB |
| 415 | Unsupported media type, encoding, or compression |
| 503 | Missing configuration/storage, unavailable raw bytes/KV, or capacity reached |

503 responses include `Retry-After: 60`. The receiver does not schedule retries
itself. Monitor delivery failures in HYROS: its reference notes that continuing
delivery errors can disable a subscription. Its reference does not specify a
maximum retry duration, so the retention window below is an application policy.

## Persistence and Refresh Integration

One atomic Redis Lua operation deduplicates `(subscriptionId, eventId)` and
marks the configured local account dirty. Concurrent deliveries across
instances return one initial acceptance and duplicates thereafter. Receipt
hashes remain for seven days, with a cap of 10,000 live receipts per account.
At capacity new events return 503; live receipts are not evicted to make space.
Duplicates remain acceptable at capacity. Size this policy for production
volume before enabling a busy account. A fresh signed retry after seven days
can mark the account dirty again.

The only persistent keys are:

- `aihyros:webhook:{ACCOUNT_ID}:receipts`: sorted set of SHA256 hashes of the
  subscription/event ID pair, scored by Redis receipt time; seven-day expiry.
- `aihyros:webhook:{ACCOUNT_ID}:dirty`: random UUID token, with no expiry until
  successfully consumed. Each new event replaces it; duplicates do not.

No raw payload, lead information, email, phone, IP, sale details, secret,
signature, or raw event/subscription ID is persisted or logged. Only configured
local account IDs, event-ID hashes, receipt times, and random tokens are stored.
There is one dirty marker per account. Both keys share a Redis Cluster hash slot.
Removing an account from configuration does not delete its pending marker;
account removal cleanup can delete its two keys through `webhookKeys(accountId)`.

The existing `vercel.json` cron calls `/api/refresh` daily at **09:00 UTC**
(`0 9 * * *`), refreshing eligible accounts within its budget. Webhooks are
notifications, not complete report snapshots. This endpoint performs no MCP
calls, snapshot refresh, HYROS writes, outbound subscription registration, or
background work. It awaits persistence before replying.

When `HYROS_WEBHOOK_ACCOUNTS` is valid, `/api/refresh` now checks dirty markers
only for its configured local accounts. The existing daily cron prioritizes
eligible dirty accounts, oldest snapshot first within that group, then falls
back to the remaining eligible accounts in the usual oldest-first order.
Invalid keys, unapproved accounts, unsupported agency clients, and existing
refresh time budgets retain their existing eligibility rules. Without webhook
configuration, refresh does no marker I/O and keeps the existing order.

Manual and cron refreshes capture the marker before fetching data. They clear
it with `clearWebhookDirty` only after `writeSnapshot` confirms durable success
and `snapshotFreshForWebhook` confirms all of the following:

- An MCP snapshot generated during this build, no snapshot warnings, and no
  truncated sources.
- Fresh CRM sync metadata and all four complete lists: leads, sales, calls,
  and subscriptions. Any stale/skipped/error marker, truncation, or inherited
  incomplete lead base prevents acknowledgement.
- All four attribution report ranges present and complete, with no skipped,
  stale, partial, or failed ranges.
- A freshly checked attribution conversion-path block with complete coverage,
  no truncation, and no errors or warnings.

This is deliberately conservative: successful partial snapshots remain useful
to the dashboard, but retain the notification for a later complete refresh.
Freshness is assessed within the application's existing report/CRM windows;
the marker does not track individual event contents or prove upstream indexing
has finished. Compare-and-delete preserves an event arriving during the build
or snapshot persistence. Failed builds or writes leave the marker unchanged.
Marker read/clear failures emit `refresh.webhook_warning` with fixed operation
and error codes, never exception bodies, secrets, signatures, or payloads. Such
failures do not turn an otherwise successful manual snapshot into an error.
Daily cron falls back to normal refresh when a marker cannot be read.

## Optional Dirty-Only Worker

`GET /api/refresh?dirty=1` (or POST) selects only configured, eligible accounts
with a pending marker. It requires `Authorization: Bearer <CRON_SECRET>` with a
configured `CRON_SECRET`; dashboard credentials and the unsigned Vercel cron
user-agent fallback do not authorize this mode. Do not combine it with
`account=`. Missing/invalid webhook configuration returns 503. The worker uses
the existing total/per-account budgets, skips agency discovery, reports marker
read failures as skipped accounts, and rechecks markers before each build so
work already consumed by another worker can be skipped. It performs awaited
refreshes; the receiver never invokes it or launches background work.

**The default is still daily, not real-time.** No cron schedule, frequency, or
`vercel.json` setting changed. A more frequent authenticated worker invocation
is an optional deployment integration to arrange separately; none was created
or registered by this change. Normal dashboard authentication, daily cron
authentication, and the existing unsigned daily-cron lock remain in place.

## Tests

Run `node scripts/webhook-test.mjs`. Tests use synthetic secrets and a local
atomic KV model; they never contact HYROS or deployment KV and never register
subscriptions. Coverage includes raw-byte signatures, time boundaries and
re-signed retries, concurrent deduplication, account isolation, malformed body
and size limits, KV failure/retry, retention/capacity, no payload persistence,
and compare-and-delete races during refresh.

Run `node scripts/webhook-refresh-test.mjs` for refresh integration assertions:
dirty priority and oldest-first fallback, worker authentication and eligibility,
complete-data acknowledgement, persistence failures, marker storage failures,
budget skips, and newer events arriving during refresh/persistence. Injectable
dependencies in `createRefreshHandler`, `refreshAccount`, and
`webhookCronTargets` keep these tests isolated from HYROS and deployment KV.
Neither script is added to `package.json` by this scoped change.

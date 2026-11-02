# @agent-workflows/gateway

The local inference gateway on `127.0.0.1:7794`. It forwards native LLM requests byte for byte, pays for Claude calls
from the subscriptions' API credit before IU, and records every request. Design and rationale: `docs/gateway.md`.

- **Lean by design.** No journal Postgres, workflow runtime or OpenCode. It runs as one bundled file:
  `bun build packages/gateway/src/main.ts --target=bun --outfile gateway.js`, then `bun gateway.js`.
- **Bundle rule.** Only the leaf `@agent-workflows/routes/pricing`, never the package's index, which reads `src/table/`
  from disk at import. `test/start.test.ts` boots the bundle from an empty directory.

## Paths

| Path | Upstream | Credential |
|-|-|-|
| `POST /anthropic/v1/messages` | a credit pool, else IU `/anthropic` | `x-api-key: <pool key>`, else `authorization: Bearer <IU key>` |
| `POST /anthropic/v1/messages/count_tokens` | the same pick; no ledger row, no binding | same |
| `/openai/v1/*`, `/gemini/v1beta/*`, `/replicate/v1/*` | IU root + the same path | `authorization: Bearer <IU key>` |
| `/decisions/v1/*` | IU origin + the same path | `authorization: Bearer <IU key>` |
| `GET /health` | the gateway, no auth | none |

Callers send a door token as `authorization: Bearer <t>`, `x-api-key`, `x-goog-api-key`, `api-key` or a `key` query
parameter; the API secret authenticates as `agw`.
Every proxied response carries `x-agw-request-id` (the ledger `source_id`) and `x-agw-pool` (a pool id, `iu-api`, or
`refused` on a 402).

**Forwarded:** the body's bytes, except on the `/anthropic` paths an exact alias (`haiku`, `sonnet`, `opus`) in `model`,
which is re-serialised with the concrete id. **Not forwarded:** every credential carrier above, `host`,
`content-length` (recomputed), hop-by-hop headers and every `x-agw-*` header.

## Env

| Variable | Required | Meaning |
|-|-|-|
| `AGW_GATEWAY_STATE_DIR` | yes | the ledger is `<dir>/ledger.sqlite`, created with its directory |
| `AGW_GATEWAY_ACCOUNTS_FILE` | yes | the account registry; each account's `platform` block is a pool |
| `AGW_API_SECRET` | yes | caller `agw`; at least 32 characters |
| `IU_API_KEY`, `IU_BASE_URL` | yes | the personal IU key; the URL ends in `/anthropic` |
| `IU_KEY_ID` | no | unset or `personal`; anything else exits 78 |
| `AGW_DOOR_CALLERS_FILE` | no | door tokens, mode 0600; default `~/.agent-workflows/data/door-tokens` |
| `AGW_GATEWAY_PORT` | no | default 7794 |
| `USAGE_PG_URL` | no | unset turns the flush loop off; rows stay in the ledger and `/health` says so |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS` | no | span export; off without an endpoint |
| `AGW_MACHINE`, `AGW_VERSION`, `AGW_GATEWAY_BUILD` | no | row and `/health` labels; the last two default to `dev` |

A bad config exits 78 and names every problem, never a value. Pool keys resolve at start through `secrets-run read`
(20 s each). A failure or a `REPLACE` placeholder disables that pool and logs why; the gateway still starts. A disabled
pool's refs are not read. The process never reads `iu.env` or `athena-iu.env`.

## Pick flow

`src/pools/` owns the decision; `src/proxy.ts` acts on it.

1. A Claude-Code-shaped request skips the credit pools.
2. A bound session stays on its pool while that pool is eligible.
3. A new session takes the eligible pool that expires soonest.
4. With no pool eligible the request goes to IU, unless the caller sent `x-agw-fallback: none`: then a 402 with the
   balance marker.
5. A pool's balance refusal marks it drained and picks again without it, pool by pool, until the pick is no pool: IU,
   or the 402.

The label of the IU passthrough is `iu-api` everywhere, because a credit pool is named `iu`. Bindings are written only
after an upstream 2xx.

## Ledger and outbox

- **Write.** One row per served request, written synchronously when the tee has the final usage (end of stream, or on an
  error or abort with what is known), before the stream closes. The charge follows the write. A 402 and a `count_tokens`
  write no record; picks go in beside the records.
- **Cost.** `cost_reported_usd` is the provider's own `usage.cost` if it states one, else a complete usage block at the
  Claude rates, else null (Postgres then prices the token columns). On a credit pool an estimate stands in for the meter only (`lane_detail.costEstimatedUsd`,
  `costEstimated: true`): the rules are in `docs/gateway.md` §Meter, the code in `src/charge.ts`.
- **Tee limits.** A held or decoded copy stops at 64 MiB and one pending SSE event at 1 MiB. Past either the usage is
  incomplete and the estimate applies; the caller's bytes go through untouched.
- **Flush.** Every 30 s and 1 s after a write, one flush at a time, 200 rows a transaction. After a failed flush only the
  30 s tick retries, so an outage is not hammered per request.
- **Delivery.** At least once: a row is marked only after its transaction commits, and the upserts on `(source, source_id)`
  and `(request_id, picked)` absorb a repeat.
- **Quarantine.** A row Postgres refuses (SQLSTATE class 22 or 23) keeps its error in the ledger, counts on `/health` and
  is not retried while the process lives; the batch around it lands. Each process start requeues quarantined rows once
  (`ledger.requeuedAtStart`), since a migration or a deploy may have fixed them. Any other failure leaves everything
  unsynced.
- **Prune.** Synced rows older than 62 days go. Unsynced and quarantined rows stay.
- **Meter.** `spentSince` reads the ledger, synced or not. The reconcile's high-water mark per pool and cycle sits beside it, and
  each start applies it before listening.
- **SQLite.** WAL with `synchronous=NORMAL`: durable across a process crash, the failure the outbox guards. A deploy never
  overlaps two gateways, because it waits for the unload before it loads the new one; `busy_timeout` is for a second
  connection such as `sqlite3` on the file.

## /health

```json
{
  "status": "ok",
  "version": "<AGW_VERSION>",
  "build": "<AGW_GATEWAY_BUILD>",
  "pools": [{ "id": "iu", "eligible": true, "meterUsd": 12.3, "reconciledAt": "…", "reconcileError": null }],
  "ledger": { "unsynced": 0, "quarantined": 0, "oldestUnsyncedAt": null, "flush": "on" }
}
```

`status` is `degraded` only when the ledger cannot be written. `ledger.flushError` carries the last flush failure,
`pools[].reconcileError` the last reconcile failure kind.

## Lifecycle

SIGTERM stops accepting and lets requests finish for 50 s, an upload in progress included. It then cuts the rest: each
writes its row and charge before the ledger closes, except an upload, which never went upstream. It flushes for 5 s and
exits, within 60 s in all. The first reconcile holds the start for 30 s at most, then the gateway listens anyway.

## Tests

```sh
bun test packages/gateway
```

No test makes a real LLM or Admin API call: fake upstreams on port 0, fake keys, a temp SQLite file. The outbox suite
(`test/outbox-pg.test.ts`) needs `USAGE_TEST_PG_URL` and usage-tracker's migrations, a scratch database per run, and
skips with the reason in its name otherwise. `make check` supplies the URL; from a linked worktree also set
`USAGE_MIGRATIONS_DIR` to `~/SourceRoot/usage-tracker/migrations/pg`.

# @agent-workflows/gateway

The local inference gateway on `127.0.0.1:7794`. It forwards native LLM requests byte for byte, pays for Claude calls
from the subscriptions' API credit before IU, and records every request. Design and rationale: `docs/gateway.md`.

- **Lean by design.** No journal Postgres, workflow runtime or OpenCode. It runs as one bundled file:
  `bun build packages/gateway/src/main.ts --target=bun --outfile gateway.js`, then `bun gateway.js`.
- **Bundle rule.** Only the leaves `@agent-workflows/routes/pricing` and `@agent-workflows/routes/rates` (the route
  table's rates, its group files imported statically), never the package's index, which reads `src/table/` from disk at
  import. `test/start.test.ts` boots the bundle from an empty directory.

## Paths

| Path | Upstream | Credential |
|-|-|-|
| `POST /anthropic/v1/messages` | a credit pool, else IU `/anthropic` | `x-api-key: <pool key>`, else `authorization: Bearer <IU key>` |
| `POST /anthropic/v1/messages/count_tokens` | the same pick; no ledger row, no binding | same |
| `GET /anthropic/v1/models`, `GET /anthropic/v1/models/<id>` (one segment of `[A-Za-z0-9._:-]`) | IU `/anthropic`, no pick; no ledger row, no `gateway_picks` row | `authorization: Bearer <IU key>` |
| `/openai/v1/*`, `/gemini/v1beta/*`, `/replicate/v1/*` | IU root + the same path | `authorization: Bearer <IU key>` |
| `GET` on one of these paths or `/decisions/v1/*` ending in `/models` or `/models/<one segment>` | IU, the same path; a catalog read: no ledger row, no `gateway_picks` row | `authorization: Bearer <IU key>` |
| `/decisions/v1/*` | IU origin + the same path | `authorization: Bearer <IU key>` |
| `GET /health` | the gateway, no auth | none |

Callers send a door token as `authorization: Bearer <t>`, `x-api-key`, `x-goog-api-key`, `api-key` or a `key` query
parameter; the API secret authenticates as `agw`.
Every proxied response carries `x-agw-request-id` (the ledger `source_id`) and `x-agw-pool` (a pool id, `iu-api`, or
`refused` on a 402 or an `eval` refusal).

**Model.** A response that echoes the requested model behind a provider prefix (`openai.<id>`, `deepseek/<id>`) is
recorded under the requested id, the echo in `model_raw`; any other echo is the row's `model` as it came.

**Forwarded:** the body's bytes, except on the `/anthropic` paths an exact alias (`haiku`, `sonnet`, `opus`) in `model`,
which is re-serialised with the concrete id. **Not forwarded:** every credential carrier above, `host`,
`content-length` (recomputed), hop-by-hop headers and every `x-agw-*` header. The gateway reads these itself:

| Header | Effect |
|-|-|
| `x-agw-session`, `x-agw-run-id`, `x-agw-workflow`, `x-agw-step`, `x-agw-purpose` | the session binding, `lane_detail`, `run_id` |
| `x-agw-project` | `project_raw`, and `repo` when it is a plain slug and the workspace is not `work` |
| `x-agw-workspace` | `workspace`, when it is `work` or `private` |
| `x-agw-fallback: none` | a 402 instead of the IU fallback (`/anthropic` paths). Does not touch an `eval` request: that is refused either way |
| `x-agw-purpose: eval` | draws only on credit above a pool's eval reserve; with none, the 403 below, never IU (`/anthropic` paths). Any other purpose is attribution only |
| `x-agw-usage: caller` | from caller `agw` on `/openai/v1/images/`, `/openai/v1/audio/`, `/gemini/v1beta/` or `/replicate/v1/`: no ledger row. Ignored from any other caller or on any other path |
| `x-agw-upstream: iu` | an `/anthropic` path skips the credit pools, reason `forced` in `gateway_picks`; no effect elsewhere. An `eval` request with it is refused (403) |

Project and workspace values over 200 characters are dropped. `x-agw-fallback`, `x-agw-usage` and
`x-agw-upstream` compare case-insensitively; `x-agw-workspace` is exact, as the `usage.records` check is.

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

`src/pools/` owns the decision; `src/proxy.ts` acts on it. The first line that applies wins (the same order is in
`docs/gateway.md` §Picking a pool):

1. `x-agw-upstream: iu` goes to IU, reason `forced`, with `lane_detail.fallback` null: a choice, not a fallback. It beats a bound session, writes and clears no binding, and
   `x-agw-fallback: none` does not refuse it. **Not for `eval`:** an eval request that is forced is refused (`eval-forced`), never IU; a probe that needs IU must not carry `x-agw-purpose: eval`.
2. A Claude-Code-shaped request skips the credit pools: IU, or the 402 with `x-agw-fallback: none`; for `eval`, the refusal below (`eval-claude-code`).
3. A bound session stays on its pool while that pool is eligible (for `eval`: and above its reserve, else it is picked anew).
4. A new session takes the eligible pool that expires soonest (for `eval`: among the pools above their reserve).
5. With no pool eligible the request goes to IU, unless the caller sent `x-agw-fallback: none`: then a 402 with the
   balance marker, and the agw route falls back onto GPT on IU.
6. A pool's balance refusal marks it drained and picks again without it, pool by pool, until the pick is no pool: IU,
   or the 402.
7. **An `eval` request with no pool above its reserve** is refused, `picked = refused`, reason `eval-reserve`, no ledger row and no upstream call, `x-agw-fallback` or not. The 403 carries `x-agw-pick-reason` (`eval-reserve`, `eval-forced` or `eval-claude-code`).

**The refusal is a 403**, an Anthropic-shaped `permission_error` with a fixed message that names the reason and points at
each pool's `evalAvailableUsd` on `/health` (it reads no pool state, so no ledger read). It is not a 402: `isBalanceFailure` treats that as an empty balance and the agw route would fall
back onto GPT on IU, spending IU and replacing the arm's model. It is not a 408, 409, 429 or 5xx either: the transports
(`RETRYABLE_STATUS`) and the Anthropic, OpenAI and AI SDKs (OpenCode's included; they retry 409 too) ask again. Nothing
retries or classifies a 403, so the run fails with the reason in its message. `test/proxy.test.ts` asserts
`isBalanceFailure` is false on the exact body.

**Pacing.** The reserve and the runway are `docs/gateway.md` §Credit pacing; `platform.evalReserveUsd` overrides a pool's reserve (a value above `creditUsd` logs a warning at start). An unknown cycle never serves evals unless it is set.

The label of the IU passthrough is `iu-api` everywhere, because a credit pool is named `iu`. Bindings are written only
after an upstream 2xx.

## Ledger and outbox

- **Write.** One row per served request, written synchronously when the tee has the final usage (end of stream, or on an
  error or abort with what is known), before the stream closes. The charge follows the write. A 402, a `count_tokens`, a
  model catalog read (any path's) and an honoured `x-agw-usage: caller` write no record; picks go in beside the records.
- **Attribution.** `repo`, `project_raw` and `workspace` live in `row_json` like the rest of the row. A row an older build
  wrote lacks them and flushes as null.
- **Cost.** `cost_reported_usd` is the provider's own `usage.cost` if it states one, else a complete usage block at the
  Claude rates, or off `/anthropic` at the rate of the route naming the requested model (`routeRate`), else null
  (Postgres then prices the token columns). On a credit pool an estimate stands in for the meter only (`lane_detail.costEstimatedUsd`,
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
  "pools": [
    {
      "id": "iu",
      "eligible": true,
      "meterUsd": 12.3,
      "creditLeftUsd": 185.7,
      "daysLeft": 18.5,
      "runwayUsdPerDay": 10.04,
      "evalReserveUsd": 119.35,
      "evalAvailableUsd": 66.35,
      "evalEligible": true,
      "reconciledAt": "…",
      "reconcileError": null
    }
  ],
  "ledger": { "unsynced": 0, "quarantined": 0, "oldestUnsyncedAt": null, "flush": "on" }
}
```

`status` is `degraded` only when the ledger cannot be written. `ledger.flushError` carries the last flush failure,
`pools[].reconcileError` the last reconcile failure kind. The runway fields are `docs/gateway.md` §Credit pacing.

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

# @agent-workflows/middleware

The platform layer every workflow runs inside (concept §4 rows Record and Telemetry, §5): purpose, fingerprint,
run record and telemetry as runtime `Middleware`, plus the Argo outbox the host flushes. Built on the S2 verdicts
(`docs/spikes/s2-telemetry/REPORT.md`).

## Shape

```ts
const platform = platformMiddleware({
  connectionString, // the runtime's
  schema: 'agw', // the runtime's
  fingerprint: fsFingerprintSource({ agentsDir, workflows: { 'research.report': [{ agent: 'brain', route: 'cheap.classify' }] } }),
})
const runtime = new Runtime({ connectionString, workflows, host, middleware: platform.middleware })
platform.telemetry.installFlush({ onSignal: () => runtime.close() })
await runtime.open()
setInterval(() => void platform.outbox?.flush(), 30_000) // the host's tick (Wave 3)
```

`platform.middleware` is the ordered list `purpose → iu-key → fingerprint → friction → record → telemetry`. The friction
counters are final before the record reads them, and the record runs before telemetry so its totals land on the run
span before telemetry ends it. `platform.close()` comes after
`runtime.close()`: it ends open spans, flushes and closes the pool.

## What each middleware records

| Middleware | Hook | Writes |
|-|-|-|
| `purpose` | `runPre` | Refuses (`AdmissionRefused`) a run with a blank purpose. The runtime already makes it non-null |
| `fingerprint` | `runPre` | `runs.fingerprint` on admission (`resume: false`), written once (`coalesce`). A resumed run keeps it. Source read and writes are retried; a lasting failure refuses the run |
| `friction` | `stepPost`, `runPost` | `runs.friction`, see Friction below |
| `record` | `runPost` | `runs.wall_ms`, `tokens_*` (incl. `tokens_cache_write`), `cost`, `unpriced_calls`, `tool_calls`, `trace_id` |
| `telemetry` | all six | One span per run drive, one child span per step, tool calls as span events |

- **Run record.** Sums the run's own step rows. A fan-out's children carry their own record; sum by `root_id`
  for a tree. `cost` stays null when nothing was priced; `unpriced_calls > 0` marks it as a lower bound. Wall time
  comes from the row's `started_at`/`finished_at`, so a re-delivered `runPost` writes the identical record; it is
  null for a run that never started (cancelled while pending), never 0.
- **Fingerprint.** sha256 over the workflow version, each referenced agent's `AGENTS.md` and `skills/**`, each
  agent's `routeFingerprint` (`@agent-workflows/routes`, overrides included) and `opencode --version`. Inputs come
  through the `FingerprintSource` port. `fsFingerprintSource` re-reads an agent's files only when a size or mtime
  changed (a directory walk and a `stat` per file per admission), so an edited `AGENTS.md` changes the fingerprint
  without a restart. It runs `opencode --version` once per process (a failed run is retried) and never for a
  workflow without agents. Tests pass a fake.
- **Purpose.** On the run span (`agw.purpose`) and in every Argo row's `raw.purpose`. The projection refuses a run
  without one.
- **Tokens.** `usageFromOpenCodeMessages(messages, { model })` turns an agent session's
  `GET /api/session/:id/message` page into the runtime's `Usage`. The Wave 3 OpenCode host returns it as
  `AgentResult.usage`. Spans are never the token source: OpenCode 2.0.32 emits no model or token spans (S2).

### Friction

Concept §7 tier 1: counters on every run, no LLM. `runs.friction` is a versioned document (`v: 1`), written for every
run (zeros included) at `runPost`:

| Counter | Counts | Source |
|-|-|-|
| `toolErrors` | tool parts that ended in `error`, summed over every session the run's agent steps opened | the OpenCode sessions, via the `FrictionSource` port |
| `repeatToolCalls` | the highest number of identical tool calls (same tool, same canonical input) in any one session | same |
| `nudges` | repeat-tool notes the host sent (at the 3rd, 5th, 8th identical call; opencode-host README) | same |
| `schemaReasks` | agent steps whose last attempt failed `invalid_output`, once each, whatever re-asks follow | the step rows |
| `overBudget` | runs the wallet gate refused (`admission_refused`, message `wallet gate: …`) plus steps the runaway cap failed (`middleware`, message `runaway cap: …`) | the step rows and the run's outcome |
| `followUps` | 1 when the user asked again about this run (host README §Friction job) | the host's daily threshold job, never inline |
| `nudgesMissed` | nudges that were due and sendable but are not in the session (failed or given up): a threshold counts only when a later tool call followed it, and a note for it or a higher threshold of the same call satisfies it. Informational, not a threshold counter | the OpenCode sessions |

The document also holds what the counters are summed from: `sessions` (`{ [stepId]: { [sessionId]: counters } }`) and
`events` (`{ "<stepId>#<attempt>" | "run#wallet": "invalid_output" | "budget" }`), and `incomplete: true` while the
host could not answer in full.

- **`runPost` is the only writer and a true recompute.** It reads the run's step rows and the run row together under
  the row's lock (one transaction), asks the source for the sessions of every agent step (`stepSessions({ runId,
  stepId })`: every attempt, every fallback, found from the step key, not from a handle that a failed attempt clears),
  and **replaces** `sessions` and `events`. Nothing merges, so nothing stale survives (an event for an attempt that is
  no longer the last, a step that is gone) and nothing counts twice: a re-delivered hook, a resume that re-attaches to
  the same session, a lost document rebuilt by a second `runPost` all give the same record. The counters come from
  session messages, not from the tool events the host reports, so a re-attach re-emitting every event cannot double
  count. There is no `stepPost` hook: the journal row has everything it would say.
- **A host that cannot answer in full never costs a count and never fails the hooks.** Steps are asked together, at most
  `PROBE_CONCURRENCY` (4) at a time. A step answered completely is replaced. A step answered partly, or not at all
  (the agent server restarting), keeps the entries an earlier answer wrote, and per session the fuller entry wins
  (counters only grow, so a shorter read never lowers a count); the document says `incomplete: true`. `runPost` does
  not throw for it: a redelivery would turn one restart into five failed deliveries at 2 s apart, re-run the other
  hooks, delay the Argo projection, and the run span is finalized from the first delivery anyway. Instead the span
  carries `agw.friction.incomplete`, and **the host's daily friction job recounts the incomplete runs of its window**
  (fewest attempts first, newest first among equals, at most 20 per tick, through `frictionRecounter`, the same code
  `runPost` runs) before it computes rates. A complete answer replaces the step and clears the flag. Each recount by the
  job that still comes out incomplete counts one attempt (`recountAttempts`); after `MAX_RECOUNT_ATTEMPTS` (3) the
  document says `incomplete: 'gave-up'` and the job leaves the run alone, so a run that keeps failing neither blocks
  the cap nor is retried forever. Merging keeps the larger of the counters that only grow; `nudgesMissed` can fall (a
  late note that landed), so it comes from the newest answer.
- **Known gap: retried attempts are invisible.** The journal keeps only the last attempt of a step, so a schema miss on
  an attempt that a retry then overcame is not counted (its session's tool counters are). The runtime has no
  per-attempt hook.
- **Re-asks.** A re-ask is the same incident as the schema miss that caused it: only the `invalid_output` failure
  counts, and a `<id>:reask` step adds nothing. When the scorer work's `ctx.continue` re-asks inside one step and the
  second answer passes, no step fails and nothing is counted; that miss is not visible at this layer.
- **The two money rules are recognised by message prefix** (`WALLET_REFUSAL_PREFIX`, `RUNAWAY_CAP_PREFIX`), because
  the middleware package cannot import `limits`. `packages/host/test/friction.test.ts` builds the real error and
  fails if the prefixes drift.
- **The source is a port.** `platformMiddleware({ friction })` takes a `FrictionSource`; the host passes the OpenCode
  host's. Without one only step outcomes are counted. The database work of `runPost` is retried like every other
  post-hook write.
- **Order.** `friction` must come before `record` in the list (the record reads the finished document); a test pins it.
- **Totals on the run span** as `agw.friction.*` attributes. Argo's `raw.friction` carries the whole document.

### Spans

| Span | Parent | Attributes |
|-|-|-|
| `agw.run <workflow>` | the caller's `traceparent`; else a root in a trace derived from the root run id; a child run hangs under its parent's fan-out step span | `agw.workflow.id`, `.version`, `agw.run.id`, `.root_id`, `.parent_id`, `.resumed`, `.status`, `agw.purpose`, `agw.fingerprint`, record totals (`agw.tokens.*`, `agw.cost.usd`, `.unpriced_calls`, `agw.tool_calls`, `agw.run.wall_ms`), `agw.error.*` |
| `agw.step <id>` | its run span | `agw.step.id`, `.kind`, `.attempt`, `.replay`, `.status`, `agw.tokens.*`, `agw.cost.*`, `agw.tool_calls`, `gen_ai.request.model` (one model), `opencode.session.id` (agent steps, from `StepPostArgs.handle.sessionId`) |
| event `tool.pre` / `tool.post` | its step span | `agw.tool.name`, `.call_id`, `.error` |

- **Admission span id** is derived from the run id (`admissionSpanId`). A resumed run opens a new span in the same
  trace, linked to it (`agw.link: admission`). The process that was stopped ends its open spans with
  `agw.suspended`.
- **Steps without `stepPost`** (a cancel cleanup ended them, or an infra error left the run) end with their run:
  `agw.step.status` `cancelled`, or `error` with an error status; never `agw.suspended`.
- **One run span per process.** A `runPost` re-delivered in the process that already ended the run's span (a hook
  threw on the first delivery) is a no-op for telemetry; the last 10,000 ended runs are remembered.
- **No open span** at `runPost` means one of three things: a re-delivery in another process, a run cancelled while
  pending, or a run refused before telemetry's `runPre`. A short span carries the outcome (`agw.run.outcome_only`),
  linked to the admission span.
- **`telemetry.traceparent(runId, stepId)`** gives the step span's W3C header. The OpenCode host sends it on every
  request, so OpenCode's `http.server` spans join the step (S2 §5).

## Flush contract

Without a handler, spans are lost on `process.exit`, on a natural exit and on SIGTERM (S2 flush matrix).
`telemetry.installFlush({ onSignal })` installs, once per process:

| Event | Behaviour |
|-|-|
| `SIGTERM`, `SIGINT` | `onSignal(signal)` (the host's own shutdown, e.g. `runtime.close()`), then `shutdown()`: open spans end as suspended, flush, provider shutdown. Then the handlers are removed and the signal is re-raised, so the process ends by the signal (128+n), not `exit(0)` |
| `uncaughtException`, `unhandledRejection` | logged, `shutdown()`, `exit(1)` |
| `beforeExit` | flush when spans are waiting |
| `exit` | can't await; logs how many spans an explicit `process.exit` loses |

- **Bounded.** Every flush and shutdown is capped at `flushTimeoutMs` (default 5 s). A timeout is logged.
- **Span text is redacted.** Error messages and tool errors on spans have bearer tokens, `sk-` keys, `name=value`
  pairs whose name contains key, token, secret or password (`api_key=`, `IU_API_KEY=`, `GITHUB_TOKEN=`) and the
  same names as JSON strings (`"token": "…"`, plus `"authorization"`) replaced, and are capped at 500 characters;
  the journal keeps the full message.
- **Diagnostics.** OTel's `diag` logger is process-global: installed once, it forwards to the most recently
  constructed `Telemetry`'s logger and is unhooked at its shutdown. One `Telemetry` per process is the shape.
- **Never silent.** A failed export is logged with its span count by the exporter wrapper. Spans the batch queue
  dropped are counted (ended minus exported minus failed) and logged at the next flush. OTel's own diagnostics go
  to the same logger at `warn`.
- **One owner.** Other `SIGTERM` listeners would keep the re-raised signal from ending the process. The host shuts
  down through `onSignal` instead.
- **Receiver is env.** The default exporter is OTLP http/protobuf, configured only by the standard env.
  - Local: `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4319` (unauthed loopback).
  - Leaving the host: the authed tier plus `OTEL_EXPORTER_OTLP_HEADERS` from `secrets-run`.
- **S2's open question, answered.** On Bun 1.4.3, `exporter-trace-otlp-proto` 0.300.0 reads
  `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_HEADERS` itself. `test/flush.test.ts` passes both only
  through the child's env and asserts the headers at the receiver.

Packages, pinned exactly: `@opentelemetry/sdk-trace` 3.0.0, `exporter-trace-otlp-proto` 0.300.0,
`context-async-hooks` 3.0.0, `core` 3.0.0, `resources` 3.0.0, `api` 1.10.0. `context-async-hooks` is a dependency
for hosts that want an active context. The hooks don't wrap step bodies, so this package parents every span
explicitly.

## Argo outbox

`ArgoOutbox.flush()` projects finished steps of finished runs (`argo_synced_at is null`) into Argo `usage_record`
rows and posts them through the `ArgoTransport` port. Production: `POST <ARGO_URL>/usage/records`, bearer
`ARGO_API_SECRET`, Argo's `UsageRecordInputSchema` (copied verbatim as `ArgoUsageRecordInput`).

- **After the record.** Only steps of runs whose `runPost` was delivered (`post_hooks_at`), so `raw` carries the
  run's wall time, trace id and friction.
- **No transaction spans a post.** A batch is claimed in one statement (`for update skip locked`, a random
  `argo_claim` token, `argo_claimed_until`), posted outside any transaction in chunks of up to 1000 (the claim is
  renewed before each chunk), then marked synced where the token still matches. Racing flushers never post the same
  claimed step; a crashed flusher's claim expires (2 min); a mark that matches fewer steps than claimed is warned.
- **Own pool.** The outbox has its own connection pool, so a slow or hanging Argo cannot starve the record's writes.
  A post that does not answer in `postTimeoutMs` (30 s) counts as transient.
- **Transient vs permanent.** Only a row refusal is permanent: a row that cannot be built, fails Argo's schema, or
  gets a 400/422. The batch is then re-posted step by step and only the bad step is quarantined (`argo_error`,
  logged, counted in `FlushResult.quarantined`); the rest keep flowing. Everything else is transient and releases
  the claim and backs off (5 s doubling to 5 min): 5xx, 408, 429, network errors, timeouts, redirects, and
  401/403/404, which mean a wrong secret or URL (logged as an error, since it needs a human, never quarantined).
- **Requeue.** `outbox.requeue({ runId? })` clears `argo_error` once the cause is fixed; the next flush posts them.
- **Close.** `outbox.close()` refuses new flushes and waits for the one in flight; `platform.close()` calls it
  before closing the outbox pool.
- **Crash after the post.** The rows are posted again; Argo's upsert on `(source, source_id, machine)` absorbs it.
- **No usage, no row.** Only steps with tokens or a cost are outbox candidates (the `steps_argo_outbox` index).
- **Scores ride in `raw.scores`** (`runs.scores`: the inline gate verdicts, and `final` once the run is scored),
  never as top-level fields. `raw.scorePass` and `raw.scoreError` make the final score explicit: a scorer error is
  `scorePass: null` with `scoreError: { kind: 'scorer' | 'infra', message }`, never a fail. A run scored after its rows were posted (regression, drift) puts its steps back into the
  outbox: the runtime's score write clears `argo_synced_at` and drops a claim in flight (that flush's mark then
  misses, and is warned), so the next flush re-posts the rows with the scores and Argo's upsert replaces them.
- **`https` only.** `httpArgoTransport` refuses a non-https `ARGO_URL` unless it is loopback, and posts with
  `redirect: 'error'` so the bearer never follows a redirect.
- **Machine id.** `AGW_MACHINE`; unset, the host name with a logged warning. It is part of Argo's upsert key, so it
  must stay stable across restarts and renames, or a re-post lands as a second row.
- **IU key label.** A `billing=iu` row carries a top-level `iu_key` (`personal` | `athena-team`), `null` for any
  other billing (usage-tracker contract, "IU keys"). Nothing in a model call says which key paid, so the label is
  stamped from the non-secret host env `IU_KEY_ID` (`parseIuKeyId`: unset or empty is `personal`; an unknown value is
  `personal` plus one warning) and never from key material. It belongs to the run: `iuKeyMiddleware` writes it to
  `runs.iu_key` at admission (`resume: false`), so an outbox that flushes after a restart with another key still
  posts the label the run started with; a run stored before the column reads `personal`. It is never in `raw` or
  `account` (the Max account id). Argo's schema gains the field per the contract; until then it strips it, and a
  missing field means `personal` there.
- **Off without config.** No `ARGO_URL`/`ARGO_API_SECRET` means no outbox, and the steps wait in Postgres.

| Run record / step | Argo `usage_record` | Note |
|-|-|-|
| — | `source` = `agent-workflows`, `grain` = `step` | |
| run id, step id, model | `source_id` = `<runId>:<stepId>:<model>` | one row per step and model (`usage_by_model`); usage reported without a model is the remainder, as `unknown` |
| workflow id | `sub_tool` | |
| step start (`steps.started_at`) | `ts` | |
| step finish − start | `duration_ms` | |
| model | `model`, `model_norm` | route table holds canonical ids |
| tokens input / output / cache read / cache write / reasoning | `input_tokens` = input − cache read − cache write, `output_tokens` = output − reasoning, `cache_read_tokens`, `cache_write_tokens`, `reasoning_tokens` | **additive contract** |
| cost | `cost_usd`, `cost_source` = `reported` (or `none` when unpriced) | |
| step failed/cancelled, or run `invalid_output` | `outcome` = `error` (else `ok`) | |
| — | `billing` = `iu`, `account` = null, `workspace` = `private`, `project` = null | `project` needs the caller's cwd (CLI, Wave 3) |
| — | `machine` = `AGW_MACHINE` (else the host name, warned) | part of Argo's upsert key; must be stable |
| run id, step id, root id, purpose, fingerprint, trace id, session id, tool calls, unpriced calls, run outcome, run wall ms, scores, friction | `raw` | Argo has no columns for them; `raw.scores` is null until scorers exist |

**Why normalise.** Provider usage is not additive. `output` includes reasoning, `input` includes cache reads and
writes. Argo
adds `reasoning_tokens` on top of `output_tokens`, so an unnormalised row counts reasoning twice
(`test/argo-rows.test.ts`).

## Token effect / cache effect

- **None at runtime.** (The friction counters read session messages after a step ends; they never write into a session.) The middleware adds no model-visible text and no tokens. Every hook runs outside the agent
  session.
- **Cache reads are recorded.** They stay visible (`tokens_cache_read`, `cache_read_tokens`), so a prompt-cache
  regression shows up as a fingerprint's falling cache share.
- **Cache writes are recorded.** They have their own bucket end to end (`Tokens.cacheWrite`, `tokens_cache_write`,
  `cache_write_tokens`), so a prompt that keeps rewriting the cache shows as write volume, not as fresh input.
- **Scores cost no tokens here.** They are read from the run row; a re-post after an after-the-fact score is one more
  Argo upsert per step, no model call.
- **A fingerprint change is expected to cost a cold cache once.** It means a changed `AGENTS.md`, skill, route or
  OpenCode version, and a changed prompt head misses the provider cache. Compare cache share by fingerprint before
  calling a prompt change cheaper.

## Tests

Real Postgres through the runtime's test support (`AGW_TEST_PG_URL`, a throwaway schema per file). Concurrency
runs through every test, never a single run:

| File | Covers |
|-|-|
| `platform.test.ts` | 18 concurrent top-level runs with a fan-out: run record, fingerprint, purpose, span tree; `runPost` re-delivery; `wall_ms` null for a never-started run; a fingerprint source blip retried; resume of 5 runs in a second "process" keeps the admission fingerprint and links a new run span in the same trace |
| `outbox.test.ts` | 24 concurrent runs (72 runs incl. children), two racing flushers, an Argo outage then recovery: every row exactly once, none lost; a hanging Argo with 24 concurrent runs: every record written, no connection held; poison rows quarantined; `runPost` gating; backoff; machine id |
| `friction.test.ts` | the document on every run, session sums and the highest repeat, every session of a step, a lost document rebuilt, `runPost` as a true recompute (stale events and steps gone, re-delivery changes nothing), `invalid_output` and re-ask steps, wallet refusal and runaway-cap failure, a failing or partial probe (incomplete, earlier entries kept, redelivered and completed), bounded probe concurrency |
| `telemetry.test.ts` | steps ended without `stepPost`, session id from the handle, redaction, the diag sink |
| `flush.test.ts` | subprocess with a fake OTLP receiver: SIGTERM and SIGINT re-raised after flush, crash exit 1, export failure and dropped spans logged |
| `fingerprint.test.ts`, `opencode-usage.test.ts`, `argo-rows.test.ts` | pure: stability, each input changes the hash, the OpenCode conversion, the additive projection |

The OpenCode message fixtures are shaped from the measured sources S2 points at, not from S2 itself. Every S2
prompt wedged, so it captured no session. The sources are usage-tracker's live-schema message and agent-gateway's
v2 probe (`test/fixtures/opencode-messages.ts`).

# @agent-workflows/runtime

The workflow runtime: `defineWorkflow`, a step journal on Postgres, and resume after a crash or a deploy
(concept §3, §4 Durability and Control). The design and its measurements are in
`docs/spikes/s1-runtime/REPORT.md`; this package is the Wave 2 build of it.

## Shape

```ts
const review = defineWorkflow({
  id: 'review.pr',
  version: '2026-10-27.1',
  input: z.object({ pr: z.number() }),
  output: z.object({ verdict: z.string() }),
  concurrency: 2,
  async run(ctx, { pr }) {
    const diff = await ctx.step('diff', () => fetchDiff(pr), { retry: { attempts: 3 } })
    const verdict = await ctx.agent('review', { agent: 'reviewer', prompt: brief(diff), output: z.string() })
    await ctx.effect('comment', (key) => postComment(pr, verdict, { idempotencyKey: key }))
    return { verdict }
  },
})

const runtime = new Runtime({ connectionString, workflows: [review], host, middleware })
await runtime.open()
const { runId } = await runtime.start(review, { pr: 42 }, { purpose: 'prod' })
const result = await runtime.wait(runId)
```

| Call | Kind | Notes |
|-|-|-|
| `ctx.step(id, fn, opts?)` | code | `fn({ key, attempt, signal, addUsage, progress })` |
| `ctx.effect(id, fn(key, scope), opts?)` | effect | `key = ${runId}:${stepId}`; pass it to the outside API, the only thing that makes a re-run after an in-doubt kill a no-op |
| `ctx.agent(id, spec)` | agent | through the `AgentHost` port; output validated against `spec.output` |
| `ctx.workflow(id, wf, inputs)` | workflow | fan-out; returns `(O \| null)[]`, a failing child yields `null`; children run as `${runId}/${id}/${i}` under the parent's lease, never by recovery |

- **Step ids are string literals** and unique per run (a duplicate fails the run). `test/step-id-literal.test.ts`
  lints `packages/**/src` for computed ids. A change to a step's meaning or output shape takes a new id.
- **Step outputs are `Json`** (no `undefined`, `Date`, `bigint`, class instances, NUL or lone surrogates): a
  replayed value deep-equals the original (jsonb does not keep key order). Anything else fails the step as
  `non_json_output`.
- **Usage** from `addUsage` (a capability's usage passes as is) is summed per step and model; reports without a
  price count as `unpricedCalls`, so a partially priced step is visible instead of a silent undercount. Tokens
  are raw provider counts: `input` includes cache reads and writes, `output` includes reasoning; `cacheWrite` is
  optional on a report (absent means 0) and always present on the sums (`tokens_cache_write`).
- **Idempotency key.** `start({ idempotencyKey })` returns the same run for the same workflow, key and input; the same key with a
  different input throws `IdempotencyConflict` (the first run stands). `getRun(runId)` reads a run's state; `ping(timeoutMs)`
  is a bounded health probe: it rejects at the bound and a stalled query's connection is destroyed, not parked on the pool.
- **Retry** per step: `{ attempts, backoffMs, factor, maxBackoffMs }`, default one attempt (agent steps too).
- **Idle timeout** per step: no `progress()` (or host progress event) for `idleTimeoutMs` fails the attempt as
  `timeout`. Agent steps default to 5 minutes; code steps have none. It is never a wall-clock cap
  (rules/agent-limits.md): a step that keeps reporting progress runs as long as the work takes.
- **Cancel** (`runtime.cancel(runId)`, any process): pending runs end `cancelled` at once; a running run gets
  `cancel_requested_at`, and the process holding its lease (or the next one to claim an orphan) aborts the step's
  signal, calls `host.abort` on every running agent session of the tree (`host.abort` must be idempotent), ends
  the run and its children `cancelled` and calls `runPost`. **Steer** (`runtime.steer(runId, stepId, text)`) is
  journaled in `signals` and delivered to the running agent step via `host.steer(handle, text, { signalId })`, where `signalId` is the journaled row's id. Delivery is at least once (a crash between the send and the delivery mark sends it again), so a host that can dedupes on `signalId`; the argument is optional, so a host that ignores it still works.

## Durability

- Journal in its own schema (`schema`, default `agw`): `runs`, `steps`, `signals`, migrated from
  `src/migrations/NNNN_*.sql` in one transaction under an advisory lock, recorded in `schema_migrations`. The
  run-record columns (fingerprint, tokens, cost, `unpriced_calls`, `tool_calls`, friction) and the Argo outbox
  columns on steps (`argo_synced_at`, `argo_claim`, `argo_claimed_until`, `argo_error`, migration 0002) exist for
  the middleware to fill. A merged migration is never edited; changes take the next number.
- **Lease:** one `pg_try_advisory_lock` per top-level run (64-bit key from sha256), held on a dedicated
  connection budget sized `maxConcurrentRuns` (plus one reserved for `runPost` re-delivery), never the journal
  pool. Beyond the budget runs stay pending. Recovery skips runs whose lock is visibly held (`pg_locks` against
  `runs.lock_key`), so every page it reads is claimable.
- **Body grace:** an aborted step body may still be running (an outside call cannot be recalled). The lease is
  held until the tree's abandoned bodies settle, up to `bodyGraceMs`; when the lease connection itself is lost, the
  next process waits out the same grace (from the step's last start) before running a resumed effect again. The
  lease is re-checked right before an effect body starts and before an agent prompt is sent.
- **Fencing:** claiming a run writes a fresh `lease_token`; every journal write of the run tree carries it in its
  `where` (`for share` on the root row), and a lost lease connection aborts the run at once. Exempt, on purpose:
  the delivery markers `post_hooks_at` and `signals.delivered_at` (idempotent; a stale write only causes one more
  at-least-once delivery) and the cancel and steer requests, which any process may make.
- **Infra vs workflow errors:** a journal or lease failure leaves the run `running` and retries it with backoff;
  only step-body errors mark `failed`.
- **Poison runs:** `runs.drives` counts every start and every claim of a running run (crashes, deploys, infra
  retries) in the claim statement itself, so the cap survives restarts: past `maxDrives` the run fails as
  `crash_loop` instead of taking every new process down with it.
- **Re-attach order:** open the session, journal the handle, prompt, journal `prompted`. On resume a prompted
  handle waits, an unprompted one prompts, none opens a new session. The prompt is sent before `prompted` is
  journaled, so a crash between the two re-sends it on resume: exactly-once delivery relies on
  `AgentHost.prompt` being idempotent (it checks the session's messages first, concept §3). A failed attempt's
  handle is cleared from the journal at once, so a crash during the retry backoff opens a fresh session.
- **Deploys need no drain:** SIGTERM → `runtime.close()` (rows stay `running`, agent sessions keep going) →
  the next process re-attaches and continues on the new code. `version_started` / `version_finished` show runs
  that crossed a deploy.
- Recovery ticks every `recoveryIntervalMs`, backing off on failure, and claims pending and orphaned runs whose
  lease is free. Per-workflow `concurrency` keeps excess top-level runs pending.
- Journal and lease connections carry connect, query and statement timeouts, so a hung database call fails as an
  infra error instead of stalling a tick.

## Middleware

An ordered list of `{ name, runPre, stepPre, toolPre, toolPost, stepPost, runPost }` given to the `Runtime`, so
no workflow can skip it.

- `runPre` runs after the run took its concurrency slot. `resume` is false until a `runPre` pass accepted the run
  (`admitted_at`), so admission fires once per run. Throwing (`AdmissionRefused` for a clean refusal) fails a new
  run before its body runs; on resume it is logged and ignored.
- `stepPre` gets `replay`; throwing fails the step as `middleware`.
- `toolPre` throwing fails the step it runs in (`ToolRefused`): the step's signal aborts (the agent session is
  aborted), the step ends with the thrown `WorkflowError`'s kind (else `middleware`) and is not retried. A throwing
  `toolPost` is logged.
- `stepPost` carries `handle`: the agent handle the execution last used (also after a failed attempt cleared it
  from the journal), null for other kinds.
- Post hooks run after the commit: a throw is logged and never changes the recorded outcome.
- `runPost` is at least once: `post_hooks_at` records delivery, and recovery re-delivers it for ended runs
  without it (a kill between the terminal write and the hooks, a run cancelled while pending, a hook that threw),
  under the root's lease so no live driver races it. Every hook runs on each delivery, so hooks are idempotent. A
  run whose hooks keep throwing is marked delivered after `maxPostHookAttempts` (default 5,
  `runs.post_hooks_attempts`) and logged, so it cannot loop.

## Bounded runs

A run lasts seconds to tens of minutes. There is no API to wait for days: anything that lives longer (a factory
Issue, a human approval) is an entity state machine that *starts* workflows. This keeps the mixed-version
window of a deploy small and keeps every run's journal short.

**Token effect / cache effect.** The runtime adds no model-visible text and no tokens of its own. Re-attach
waits on the existing session instead of re-prompting, so a crash or deploy costs no repeated prompt and keeps
the provider's prompt cache warm; only a kill between session create and handle journal leaves one orphan
session that was never prompted (no tokens). A retried agent step after an idle timeout opens a fresh session:
a full prompt again and a cold cache, which is why agent steps default to no retry.

## Tests

Real Postgres, never mocks: `AGW_TEST_PG_URL` must be set (`make check` builds it on the mini via
`secrets-run` from `.env.test.tpl`; CI runs a `postgres:18` service). Every test file uses its own throwaway
schema. `test/kill/` is the S1 kill harness as a regression test: worker subprocesses kill themselves at every
step boundary and mid-step, deploy onto changed code, and drive 25 concurrent runs through a kill.

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
| `ctx.score(id, value)` | code | the workflow's `scorer` on `value` (`source: inline`); the verdict is also kept on the run (`runs.scores.gates[id]`). A resume returns the journaled verdict, never scores again |
| `ctx.continue(id, from, prompt, opts?)` | agent | a follow-up turn in the SAME session as an earlier agent step (`from`: its output object, or its step id); output validated against `opts.output`, else that step's schema |
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

## Scores (concept §6)

One scorer per workflow, used three ways: the inline gate (`ctx.score`), regression (`agw eval run`) and drift
(sampled production runs). The workflow carries it:

```ts
const draftScorer: Scorer<Input, Reference> = {
  version: '2026-10-28.1',              // recorded with every verdict; compare reports mixed versions
  reference: z.object({ expected: z.string() }), // validates a regression case's reference
  score(input, output, { source, reference, judge, signal }) {
    return { scores: { valid: 1, recall: 0.5 }, pass: true, feedback: 'name the file' }
  },
}
defineWorkflow({ id: 'research.report', scorer: draftScorer, async run(ctx, input) {
  let draft = await ctx.agent('research', { agent: 'researcher', prompt, output: Draft })
  const verdict = await ctx.score('gate', draft)
  if (!verdict.pass) draft = await ctx.continue('research:reask', draft, verdict.feedback ?? 'Try again.')
  return draft
} })
```

- **Shape.** `score(input, output, ctx) → { scores: Record<string, number>, pass, feedback? }`, checked on return
  (finite numbers, boolean `pass`; else the step fails `invalid_output`). Scores are higher-is-better, ideally in
  [0, 1], so `agw eval compare` reads every one the same way. `output` is the value a gate checks, or a run's final
  output (`null` for a failed run: a failed run scores as a miss). The scorer validates it itself: "is it even valid"
  is a score. An object, not a bare function: `version` and the `reference` schema travel with it.
- **Deterministic first.** An LLM-judged sub-score goes through `ctx.judge(capability, input)` only: the runtime's
  `judge` option (a capability caller the host passes). Regression and drift get it when the runtime has one; the
  inline gate only when the scorer sets `judgeInline`, so the gate stays free by default. The judge's usage lands on
  the gate step; regression and drift score outside any step, so the caller gets the `source` and the scored `runId`, and
  the host records those calls as runs of their own, keyed per scored run (host `judge.ts`). No default scorer judges.
- **`ctx.score(id, value)`** is a code step: its verdict is journaled, and a resumed run returns it without calling the
  scorer. The verdict is written onto `runs.scores.gates[id]` inside the step, so a crash after the body re-writes
  the same key.
- **`ctx.continue(id, from, prompt, opts?)`** is an agent step on the session of an earlier agent step, through the
  host's `followUp(handle, { runId, stepId, key, attempt })`: it returns the handle of a new turn, journaled like any
  agent handle, then `prompt` and `wait` run on it as on a first turn (re-attach included). `from` is an object an
  earlier `ctx.agent`/`ctx.continue` of this drive returned (by identity; a resume re-runs them before) or that step's
  id (a text answer is a string, so it needs the id). A retry after a failed attempt asks for a new turn (`attempt`
  keys it), never re-reads the failed one. A host without `followUp` fails the step. Step ids stay literals: the §3
  example's `ctx.continue(draft, feedback)` reads `ctx.continue('research:reask', draft, feedback)` here.
- **Naming: `<stepId>:reask`.** A continue step is named after the agent step it re-asks: `'<stepId>:reask'`, and
  `'<stepId>:reask:<n>'` for the n-th re-ask of the same step (n from 2). The friction counters (`w5/friction`) do not
  key on the name: a schema miss is counted once, at the agent step's `invalid_output` failure, and a `:reask` step adds
  nothing unless it fails `invalid_output` itself.
- **After the fact.** `runtime.scoreRun(runId, { source: 'regression' | 'drift', reference?, caseId?, evalRunId?,
  args?, onlyUnscored? })` scores a `done` or `failed` run with its workflow's scorer and writes `runs.scores.final`,
  `score_source`, `scored_at` (migration 0004). A judge call that fails (even one the scorer caught) or a journal
  error is rethrown and nothing is written except one more `runs.score_attempts` and `last_score_attempt_at`; drift
  retries the run only after a backoff of `SCORE_BACKOFF_MS` (1 h) doubling per attempt, and runs with failed attempts
  sort last, so they never starve newer ones. The `MAX_SCORE_ATTEMPTS`th (5, ~15 h of outage) records an `infra`
  scorer error; a scorer that fails on its own (a bug, a reference it refuses, a malformed verdict) records a `scorer`
  one: `{ scores: {}, pass: null, error, errorKind }`, `runs.score_error`, `runs.score_error_kind`. Neither is a
  verdict: eval summaries and compare leave them out. Drift re-scores an `infra` error a day after its last attempt
  (keeping its count, so one judge call a day) and a `scorer` error once the workflow's scorer version changes; two
  hosts on different scorer versions would re-score each other's errors back and forth (accepted: one host per
  deploy). Both re-scores back off like unscored runs (doubling from the last attempt), so a failing one is never
  reselected every tick. Workflows without a scorer are never in that branch. A shutdown is rethrown uncounted. `onlyUnscored` makes the write first-writer-wins. The write also clears `argo_synced_at` (and a
  claim in flight) on the run's steps, so the Argo rows are re-posted with the scores in `raw`.
- **Drift's sample.** `runtime.driftCandidates({ rate, since, limit, purposes? = ['prod'], workflows? })`: done,
  unscored top-level runs whose persisted sample position `runs.drift_sample` (a generated column: the first 32 bits
  of md5(id)) is below rate × 2^32. Deterministic per run: the same in every tick and process, and a smaller rate is a
  subset of a larger one. The partial index `runs_drift` holds only unscored done top-level runs, by sample position,
  so a tick reads the sampled range and never rescans the unsampled 90 %.
- **Reads for eval**, narrowed in SQL: `runtime.scoredRuns({ workflow, source, runIds?, fingerprintPrefix?, args? })`
  (the prefix is a byte-order range on `fingerprint collate "C"`, which the `runs_scored` index serves)
  (`args` by jsonb equality, `{}` for runs that recorded none; only the record columns compare uses),
  `runtime.runByKey(workflow, idempotencyKey)` (a resumed eval adopts a case run with its status and score) and
  `runtime.recentCost(workflow)` (the eval estimate).

## Durability

- Journal in its own schema (`schema`, default `agw`): `runs`, `steps`, `signals`, migrated from
  `src/migrations/NNNN_*.sql` in one transaction under an advisory lock, recorded in `schema_migrations`. The
  run-record columns (fingerprint, tokens, cost, `unpriced_calls`, `tool_calls`, friction, `scores`) and the Argo outbox
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

**`agentPrompt`** (`RuntimeOptions`, optional): called once per attempt with `{ agent, prompt }` (the step's `prompt`, without its optional `tail`, which is appended after the hook's result so a retry directive stays last) right before a session is
opened or prompted, and not at all when the step re-attaches to a prompted session. Its result is what the host session
receives; the journaled step spec is unchanged. The platform host uses it to append an agent's active learned facts after
the task message. A throw is logged and the original prompt is sent. Migration `0005_learnings.sql` adds the per-agent
learnings table the host reads (`packages/host` README, §Retrospective and learnings); the runtime itself never reads it.

**Token effect / cache effect.** The runtime adds no model-visible text and no tokens of its own (an `agentPrompt` hook, when
the host sets one, adds its own text after the task, so an agent's cached `AGENTS.md` prefix is untouched). Re-attach
waits on the existing session instead of re-prompting, so a crash or deploy costs no repeated prompt and keeps
the provider's prompt cache warm; only a kill between session create and handle journal leaves one orphan
session that was never prompted (no tokens). A retried agent step after an idle timeout opens a fresh session:
a full prompt again and a cold cache, which is why agent steps default to no retry. `ctx.score` adds no tokens with
the default (deterministic) scorers; a judged sub-score costs its capability call. `ctx.continue` is the cheap nudge:
the follow-up turn rides the existing session, so the history is a warm prompt-cache prefix and only the feedback is
new input; a fresh session would pay the whole prompt again.

## Tests

Real Postgres, never mocks: `AGW_TEST_PG_URL` must be set (`make check` builds it on the mini via
`secrets-run` from `.env.test.tpl`; CI runs a `postgres:18` service). Every test file uses its own throwaway
schema. `test/kill/` is the S1 kill harness as a regression test: worker subprocesses kill themselves at every
step boundary and mid-step, deploy onto changed code, and drive 25 concurrent runs through a kill.

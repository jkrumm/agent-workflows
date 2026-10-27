# Spike S1: workflow runtime

**Verdict: build our own journal on Postgres.** It passed every kill and deploy scenario, recovered in 0.1–0.2 s and re-attached the agent step. Both libraries fail the same requirement: on a redeploy, in-flight runs must keep going without an operator. On a crash, Vercel Workflow's Postgres world also leaves a run stuck until a 4 h lock expires.

Date: 2026-10-27. Input to concept §12.4 and Wave 2. Code, harness and the raw table are in this directory. One command reproduces the table (§Reproduce).

## Question and setup

Which runtime carries `defineWorkflow` (concept §3, §4)?

| Candidate | Version | Licence |
|-|-|-|
| (a) own journal | 163 lines in `candidates/own/runtime.ts`, `pg` 8.23.1 | ours |
| (b) Vercel Workflow | `workflow` 5.2.3, `@workflow/world-postgres` 5.0.5 (graphile-worker 0.16.6) | Apache-2.0 |
| (c) DBOS TypeScript | `@dbos-inc/dbos-sdk` 5.3.0 | MIT |

All three run on Bun 1.4.3 against the mini's Postgres 18, each in its own schemas of database `spike_s1`.

Library facts come from research-gateway job `b57e893a-e0dd-4faa-b609-2b8ae4169451` (deep, status ok, 210 citations), checked against the installed packages. Where the research and the installed code disagreed, the measurement decided (see DBOS versioning below).

**One fake workflow, the same step bodies for every candidate** (`common/world.ts`):

1. `prepare`: a code step.
2. `agent.open`: creates a fake OpenCode session and journals its id.
3. `agent`: prompts the session and waits 60 s. The fake server is a row in Postgres that keeps running while the worker is dead, so a resume re-attaches by session id.
4. `effect`: inserts into `harness.effects` with a unique key from the engine's (run, step) identity, then holds the in-doubt window open for 1.5 s.
5. Fan-out of 3 child workflows; child 1 fails and becomes `null` in the parent (failure split, §3).
6. `finish`: writes the outcome and the code version that ran it.

Each candidate uses its own idiom: `ctx.step`/`ctx.agent`/`ctx.effect`/`ctx.children`, `DBOS.runStep` plus `DBOS.startWorkflow`, and `"use step"` functions plus `start()` with the documented hook-based `startAndWait` for children.

**Kill harness** (`harness/measure.ts`). The worker kills itself at an exact probe (`KILL_AT`); the harness waits 2 s and starts a fresh process.

- **Boundary kills** (`b-*`): SIGKILL at the start of `agent.open`, `effect`, the first child and `finish`.
- **Mid-step kills** (`m-*`):
  - between `prepare`'s end and its journal write (the in-doubt window);
  - `agent` at 30 s;
  - `effect` after its insert;
  - a child at 0.5 s.
- **Deploys:** SIGTERM, then restart from a copied source tree with a real code change: the version literal in the workflow body. Three shapes:
  - `deploy`: a compatible change, SIGTERM 30 s into `agent`.
  - `deploy-break`: a new step `audit` inserted after `agent`, SIGTERM 30 s into `agent`, so the run has not reached the insertion point yet.
  - `deploy-break-late`: the same insertion, SIGTERM at fan-out, after `effect` is already recorded.
- **DBOS only:** both deploys again with `DBOS__APPVERSION` pinned.

One run per scenario and candidate. "Stuck" means no outcome 180 s after the last restart.

## Results

Full output: `results/results.md`, `results/results.json`. Summary from the final run (60 s agent step, 14 scenarios, 1631 s wall):

| metric | own | DBOS | Vercel |
|-|-|-|-|
| scenarios ok | **12/12** | 10/14 | 7/12 |
| completed steps re-executed after a kill | 0 | 0 | 0 |
| in-doubt re-runs (kill between step end and journal write) | 1 | 1 | 1 |
| duplicate effects | 0 | 0 | 0 |
| effect retries absorbed by the key | 1 | 1 | 1 |
| agent step wall after SIGKILL at 30 s | **60.2 s** (re-attached) | **60.2 s** (re-attached) | stuck, see below |
| agent sessions created in that scenario | 1 | 1 | 1 |
| median recovery, restart to first step activity | **0.1 s** | 1.3 s | 1.2 s |
| deploy, compatible change | finished on v2 | **stranded** (PENDING) | finished on v2 |
| deploy, step inserted ahead of the run's position | finished on v2-break | stranded | finished on v2-break |
| deploy, step inserted before recorded steps | finished on v2-break | stranded | **`CORRUPTED_EVENT_LOG`** |
| DBOS pinned version: compatible / inserted before recorded | - | finished on v2 / **`ERROR`** | - |
| middleware run/pre, step/pre, step/post, run/post | native, all 4; run/pre re-fires on every recovery | wrapper; run/pre re-fires on every recovery | step wrapper; run/pre is an extra step; run/post fire-and-forget |
| LOC: runtime / workflow + wiring | 163 / 39 | 0 / 50 | 40 / 83 |
| dependencies direct / transitive | 1 / 14 | 1 / 22 | 2 / **358** |
| install size | 0.5 MB | 10.3 MB | **190 MB** |
| Postgres tables / indexes | 2 / 2 | 13 / 38 | 15 / 32 (9 world, 1 drizzle ledger, 5 graphile) |
| Postgres kB per run (engine tables / runs) | 12 | 63 | 121 |
| happy path wall | 64.4 s | 65.2 s | 65.8 s |

Postgres restarts by the parallel P0b work: none hit the final run. One restart hit the first Vercel smoke run, and graphile-worker reconnected without losing it. The harness re-runs any scenario whose log shows a server restart (`pgBlip`).

### (a) Own journal

All 12 scenarios passed, with zero completed steps re-run. The one in-doubt re-run is the expected one: `prepare` was killed after its body and before its journal write.

- **Effects.** `m-effect` shows the key at work: the effect committed, the step re-ran, and the unique key absorbed the retry. One row.
- **Lease.** It is `pg_try_advisory_lock` on a held connection. Postgres drops the lock when the dead process's socket closes, so recovery takes 0.1–0.2 s with no heartbeat and no expiry.
- **Deploy.** The journal is keyed by step id, not by position, so a new process continues the run on the new code:
  - A compatible change finishes on v2.
  - An inserted step runs when the run reaches it.
  - In `deploy-break-late`, `audit` ran after the already-recorded `effect`, and the run finished on v2-break.
- **Middleware.** All four interception points sit in the runtime with no library to fork. `run/pre` and `run/post` fire per run, including each child run (4 per happy path: parent plus 3 children). `step/pre` carries a `replay` flag; `run/pre` has none yet. `execute()` calls `runPre` on every drive, so `run/pre` re-fires on each recovery exactly like DBOS (5 instead of 4 in the kill scenarios).

### (b) Vercel Workflow on Bun

- **Bun works with integration work.** There is no Bun guide beyond the framework-author page, which uses Bun as its example. We wrote a 22-line `Bun.plugin` that runs `@swc/core` with `@workflow/swc-plugin` (preloaded via `bunfig.toml`), ran `workflow build` (6 s, a 9.4 MB `flow.mjs`), and served the flow route from `Bun.serve`. The happy path passed the first time. We saw no Bun-specific failure; the one recorded Bun bug (#4555, `Agent.compose is not a function`) is fixed.
- **A SIGKILL during a step leaves the run stuck for 4 hours.** This happened in `m-agent`, `b-fanout`, `b-finish` and `m-child`.
  - The step's graphile-worker job stays locked by the dead worker. graphile-worker hard-codes a 4 h job expiry (`graphile-worker/sql/000004.sql`, `interval '4 hours'`).
  - On start, the world calls `reenqueueActiveRuns`, which replays the run. The replay then waits on the step, which is `running` and locked.
  - Proof by `harness/vercel-lock-probe.ts`, which `measure` runs last: back-dating the locks by 5 h and starting one worker for 120 s finished the stuck `m-agent` run (column "after lock probe"). It re-attached to the same session (checked on an earlier run: 1 session, 2 `agent` starts).
  - `b-fanout` and `b-finish` finished later, while a later scenario's process ran (column "status at end"). The mechanism was not isolated.
  - So re-attach itself works; crash recovery does not, within any useful time. Kills at the very start of a step sometimes recovered (`b-agent` and `b-effect` in both full runs, `b-fanout` in one of two), presumably when the step job had not been claimed yet.
  - A graceful SIGTERM lets graphile release its jobs, so the SIGTERM deploys recovered in 1.1–1.5 s.
- **There is no deployment pinning on the Postgres world.** The docs promise that runs stay pinned to their deployment, but that is a Vercel-world feature (`VERCEL_DEPLOYMENT_ID`); the Postgres world has no versioning section, and research flagged the same gap. Measured:
  - A new process replays in-flight runs on the new code. A step inserted before recorded ones fails the run with `CORRUPTED_EVENT_LOG`.
  - `reenqueueActiveRuns` re-enqueues every active run, not only its own. A deploy therefore replays, and can corrupt, any other run in flight. Here a v2-break process corrupted the stuck `m-child` run from an earlier scenario (column "status at end").
- **Middleware.**
  - `step/pre` and `step/post` need a wrapper inside every `"use step"` body.
  - `run/pre` must be a step, because the workflow body is a sandboxed VM without I/O; that costs an event.
  - `run/post` exists only as `registerLifecycleHooks`, which is fire-and-forget and best-effort, and does not fire for a cancel from the CLI.
  - Our `ctx.step(id, fn)` shape cannot be layered on top without code generation, because steps must be named functions carrying the directive. Closures as steps were not tested.
- **Footprint.** `workflow` pulls every framework integration (next, nuxt, nest, astro, sveltekit, …) plus `@swc/core` (28 MB native): 358 packages and 190 MB. Children need the documented hook handshake, about 30 of the 83 workflow lines.

### (c) DBOS on Bun

- **Resume and re-attach are correct.** All 9 kill scenarios passed; the agent step re-attached (60.2 s, one session).
- **Bun works.** Bun is unofficial: Node ≥ 20 only, and CI runs no Bun job. The only noise was a `pg` deprecation warning from DBOS's own code ("Calling client.query() when the client is already executing a query"), which becomes an error in pg@9.
- **A deploy strands the run under the default version.**
  - In 5.3.0 the default application version is an md5 of the registered workflow sources (`computeAppVersion`, recorded as `af1403aa…` for v1). Research read the launch path as `''`; the installed code and the recorded rows say hash.
  - Any edit to a workflow body therefore changes the version. The new process recovers only its own version, so the in-flight run sits `PENDING`.
  - The stranded `deploy` run finished later, on the **old** code, when the next scenario booted a v1 process (status at end: `SUCCESS`). That is the documented blue-green model: old-version processes drain old runs. On one mini with one `host` process it means a drain, which is exactly what concept §3 removes ("replaces today's 30-minute drain").
- **Pinning makes compatible edits survive, but an inserted step fails.**
  - With `DBOS__APPVERSION` pinned, a compatible edit finishes on v2.
  - A step inserted before recorded ones ends `ERROR` (replay is positional: `function_id` order). `DBOS.patch()` exists for this, but every such edit then needs a manual patch branch.
- **Middleware.** `registerLifecycleCallback` covers launch and shutdown only. A `step()` wrapper around `DBOS.runStep` gives `step/pre` and `step/post` without a fork. `run/pre` and `run/post` in the workflow body re-run on every recovery (2 instead of 1 in the kill scenarios) unless each becomes a checkpointed step.
- **Footprint.** 13 tables and 38 indexes it owns and migrates. The prior-art spike adds `max_recovery_attempts` dead-lettering after 100 crash-loop recoveries (not re-measured here).

## What the winner means for Wave 2

**`defineWorkflow`.** Concept §3 shape, backed by this runtime:

- `ctx.step(id, fn)`, `ctx.agent(id, spec)`, `ctx.effect(id, fn(key))`.
- `ctx.workflow(id, wf, inputs[])` for fan-out: it returns `(O | null)[]`, so a failing child yields `null`.
- `ctx.score` and `ctx.continue` are steps of kind `code` and `agent`.

Middleware is an ordered list of `{runPre, stepPre, stepPost, runPost, toolPre, toolPost}` objects. The runtime calls it, so no workflow can skip it. `runPre` gets a `resume` flag (true when the run row was already `running`), matching `stepPre`'s `replay`. Admission rules (auth, wallet gate, concurrency) act only on `resume: false`; telemetry reopens its span on either.

**Journal schema sketch** (the spike's two tables plus the run-record columns of §5):

```sql
runs  (id text pk, workflow text, parent_id text null, status text,  -- pending|running|done|failed|cancelled
       input jsonb, input_hash text, output jsonb, error text,
       fingerprint text, version_started text, version_finished text,
       trace_id text, wall_ms int, tokens_*, cost numeric, friction jsonb,
       created_at, updated_at)
steps (run_id text, step_id text, kind text,                   -- code|agent|effect|workflow
       status text, handle jsonb, output jsonb, error text, attempts int,
       tokens_*, cost numeric, tool_calls int, started_at, finished_at,
       primary key (run_id, step_id))
```

**Effect keys.** The key is `${runId}:${stepId}`, handed to the effect function, which passes it to the outside API. The spike proves the key is what prevents the duplicate: the step does re-run after an in-doubt kill. An effect without a key has no recovery.

**Re-attach.**

1. Create the OpenCode session.
2. Write `handle = {sessionId}` to the step row.
3. Then prompt.

On resume:

- A handle with a prompt already sent: wait on the session.
- A handle without a prompt: send the prompt.
- No handle: create a new session. The old one is an orphan that was never prompted, which is harmless.

The prompt send must be idempotent: check the session's messages before sending. The fake server's `prompted_at is null` guard stood in for that check here.

**Lease.** One `pg_try_advisory_lock` per top-level run, on a held pool connection. This is the fastest recovery measured (0.1 s) and needs no heartbeat.

- Hold leases on a separate connection budget, not on the journal pool (see Risks: pool deadlock).
- Use a 64-bit key instead of `hashtext` (32-bit, collisions possible).
- Child runs are driven by their parent's step, not by recovery, so a child never runs twice in parallel.

**Versioning and the bounded-run rule.**

- Replay is by step id. A deploy continues in-flight runs on the new code, and `runs.version_started` / `version_finished` record when a run crossed a deploy.
- The rule that keeps this safe: **a change to a step's meaning or output shape takes a new step id**. Removed steps are ignored and new steps run when reached.
- Bounded runs (seconds to tens of minutes, §3) keep this window small. Nothing waits for drained versions, and no long-lived run accumulates divergence.
- A deploy needs no drain: SIGTERM, restart, re-attach.

**Still to build, not in the spike:**

- step retry policy and step timeout (Control row of §4);
- cancel and steer;
- per-workflow concurrency limits;
- OTel spans and the run record;
- a periodic recovery tick with backoff for runs whose lock holder is alive but stuck.

## Risks

- **We own correctness.** Lease, journal writes and child driving are ours to get right. Mitigation: Wave 2 keeps this kill harness as a regression test against the real runtime, extended with concurrent runs.
- **Mixed-version runs.** A run that crosses a deploy runs half on old code and half on new. The step-id rule and the version columns make this visible, but nothing enforces the rule. A lint can check: a changed step body with an unchanged id plus a changed output schema means warn.
- **Pool deadlock.** The spike takes each run's lock connection from the same `Pool` (max 20) as every journal query. The 20th concurrent run therefore holds the last connection, and every journal query waits forever: `pg` queues pool checkouts without a timeout. The spike never ran more than one top-level run at a time, so it did not hit this. Wave 2 holds leases on a separate connection budget: a dedicated lease pool sized to the per-process concurrency limit, with admission refused beyond it. The alternative is a `lease_until` column with a heartbeat, which needs no held connection at all.
- **Non-determinism is the author's job.** There is no replay check like DBOS's: a step id computed from data that changes between attempts silently creates a new step. The API should take literal ids, with an index suffix only through `ctx.workflow` fan-out.

## What was not measured

- **Repetition and statistics:** one run per scenario per candidate, so there are no distributions.
- **Load:** concurrency, throughput, many simultaneous runs, memory and CPU.
- **Failure modes:**
  - Postgres restarts mid-run (only incidental, once, in the Vercel smoke run);
  - network partitions;
  - a crash loop (DBOS dead-lettering; our runtime has no counter yet).
- **Real OpenCode.** The fake server models re-attach semantics only, not session or event-stream behaviour.
- **Vercel Workflow:**
  - on Node, which would separate Bun issues from world issues; the 4 h lock is graphile's design and does not depend on the runtime;
  - with `@workflow/world-local`;
  - with a lower graphile job expiry, which the Postgres world does not expose;
  - closures as steps.
- **DBOS:** queues, `DBOS.patch()`, `forkWorkflow`.
- **Tool-level interception** (`tool/pre`, `tool/post`): it belongs to the agent step and OpenCode, not to the runtime choice.

## Reproduce

```sh
cd docs/spikes/s1-runtime && bun install && bun run measure     # ~27 min, prints the tables
bun run measure --agent-ms 6000 --only own --scenario happy,m-agent   # quick subset
```

Credentials come from the environment (`SPIKE_PG_URL`, or `POSTGRES_USER` and `POSTGRES_PASSWORD`). Without them, the script re-executes itself under `secrets-run` with the dev template.

The script drops and recreates only its own schemas inside database `spike_s1`: `harness`, `own`, `dbos`, `workflow`, `workflow_drizzle` and `graphile_worker`. It refuses to run against any other database.

Layout:

| Path | Contents |
|-|-|
| `common/` | the fake world: probes, agent server, effects |
| `candidates/{own,dbos,vercel}/` | the three implementations |
| `harness/` | measure, footprint, reset, the lock probe |
| `results/` | the last full run |

Spike code is thrown away, not promoted (PLAN.md).

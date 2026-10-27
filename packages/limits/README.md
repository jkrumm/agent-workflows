# @agent-workflows/limits

Two middleware rules for the Money row of concept §4 (D5, N8). Limits teach, they don't interrupt: budgets
are report-only, **only a runaway cap far above normal stops a run**, and the **wallet gate** refuses optional
expensive work **at admission, never mid-run**.

```ts
import { runawayCap, walletGate } from '@agent-workflows/limits'

const cap = runawayCap({ connectionString, schema: 'agw', onDecision })
const wallet = walletGate({ workflows: ['review.ocr'], onDecision })
const runtime = new Runtime({ connectionString, workflows, middleware: [wallet, cap] })
// on shutdown, after runtime.close():
await cap.close()
```

## Runaway cap

`runawayCap(options)` → `Middleware & { caps(workflowId), queries, close() }`.

- **Caps per workflow** on four metrics: cost (USD), tokens (input + output + cache read + reasoning), wall time
  and step count. The cap is `factor × p95` over the workflow's own latest `window` `done` runs, read from the
  journal with its own pool of 2 on the runtime's connection string and schema. The latest runs are selected first,
  then joined with `steps`. A learned cap never drops below a floor, so a workflow whose p95 is a 30 ms code run
  keeps headroom.
- **Per root run tree**: cost, tokens and wall time add up over the whole tree, fan-out children
  (`ctx.workflow`) included. Every run in the tree is checked against the **root** workflow's caps, which are
  learned from its top-level runs, each summed over its tree. **Step count stays per run**, checked against the run's
  own workflow, which learns it from all its runs, each counted on its own.
- **Below the sample minimum** a static ceiling applies: the per-workflow `ceilings[id]` merged over
  `defaultCeiling`.
- **The hooks never wait on the journal.** Caps are cached per workflow for `ttlMs`. A stale entry is served at once
  while one refresh runs in the background (stale-while-revalidate). With nothing cached yet, the static ceiling
  applies (`history_pending`). A failed refresh keeps the last caps, or the static ceiling (`history_unavailable`),
  for 30 s and is logged; it never fails a run. The rule's queries time out after `queryTimeoutMs`. Steps never
  query: usage is accumulated in memory from `stepPost`.
- **Resume**: `runPre` with `resume: true` loads what the run and its tree already spent, in one query. This is the
  only wait, and it is bounded by the query timeout. A run unknown to a step hook is loaded in the background, and
  its steps pass unchecked until it lands. A failed load is logged and not cached, so the meter is never reset.
  Concurrent loads of one run share one read.
- **Wall time across a resume** is measured from the root's `started_at` to the last step start or finish in the
  tree. This is an approximation, because the journal records no liveness:
  - downtime after the last activity is not counted;
  - the time an in-flight step ran before the crash is lost;
  - on a second resume, the downtime before the first one counts.

  The bias is toward under-counting, so a restart never kills a healthy run. Repeated crashes end in the runtime's
  `crash_loop`. Exact active time needs a runtime liveness column.
- **Enforced in `stepPre`**: the first metric above its cap throws `RunawayCapExceeded` (`metric`, `observed`,
  `cap`, `basis`); the step fails as `middleware` and the run as `step_failed`. Usage is known per finished step, so
  a run is stopped at the step *after* the one that crossed the cap.
- **`toolPre`** checks wall time inside a long agent step. It throws the same error once per run and emits a
  decision only when the cap is exceeded. The runtime currently logs a `toolPre` throw (`toolPre threw`) and lets
  the step continue, so inside an agent step this is a report and the run stops at its next step. The runtime
  follow-up makes a `toolPre` throw fail the step.
- **Unpriced usage** (`cost` null) adds nothing to the cost metric, and the decision carries `unpricedCalls`. **When
  a run tree has unpriced calls, its cost is a lower bound and the token cap is the binding check.**
- **Wedged agents are not this rule's job**: the runtime's idle timeout is the one liveness rule. There is no turn
  or wall-clock cap below runaway level (rules/agent-limits.md).
- **Index**: the history read wants `runs (workflow, finished_at desc) where status = 'done'`. The runtime
  follow-up adds it; this package adds nothing to the runtime's schema.

| Option | Default |
|-|-|
| `factor` | 10 |
| `minSample` | 20 done runs |
| `window` | the 200 most recent done runs |
| `ttlMs` | 10 min (stale caps are served while a refresh runs) |
| `queryTimeoutMs` | 5 s (connect, query and statement timeout of the rule's pool) |
| `defaultCeiling` | cost $5, tokens 50 M, wall time 3 h, steps 500 |
| `floor` | cost $0.05, tokens 100 k, wall time 60 s, steps 20 |

### Where the numbers come from

Read-only, 2026-10-27, from today's gateways (the workloads these workflows replace):

| Source | Runs | p50 | p95 | max |
|-|-|-|-|-|
| agent-gateway `jobs.db` `job_stats`, wall time, `review` | 1503 | 4.4 min | 11.9 min | 25.8 min |
| same, `dispatch` | 707 | 0.7 min | 20.0 min | 32.4 min |
| same, `check` | 81 | 0.6 min | 8.4 min | 15.7 min |
| usage-tracker `usage.db`, `agent-gateway-opencode` per job, cost, `review` | 1252 | $0.041 | $0.132 | $0.32 |
| same, tokens, `review` | 1252 | | 3.9 M | 24.7 M |
| same, messages, `review` | 1252 | | 71 | 314 |
| same, cost, `dispatch` | 510 | $0.009 | $0.119 | $0.29 |
| usage-tracker `usage.db`, `research-gateway` per run, cost | 676 | $0.080 | $0.344 | $0.92 |
| same, tokens | 676 | | 4.9 M | 6.8 M |

Windows: agent-gateway jobs 2026-10-09 to 2026-10-27; usage-tracker 2026-09-25 to 2026-10-27. Research costs are
a lower bound (887 of 2883 records unpriced). The static ceiling sits at roughly 10× the worst per-tool p95 and
above every maximum seen: $5 (worst p95 $0.34, max $0.92), 50 M tokens (worst p95 4.9 M, max 24.7 M), 3 h (worst
p95 20 min, max 32 min). Steps have no direct analogue: an agent step is one whole session, far coarser than a
message (review p95 71, max 314 messages), so 500 steps leaves a wide margin.

## Wallet gate

`walletGate(options)` → `Middleware`. Applies to the workflow ids in `workflows` (declared optional-expensive;
OCR in review first, Wave 4); every other workflow passes untouched.

- **Only in `runPre` with `resume: false`**: refuses with `AdmissionRefused` (the run fails as
  `admission_refused` before its body runs) while `now < pausedUntil`, or when the IU rolling-30-day spend is at
  or above `thresholdUsd`. A child run of an optional workflow is refused the same way; the parent gets `null`.
- **A resumed run is always admitted**, even if the spend crossed the threshold meanwhile and also during a pause:
  concept §4 puts the gate "at admission, never mid-run", and a resumed run was admitted already.
- **The spend comes through a `SpendSource` port** (`read(now) → { ok, rolling30Usd, fetchedAt } | { ok: false,
  reason }`). The production source, `snapshotSpendSource`, is ported from agent-gateway's
  `ocrBudgetBlockReason`: it reads usage-tracker's IU snapshot (`{ schema: 1, fetched_at, rolling30_usd }`) per
  admission and **fails closed**: a missing, unreadable, malformed (bad JSON, schema ≠ 1, no valid `fetched_at`, a
  missing or negative `rolling30_usd`, `fetched_at` more than 5 min in the future) or stale (older than 48 h) snapshot refuses, as does a throwing source.
- `thresholdUsd: 0` disables the spend check (the pause still applies).

| Env | Default | Notes |
|-|-|-|
| `AGW_WALLET_THRESHOLD_USD` | `400` | a number ≥ 0; anything else = a warning and 400; `0` disables the spend check |
| `AGW_WALLET_PAUSED_UNTIL` | `2026-11-02T00:00:00Z` | ISO date; empty = no pause; invalid = a warning and the default pause date (fail closed) |
| `AGW_WALLET_SNAPSHOT` | `~/.local/share/iu-portal/latest.json` | usage-tracker's IU snapshot |

Options (`thresholdUsd`, `pausedUntil`, `spend`) win over the env. An invalid `thresholdUsd` (NaN, negative,
infinite) falls back to the env or default value with a warning; an invalid `pausedUntil` date falls back to the env
or default pause (fail closed).

## Known gaps

- **Admission burst overshoot (wallet gate).** Admission is check-then-act against a snapshot. Every run admitted
  while the snapshot is under the threshold passes, even when together they push the spend over it. The overshoot is
  bounded by what is admitted within one snapshot refresh interval (usage-tracker's writer); the next refresh
  closes the gate.
- **A SIGKILLed in-flight attempt's usage is not counted (runaway cap).** Only finished step rows carry usage
  (`finishStep` writes it). An attempt killed mid-step loses what it spent, both from the resume load and from the
  learned history. Its wall time up to its start is still counted.
- **Wall time across a resume** is approximated (see Runaway cap above).
- **`toolPre` reports but does not stop** an agent step until the runtime follow-up makes a `toolPre` throw fail
  the step.

## Decisions

Both rules report what they saw through `onDecision(decision)`, for the record middleware to store later:

- `CapDecision`: `hook` (`stepPre` / `toolPre`), run, root, workflow, step, `allowed`, `observed` and `caps` per
  metric (tree cost, tokens and wall time; this run's steps), `basis` per group (`tree`, `steps`: `learned` with
  sample and factor, or `static` with the reason), `unpricedCalls`, `exceeded`. The p95 behind a learned cap comes
  from `cap.caps(workflowId)`.
- `WalletDecision`: run, workflow, `resume`, `allowed`, `reason`, `rolling30Usd`, `thresholdUsd`, `pausedUntil`.

A sink that throws or rejects is logged at `error` (`onDecision threw; ignored`) and never refuses, admits or fails
anything. Refusals and exceeded caps are also logged at `warn` through the runtime's `Logger` shape (`logger`
option; default console, prefixed `[agw-limits]`).

## Tests

Real Postgres (`AGW_TEST_PG_URL`, throwaway schemas, a real `Runtime`):

- the learned cap against a seeded history, taken over the latest window only;
- a runaway run stopped at the next step next to a normal one;
- the static ceiling below the sample minimum;
- a resumed run counting its earlier spend;
- fan-out capped per root tree, steps per run;
- `unpricedCalls` in the decision;
- wall time in `toolPre`;
- an unreachable journal not stalling the step hooks, and stale caps served while a refresh runs;
- failed and concurrent resume loads;
- throwing sinks;
- every wallet refusal and fail-closed case, and option validation;
- a resumed run admitted over the threshold;
- 25 concurrent runs through both rules with exactly one history query.

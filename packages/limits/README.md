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

- **Caps per workflow** on four metrics of a run: cost (USD), tokens (input + output + cache read + reasoning),
  wall time and step count. The cap is `factor × p95` over the workflow's own most recent `done` runs, read
  from the journal (`runs` joined with `steps`, own pool of 2 on the runtime's connection string and schema).
  A learned cap never drops below a floor, so a workflow whose p95 is a 30 ms code run keeps headroom.
- **Below the sample minimum** a static ceiling applies: the per-workflow `ceilings[id]` merged over
  `defaultCeiling`. A history read that fails uses the static ceiling too (retried after 30 s) and is logged;
  it never fails a run.
- **Cached** per workflow for `ttlMs`; concurrent runs share one read. Steps never query: the run's usage is
  accumulated in memory from `stepPost`. A **resumed run** (`runPre` with `resume: true`, or a `stepPre` for a run
  this process has not seen) loads what it already spent from the journal once (sum of its steps, the run's
  original `started_at`), so a crash or a deploy does not reset the meter.
- **Enforced in `stepPre`**: the first metric above its cap throws `RunawayCapExceeded` (`metric`, `observed`,
  `cap`, `basis`); the step fails as `middleware` and the run as `step_failed`. Usage is known per finished step, so
  a run is stopped at the step *after* the one that crossed the cap.
- **`toolPre`** checks wall time inside a long agent step and throws the same error. The runtime currently logs a
  `toolPre` throw (`toolPre threw`) and lets the step continue, so inside an agent step this is a report; the run
  stops at its next step. Failing the step from `toolPre` needs a runtime change.
- **Wedged agents are not this rule's job**: the runtime's idle timeout is the one liveness rule. There is no turn
  or wall-clock cap below runaway level (rules/agent-limits.md).
- Child runs (`ctx.workflow`) are capped by their own workflow's caps; a parent's `workflow` step carries no usage.

| Option | Default |
|-|-|
| `factor` | 10 |
| `minSample` | 20 done runs |
| `window` | the 200 most recent done runs |
| `ttlMs` | 10 min |
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
- **A resumed run is always admitted**, even if the spend crossed the threshold meanwhile.
- **The spend comes through a `SpendSource` port** (`read(now) → { ok, rolling30Usd, fetchedAt } | { ok: false,
  reason }`). The production source, `snapshotSpendSource`, is ported from agent-gateway's
  `ocrBudgetBlockReason`: it reads usage-tracker's IU snapshot (`{ schema: 1, fetched_at, rolling30_usd }`) per
  admission and **fails closed**: a missing, unreadable, malformed (bad JSON, schema ≠ 1, no valid `fetched_at` or
  `rolling30_usd`) or stale (older than 48 h) snapshot refuses, as does a throwing source.
- `thresholdUsd: 0` disables the spend check (the pause still applies).

| Env | Default | Notes |
|-|-|-|
| `AGW_WALLET_THRESHOLD_USD` | `400` | a number ≥ 0; anything else falls back to 400; `0` disables the spend check |
| `AGW_WALLET_PAUSED_UNTIL` | `2026-11-02T00:00:00Z` | ISO date; empty = no pause; invalid = a warning and no pause |
| `AGW_WALLET_SNAPSHOT` | `~/.local/share/iu-portal/latest.json` | usage-tracker's IU snapshot |

Options (`thresholdUsd`, `pausedUntil`, `spend`) win over the env.

## Decisions

Both rules report what they saw through `onDecision(decision)`, for the record middleware to store later:

- `CapDecision`: `hook` (`stepPre` / `toolPre`), run, workflow, step, `allowed`, `observed` and `caps` per metric,
  `basis` (`learned` with sample, factor and p95, or `static` with the reason), `exceeded`.
- `WalletDecision`: run, workflow, `resume`, `allowed`, `reason`, `rolling30Usd`, `thresholdUsd`, `pausedUntil`.

Refusals and exceeded caps are also logged at `warn` through the runtime's `Logger` shape (`logger` option;
default console, prefixed `[agw-limits]`).

## Tests

Real Postgres (`AGW_TEST_PG_URL`, throwaway schemas, a real `Runtime`): the learned cap against a seeded history,
a runaway run stopped at the next step next to a normal one, the static ceiling below the sample minimum, a resumed
run counting its earlier spend, wall time in `toolPre`, every wallet refusal and fail-closed case, a resumed run
admitted over the threshold, and 25 concurrent runs through both rules with exactly one history query.

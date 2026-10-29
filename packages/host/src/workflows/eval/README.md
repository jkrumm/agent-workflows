# Evals (concept §6)

`src/workflows/eval/` serves the regression and comparison side of the scorers; `review` and `check` carry a scorer
(`src/workflows/{review,check}/scorer.ts`), attached for regression and drift only: neither workflow calls
`ctx.score`, so production behaviour is unchanged (an inline gate is a later experiment).

| Command | Does |
|-|-|
| `agw eval run <review\|check\|research> [--ids a,b] [--limit N] [--concurrency N] [--args '{…}'] [--yes]` | Without `--yes`: the plan (selected case ids) and an estimate (mean cost of the workflow's latest 50 done runs × cases), nothing runs. With `--yes`: each case materialized like the harness does (`materialize` from `@agent-workflows/eval`; a plain case, research's, needs no tree and runs its recorded input), run as its own top-level run with purpose `eval`, scored against the case's reference, the verdict and the arm's `args` recorded on that run (`scores.final`); the output lists per-case scores, the fingerprints and the means |
| `agw eval compare <review\|check> --a <fp> --b <fp> [--a-args '{…}'] [--b-args '{…}'] [--seed N]` | Two arms paired by case id: per metric the means, the mean and median delta (B − A) with seeded bootstrap 95% CIs (harness `stats.ts`), and which arm the CI favours. Scores are higher-is-better; `costUsd`, `wallMs`, `tokens`, `toolCalls` lower-is-better. Reads only |
| drift (no command) | every `AGW_DRIFT_INTERVAL_S`, up to 20 sampled, unscored production runs of a workflow with a scorer are scored (`source: drift`); the sample is a hash of the run id, the write first-writer-wins, so several hosts never score a run twice. A tick counts verdicts and recorded scorer errors apart (and warns on errors) |

- **Spend gate: `--yes`, not `--commit`.** The CLI's `--commit` gate (mutating operations) applies only off a TTY and
  shows nothing first; an eval spends IU money (concept N8) whoever types it, so `eval.run` is not `mutating`: the
  default answer is the plan with the estimate, and only `--yes` spends.
- **An arm is a fingerprint plus the exact `--args`.** A workflow input that is not part of the fingerprint
  changes behaviour without changing the fingerprint, so compare selects by both: equal fingerprints compare when the args differ, and two
  identical arms are refused. A fingerprint may be given as a unique prefix (8+ characters). Reruns of a case in one
  arm are averaged before pairing; a run with unpriced calls leaves its cost out instead of comparing a lower bound;
  mixed scorer versions and fewer than 10 paired cases are reported as `warnings`.
- **Resume and cancel.** Each case run is keyed `eval:<evalRunId>:<caseId>`, and its clone lives in a directory
  derived from that key (`agw_eval_case_<sha256[:16]>` in the temp dir). A resumed `eval.run` looks the key up before
  anything else: a case scored by this eval run is reported as recorded (no clone, no install, no second score); one
  still running is waited on and scored; only a case with no run is materialized and started. A failure on that path
  (a lookup, a wait, a score) is that case's error result, never the whole step's. After a case is done its directory
  is removed, so the process that adopts a case after a shutdown removes the tree the first process kept. Cases go
  through a pool that takes no new case after the first failure. Cancelling `eval.run` cancels its case runs (a case
  run that starts after the cancel fired is cancelled too, and no case starts after it), waits up to 30 s for each to
  end, and only then removes its clone. A tree is removed only when its run is known ended (a terminal status read
  just then) or known never started; a failed lookup or wait, or a live run, keeps it, and a sweep (at start and
  hourly) removes `agw_eval_case_*` directories older than 3 h whose marker names a run that ended or does not exist;
  a directory without its marker is never deleted, only logged. A sweep never overlaps itself, and close waits for it. On resume, a case whose recorded score is a scorer error is scored again. A shutdown or a lost lease leaves
  the case runs going and keeps their clones for the next process. A scorer error is a case `error` (reason
  `scorer: …`), out of the pass rate and the means. Repeated `--ids` are deduplicated.
- **What compare will not call.** A metric with fewer than 5 pairs gets `better: unknown`, whatever its CI, and a
  warning says the verdict is withheld (for every metric when fewer than 5 cases pair at all). A case with any
  unpriced rerun leaves `costUsd` on that side (`cases.unpricedCost`), never averaged over its priced reruns; a case
  with no cost recorded at all is counted apart (`cases.noCost`), and the cost warning names both. A run with a scorer
  error is no verdict: it is left out of its arm (`scorerErrors`, warned). An arm that itself mixes scorer versions
  is warned too. Each arm is read with its fingerprint prefix and args in SQL, never the workflow's whole
  history.
- **Wiring.** `wireEval` (in `boot`) binds the eval workflows to the runtime before it opens (recovery may resume an
  eval run at once) and owns the drift job's timer. The runtime's `judge` (`src/judge.ts`) lets a scorer call only
  `web.fetch`, `web.package`, `decide` and `llm.*` (never a workflow or an effect). For regression and drift each call
  is a `cap.<id>` run of its own, recorded and priced like a direct capability call, with purpose `eval` (regression)
  or `drift`, keyed by the score source (drift also by its pass, the UTC day), the scorer version, the scored run, the capability and its input under the
  shared attempt rule (a retried scoring adopts a finished call and re-runs a failed one; a drift re-score under a new
  scorer fetches fresh; an aborted scoring cancels the call it started); an inline gate (none judges today) calls in process on its step. Only a failure that is an
  answer comes back (`answerOf`: a 4xx from the source, such as a page gone, forbidden or rate-limited, or a package
  not found; a refused URL; as `{error: {code, message}}`);
  every other failure, an outage, throws and the scoring retries.
  Review's and check's scorers never judge. **Drift on research** spends per sampled run up to three `web.fetch` (direct
  or Tavily Extract, ≈ $0) and three `decide` calls on ≤ 20k characters each (≈ 5k tokens at $0.04/M, ≈ $0.0002 each):
  ≈ $0.001 per scored run, as up to six `cap.*` runs with purpose `drift`; drift has no reference, so no `web.package`.

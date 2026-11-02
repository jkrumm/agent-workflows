# Eval reports

One committed report per model or tier change: aggregates only (this repo is public), cases and per-case output stay
under `$AGW_EVAL_DIR`. Raw runs are in the journal (`agw.runs` with `score_source = 'regression'`), found by
fingerprint and args.

A report carries: the change, the case set (ids or hash), the scorer version, per arm the quality metrics with CIs,
cost per run, wall time p50 and max, input / cache-read / output / reasoning tokens, failed steps with their causes, the
fingerprints, and a verdict that says what the numbers can and cannot decide.

## Lessons for the next eval (the review rework owns it)

Learned on 2026-10-29 to 10-31 (`2026-10-31-review-claude-direct.md`):

- **A reference must be ground truth, not a past run.** The review set scores against agent-gateway's recorded outcome;
  that gateway agreed with its own rerun 21 % of the time. Agreement with it measures how readily a model rates a
  finding `blocking`, and recall against its findings is 0 to 0.05 for every model. Build the review set from planted
  defects (known file, line, severity) plus clean controls, and score recall, false positives and severity calibration.
  Look at how public code-review benchmarks build ground truth before designing one.
- **Score the verdict rule separately from the findings.** `actionable` is "one finding survived at `blocking`", so a
  model's severity habit decides the outcome. Report findings quality and verdict calibration as two metrics.
- **Effort is part of the arm and must be verified on the wire.** Until 5e1a871 OpenCode's Anthropic protocol dropped
  `reasoningEffort`, so every Claude arm ran at the model default. Check reasoning tokens per arm before trusting it.
- **Record cost, wall time and tokens per arm from the start**; agreement alone hid that DeepSeek took 10 min per deep
  review and Haiku max 31 min.
- **Failure modes are results.** Haiku max failed 23 steps on compaction overflow; one Sonnet step failed because agent
  JSON is parsed from free text (`parseStructured`). Count failed steps per arm and name the causes.
- **Mechanics:** one arm is one file, `agw eval run <workflow> --arm <arm.json> --yes` (route patches and params,
  routes README §Arms). It applies to that eval run and every run below it, needs no restart and never moves
  production; a bad arm is refused before anything runs. Its fingerprint tells the arm apart in `agw eval compare`.
  Wait on the eval run id (`agw run wait`) until it is terminal; the CLI's wait budget expiring is not the end of the
  run, and a pending result prints two JSON documents. The eval run's `cost` is its whole tree: the case runs and the
  judge's calls. An external arm (the native `/code-review`, Wave 9) is scored with `agw eval import review --label
  <name> --findings <file> --yes` (case id → findings, judged by the same scorer) and compared with
  `agw eval compare review --a <fp> --b <fp> --b-workflow review.imported`; its cost and wall read `null`
  (`packages/host/src/workflows/eval/README.md`).
- **Arms run on the credit, under the pacing reserve** (Wave 6, `2026-11-02-claude-seats.md`): every eval call carries
  purpose `eval`, draws only on a pool's credit above production's pro-rata reserve and is refused (403), never sent to
  IU, when none has any. Read `evalAvailableUsd` on the gateway's `/health` before a sweep and size the slices to it.
- **Sonnet's effort barely reaches agent steps.** At `low` and `medium` Sonnet 5.5 spent 0 to 28 reasoning tokens per
  case in OpenCode sessions (adaptive thinking decides), while Haiku `high` spent hundreds: two Sonnet effort arms are
  close to one arm. Check reasoning tokens per arm, as above, before reading an effort difference into a score.

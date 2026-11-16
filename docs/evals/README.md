# Eval reports

One committed report per model or tier change: aggregates only (this repo is public), cases and per-case output stay
under `$AGW_EVAL_DIR`. Raw runs are in the journal (`agw.runs` with `score_source = 'regression'`), found by
fingerprint and args.

A report carries: the change, the case set (ids or hash), the scorer version, per arm the quality metrics with CIs,
cost per run, wall time p50 and max, input / cache-read / output / reasoning tokens, failed steps with their causes, the
fingerprints, and a verdict that says what the numbers can and cannot decide. Every report that rests on the review ground
truth states its limit: `LLM consensus (labellers a/b/c, judges a/b), no human check`.

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

## The research suite and its refresh

`$AGW_EVAL_DIR/research/cases.jsonl` is built from real production questions and keeps production's depth mix: the case
file is within 15 points of the prod mix per depth (the mix and the date are stated in the latest research baseline,
`2026-11-16-research-baseline.md`). It replaced a suite of 19 quick, 8 standard and 1 deep case whose runs made a median of
2 tool calls, where production standard makes about 35 and deep about 76: a prompt, budget or model change was judged on
questions that exercise none of the behaviour that costs money.

**Refresh: by hand, quarterly, and whenever the prod mix moves.** The nightly `eval-mine` job that added cases is
retired, nothing else writes this file, and the suite goes stale on its own. The pull:

1. Read the prod mix of the last 3 weeks from the journal: `agw.runs` with `workflow = 'research'`, `purpose = 'prod'`,
   `input->>'depth'`; count, mean cost and mean `tool_calls` per depth. Set the target counts so the file's depth shares
   stay within 15 points of it (3 quick, 18 standard, 11 deep in 2026-11).
2. Pick the questions from `status = 'done'` runs that have no `context`, `contextRuns` or `followUp` in their input:
   those carry background that may be private and do not stand alone. Drop any question that names a person, a private
   repo, a host or work data; shorten a question that mentions the owner's own setup, never the facts asked for.
3. Write `reference.expect` as the existing cases do (`any`, `all`, or `live: <registry>:<name>` for "what is the
   latest version"). A golden is a handful of stable names and facts the answer must contain, taken from the question's
   primary sources, never from the report that run produced (a past run is not ground truth). Check each pattern
   against the run's report only to catch a pattern that can never match. The `supported` score judges the claims; the
   golden only guards coverage.
4. Replace the oldest prod-derived cases, keep ids stable for cases that stay, so `agw eval compare` keeps pairing them.
   Record the pull date, the window and the prod mix in a new baseline report, and run the suite once on the then-current
   route: a refreshed suite has no comparable older numbers.

The case file and a `provenance.json` (case id → the prod run it came from) live under `$AGW_EVAL_DIR/research/`, never
in this repo.

**What a research run prints.** `agw eval run research --yes` reports `summary` overall and `summary.groups` per depth:
cases scored, pass rate, every score's mean, cost (sum and mean per case), tool calls (sum and mean per case). The
research scorer also writes every score under `<score>.<depth>` (`supported.deep`), so `agw eval compare research` reads a
depth apart. Cost and tool calls are the case run's record (the whole run tree), so a call budget shows its effect on
them next to the quality scores. `--args '{"depth":"deep"}'` regroups the run under that depth.

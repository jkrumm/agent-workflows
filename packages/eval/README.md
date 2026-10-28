# @agent-workflows/eval

Eval sets and the side-by-side harness for the P1 cutover gate (concept §6, §11): the new `review` and `check`
workflows must be **not worse than agent-gateway on findings, cost and wall time**. The harness runs each recorded
case against the new platform, optionally reruns agent-gateway on the same tree, and writes a verdict.

Cases and reports hold private code and findings, so they never enter this repo: they live under `$AGW_EVAL_DIR`
(default `~/.local/share/agent-workflows/eval`). Only the aggregate section of a report is meant to be published.

## Run it

```sh
bun packages/eval/src/harness/cli.ts review --dry-run --limit 3      # plan + IU estimate, calls neither side
bun packages/eval/src/harness/cli.ts review                           # all review cases, concurrency 2
bun packages/eval/src/harness/cli.ts review --rerun-legacy --judge    # measure legacy's noise floor, judge unsure pairs
bun packages/eval/src/harness/cli.ts check --ids a,b --keep
bun packages/eval/src/harness/cli.ts review --resume "$AGW_EVAL_DIR/reports/<ts>"
```

| Flag | Effect |
|-|-|
| `--ids a,b`, `--limit N` | case selection (ids first, then the first N) |
| `--concurrency N` | cases in parallel, default 2 (IU budget, host load) |
| `--rerun-legacy` | also runs `agw-legacy` on the same tree: legacy's self-agreement becomes the floor |
| `--judge` | the `decide` capability (`agw decide`) rules on finding pairs the deterministic matcher is unsure of |
| `--depth router` | the new review picks its own depth; default `matched` passes the legacy run's recorded depth |
| `--dry-run` | materializes every case, prints the plan and an IU estimate (legacy mean cost × ready cases, × 2 with a rerun) |
| `--keep` | keeps the case clones (paths go to stderr) |
| `--resume <dir>` | continues a run; finished and skipped cases are not rerun, failed ones are |
| `--seed N` | bootstrap seed (default 1): the same seed gives the same CI |

Environment: `AGW_EVAL_DIR` (cases, reports), `AGW_EVAL_HOME` (the root `case.repo` is relative to, default
`$HOME`), `AGW_BIN` / `AGW_LEGACY_BIN` (the CLIs, default `agw` / `agw-legacy` on `PATH`), `AGW_PG_SCHEMA` (default
`agw`), `AGW_EVAL_PG_PASSWORD` (else `secrets-run read`, as `make verify` does), `AGW_USAGE_TRACKER_DIR`.

Output: `<evalDir>/reports/<ts>/results.jsonl` (one line per case, appended as cases finish: the resume point),
`report.json` and `report.md`, all mode 0600.

## How a case runs

1. **Materialize.** `git clone --shared --no-checkout $HOME/<repo>` into a temp dir, `git checkout --detach
   <baseSha>`, `git apply` the case's `diff` (review) or `patch` (check) as uncommitted changes. The owner's
   checkout is only read. A diff that does not apply, a missing repo or an unknown sha makes the case `skipped`
   with its reason; skipped cases are counted in every report, never dropped. A check case runs
   `bun install --frozen-lockfile` first only when the repo has a bun lockfile and its Makefile `check` target does
   not install itself.
2. **Both sides on the same tree**, whatever the legacy input was (PR, branch, ref): "review this diff as
   uncommitted changes on `baseSha`". The new side: `AGW_PURPOSE=eval agw review --cwd <clone> --scope uncommitted
   [--depth <recorded>] [--context …] --format json`. `agw` prints the run state, so the run id comes with the
   output; an exit 10 (wait budget out) is resumed with `agw run wait <runId>`. Cost, tokens and wall time come from
   the journal row (`"$AGW_PG_SCHEMA".runs`) over a read-only `psql` session. With `--rerun-legacy`:
   `agw-legacy review --repo <clone> --scope uncommitted --no-wait --json --caller eval`, then `wait` and `status`
   for the result and the job window. The two sides run one after the other, the order alternating per case.
3. **Match findings.** The recorded legacy blocking findings are the reference. A pair matches deterministically on
   the same file (paths normalized), lines within 5 (or both line-less) and a message-token overlap coefficient of
   at least 0.3. Close-but-unclear pairs (near with different words, or same words far apart / one line-less) are
   *unsure*: without `--judge` they stay unmatched and are counted; with it, `decide` answers "same defect?" for
   each. Matching is one-to-one, best score first.
4. **Record** the case and append it to `results.jsonl`; the clone is removed unless `--keep`.

## Metrics

Review: outcome agreement and the 3×3 confusion matrix (legacy rows, new columns), blocking recall vs legacy
(pooled: matched / all legacy blocking), new-only blocking, improvements per case, needs-human rate, failed-angle
rate (a `(review pipeline)` discussion), and cost and wall time as **paired ratios** new/legacy with the median and
a seeded bootstrap 95% CI of the median. The legacy side of a ratio is the rerun where one ran, else the recorded
run (the report says which: `rerun`, `recorded` or `mixed`). Check: `passed` agreement and its 2×2 table, per-step
agreement over steps both sides ran, cost and wall ratios.

## What the verdict means

| Verdict | When |
|-|-|
| **not-worse** | every criterion holds on at least 20 review / 5 check cases |
| **worse** | at least one criterion failed; the report names it with its value and threshold |
| **inconclusive** | fewer cases ran than the minimum, or a criterion had no data (e.g. no priced pairs) |

Review criteria: blocking recall and outcome agreement each ≥ legacy's own self-agreement on that metric − 0.10
(measured by `--rerun-legacy`; without a rerun the floor is 0.6), median cost ratio ≤ 1.10, median wall ratio
≤ 1.25. Check: `passed` agreement ≥ self-agreement − 0.10 (0.9 without a rerun), the same cost and wall ratios. The
thresholds are `DEFAULT_THRESHOLDS` in `src/harness/verdict.ts` and are written into every report.

The noise floor matters: agent-gateway does not agree with itself on a rerun (models are sampled, angles fail), so
holding the new review to 100% agreement with one recorded run would fail a perfect port. Compare against the floor.

## Caveats, measured or not

- **Legacy cost is approximate.** Session rows in usage-tracker's `agent-gateway-sessions.jsonl` carry the job id;
  IU rows in `agent-gateway-iu.jsonl` (router, adversary, OCR) do not and are matched by tool prefix and the job's
  time window. With concurrency 2, two legacy jobs claim the IU rows in their overlap. `costExact: false` marks it.
- **The legacy rerun is always router-depth.** `agw-legacy review` takes no `--depth`, so depth-matched runs
  compare the new side at the recorded depth against a rerun at the router's depth. Run `--depth router` as a
  second report to compare router against router.
- **The clone lives in the temp dir**, outside the dispatch roots; if either host refuses such a path, the case
  fails (`new_failed`, or `rerunError`) and the report shows it. Not verified live yet: the new host was not
  deployed when the harness landed.

## Compared with agent-gateway's replay judge

`agent-gateway/scripts/replay-review-corpus.ts` (bench `review-replay-2026-10-19-s30`) pooled every arm's blocking
findings, blinded them (arms behind letters) and had one judge model label each finding against the frozen diff
(`confirmed_defect`, `not_blocking`, `not_a_defect`, `unverifiable`) to get precision per arm. Kept: blinding (the
judge sees "finding A / finding B" in a content-derived order, no side names) and judging against the frozen diff
only. Changed: the question is pairwise ("same defect?"), not per-finding validity, because the gate is agreement
with legacy rather than absolute precision; the judge is asked only about pairs the deterministic matcher cannot
settle, so most cases cost nothing; and it runs on the platform's `decide` capability (calibrated boolean answer)
instead of a free-text model call parsed as JSON.

## Token effect / cache effect

The harness adds no model-visible text to either workflow: both sides get the same tree and the same inputs the
legacy call had. Its own model spend is the judge only: one `decide` call per unsure pair, the diff cut to 40k
characters. Everything else is the cost of the reviews themselves, tagged `AGW_PURPOSE=eval` on the new side and
`--caller eval` on the legacy side. Each case is a cold run for both sides (a fresh clone, a fresh session), so
neither side inherits the other's prompt cache from the same case; the alternating order keeps any cross-case cache
warmth from always favouring one side.

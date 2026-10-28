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
bun packages/eval/src/harness/cli.ts review --resume 2026-10-28T09-00-00-000Z   # a run under $AGW_EVAL_DIR/reports
bun packages/eval/src/harness/cli.ts self-agreement review --side legacy --runs 2  # reproducibility first, see below
```

| Flag | Effect |
|-|-|
| `--ids a,b`, `--limit N` | case selection (ids first, then the first N); an unknown id exits 2 and names it |
| `--concurrency N` | cases in parallel, default 2 (IU budget, host load) |
| `--rerun-legacy` | also runs `agw-legacy` on the same tree: legacy's self-agreement becomes the floor |
| `--judge` | the `decide` capability (`agw decide`) rules on finding pairs the deterministic matcher is unsure of |
| `--depth router` | the new review picks its own depth; default `matched` passes the legacy run's recorded depth |
| `--dry-run` | materializes every case, prints the plan and an IU estimate (legacy mean cost × ready cases, × 2 with a rerun) |
| `--keep` | keeps the case clones (paths go to stderr) |
| `--resume <run>` | continues a run; finished and skipped cases are not rerun, failed ones are. `<run>` is an absolute directory, or a path relative to `<evalDir>/reports` (a run's timestamp is its directory name there); it never resolves against the cwd, must stay inside the reports directory and must exist, else a usage error |
| `--seed N` | bootstrap seed (default 1): the same seed gives the same CI |
| `--agw-args="<args>"` | review only (a usage error on `check`): whitespace-split extra arguments for every `agw review` call, e.g. `--agw-args="--angle-variant shell"` (the `=` is required: the value starts with a dash). Pinned in the run directory's `run.json`: `--resume` with different arguments is a usage error. Recorded in `report.json` (`meta.agwArgs`) and the `report.md` header |

Environment: `AGW_EVAL_DIR` (cases, reports), `AGW_EVAL_HOME` (the root `case.repo` is relative to, default
`$HOME`), `AGW_BIN` / `AGW_LEGACY_BIN` (the CLIs, default `agw` / `agw-legacy` on `PATH`), `AGW_PG_SCHEMA` (default
`agw`), `AGW_EVAL_PG_PASSWORD` (else `secrets-run read`, as `make verify` does), `AGW_USAGE_TRACKER_DIR`.

Output: `<evalDir>/reports/<ts>/results.jsonl` (one line per case, appended as cases finish: the resume point),
`report.json` and `report.md`, all mode 0600.

## Reproducibility: is the recorded baseline worth scoring against?

Wave 4 measured that agent-gateway's own rerun recovered none of its recorded blockers (outcome agreement 21 %), so a
recorded finding is no ground truth until the case shows it comes back. `self-agreement` measures that before a set
counts as a baseline:

```sh
bun packages/eval/src/harness/cli.ts self-agreement review|check --side legacy|new --runs 2 [--threshold 0.5] [--ids …] [--judge]
```

It reruns one side `--runs` times (default 2, at least 2) on every case and compares all runs with each other and
with the recorded run (the earlier run of a pair is the reference), with the same matcher as the main harness. The
runs are every pair of the recorded run and the reruns, (runs + 1) choose 2: three pairs at the default, and with
`--judge` each pair can add judge calls for its unsure findings, so keep `--runs` small. Per case it appends the
**raw** agreement numbers to `<evalDir>/<workflow>/reproducibility.jsonl` (mode 0600; numbers only):
`{ id, side, runs, outcomeAgreement, blockingRecall }`.

| Field | Meaning |
|-|-|
| `outcomeAgreement` | pairs of runs with the same outcome (review `outcome`, check `passed`) / all pairs |
| `blockingRecall` | blocking findings of the earlier run of a pair found again in the later one, pooled; check: red runs still red (failure recall). `null` when no run had any |

A case is **reproducible** at a threshold when `outcomeAgreement >= threshold` and (`blockingRecall` is `null` or
`>= threshold`). The threshold is applied when the rows are read, not when they are written: `--threshold` (default
0.5; with the recorded run and two reruns it means all three outcomes agree) takes effect on the same file without
measuring again, in `self-agreement`'s summary line and in `review|check`. A case a rerun failed on or that cannot
materialize gets no row. Cases already measured for this side with as many reruns are skipped on the next call
(delete the file to measure again); legacy reruns go one at a time, as in the main harness. `self-agreement` exits 1
when it measured nothing (every case errored or was skipped). `--side` and `--runs` belong to `self-agreement`; on
`review|check` they are a usage error. The new side reruns at the recorded depth (`--depth router` lets its router
choose, `--agw-args` applies); the legacy CLI takes no depth.

`review` and `check` read the **legacy** rows only (the recorded findings are legacy's) and score blocking recall
(check: legacy failure recall) on the reproducible cases, **when every scored case of the run has a legacy row**. The
headline recall prints the counted cases' own numerator and denominator, and the report says how many cases counted:
`counted on N of M cases with a recorded blocking finding (…); K not reproducible`. With rows for only some of the
cases the data is not used (a partial file would shrink the denominator to whichever cases happened to be measured):
every case counts and the report says `reproducibility data covers K of N cases: not used`. With no legacy row it says
`no reproducibility data`. If no case is reproducible the recall is undecided (the verdict goes inconclusive), never a
pass. **Rows of the `new` side never feed scoring**: they say how much the new workflow disagrees with itself, and the
`--side new` summary line is marked informational.

## How a case runs

1. **Materialize.** `git clone --shared --no-checkout $HOME/<repo>` into a temp dir, `git checkout --detach
   <baseSha>`, `git apply --intent-to-add` the case's `diff` (review) or `patch` (check) as uncommitted changes (files the patch
   creates are intent-to-add, so a `git diff HEAD` scope sees them on both sides). The owner's
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
   Legacy reruns run one at a time across the whole run, whatever `--concurrency` says, so the IU time-window cost
   match never sees two legacy jobs at once. A journal read that fails after a paid run leaves the cost unknown
   (`costUsd: null`) and keeps the output.
3. **Match findings.** The recorded legacy blocking findings are the reference. A pair matches deterministically on
   the same file (paths normalized), lines within 5 (or both line-less) and a message-token overlap coefficient of
   at least 0.3 with at least 2 shared tokens (one shared word with a two-word message is not enough). Close-but-unclear pairs (near with different words, or same words far apart / one line-less) are
   *unsure*: without `--judge` they stay unmatched and are counted; with it, `decide` answers "same defect?" for
   each. Matching is one-to-one, best score first.
4. **Record** the case and append it to `results.jsonl`; the clone is removed unless `--keep`. A throw anywhere in
   a case (git, the judge, the matcher) becomes that case's `error` result (`harness_failed`); the run goes on.

## Metrics

Review: outcome agreement and the 3×3 confusion matrix (legacy rows, new columns), blocking recall vs legacy
(pooled: matched / all legacy blocking), new-only blocking, improvements per case, needs-human rate, failed-angle
rate (a `(review pipeline)` discussion), and cost and wall time as **paired ratios** new/legacy with the median and
a seeded bootstrap 95% CI of the median. The legacy side of a ratio is the rerun where one ran, else the recorded
run (the report says which: `rerun`, `recorded` or `mixed`), and how many costs per side are unknown or approximate.
Check: `passed` agreement and its table, legacy failure recall (legacy red → new red), per-step agreement over steps
both sides ran, cost and wall ratios.

**Blocking recall where legacy found nothing.** Recall is pooled: matched legacy blocking findings over all legacy
blocking findings in the scored cases. A case where legacy reported no blocking finding adds nothing to either side
of that fraction; whatever the new side flags there counts only as new-only blocking, and a clean-vs-actionable
split shows up in outcome agreement. A set where legacy found no blocking finding at all has no recall: the
criterion reads "no data" and the verdict is `inconclusive`, never a vacuous pass. New-only findings are reported,
not judged: the gate is agreement with legacy, not precision.

A case whose new side failed (`new_failed`) is scored as a miss: its legacy blocking findings count against recall,
its outcome or `passed` as a disagreement (column `failed`/`errored`). Harness failures are not scored. Both count
toward the error rate.

## What the verdict means

| Verdict | When |
|-|-|
| **not-worse** | every criterion holds on at least 20 review / 5 check cases |
| **worse** | at least one criterion failed; the report names it with its value and threshold |
| **inconclusive** | fewer cases ran than the minimum, more than 10% of the cases that ran errored, or a criterion had no data (a cost or wall ratio needs at least 10 paired review / 3 check cases) |

Review criteria: blocking recall and outcome agreement each ≥ legacy's own self-agreement on that metric − 0.10
(measured by `--rerun-legacy`; without a rerun the floor is 0.6), median cost ratio ≤ 1.10, median wall ratio
≤ 1.25; the report shows each median's bootstrap CI next to it. Check: `passed` agreement and legacy failure recall
each ≥ self-agreement − 0.10 (0.9 without a rerun), so an always-green check cannot pass on a mostly green set; the
same cost and wall ratios. The
thresholds are `DEFAULT_THRESHOLDS` in `src/harness/verdict.ts` and are written into every report.

The noise floor matters: agent-gateway does not agree with itself on a rerun (models are sampled, angles fail), so
holding the new review to 100% agreement with one recorded run would fail a perfect port. Compare against the floor.

## Caveats, measured or not

- **Legacy cost is approximate.** Session rows in usage-tracker's `agent-gateway-sessions.jsonl` carry the job id;
  IU rows in `agent-gateway-iu.jsonl` (router, adversary, OCR) do not and are matched by tool prefix and the job's
  time window. Legacy reruns are serial, so no two of them share a window; a job outside the harness running at the
  same time still can. `costExact: false` marks it.
- **The legacy rerun is always router-depth.** `agw-legacy review` takes no `--depth`, so depth-matched runs
  compare the new side at the recorded depth against a rerun at the router's depth. Run `--depth router` as a
  second report to compare router against router.
- **The clone lives in the temp dir**, outside the dispatch roots; if either host refuses such a path, the case
  fails (`new_failed`, or `rerunError`) and the report shows it. Not verified live yet: the new host was not
  deployed when the harness landed.

## Unpriced calls (Wave 4 eval runs)

The Wave 4 eval runs (created 2026-10-28, 09:00 to 12:00 UTC, `purpose = 'eval'` or the eval team's IU key: 69 runs)
carried 11 unpriced calls. Query (read-only, as `psqlJournal` connects):

```sql
select r.workflow, s.kind, s.model, count(*) steps, sum(s.unpriced_calls) unpriced, count(*) filter (where s.cost is null) cost_null
from agw.steps s join agw.runs r on r.id = s.run_id
where r.created_at >= '2026-10-28 09:00+00' and r.created_at < '2026-10-28 12:00+00'
  and (r.purpose = 'eval' or r.iu_key = '<eval-team-key>') and s.unpriced_calls > 0
group by 1, 2, 3;
```

Result: one row, `review` / `agent` / Haiku 5.5 EU, 11 steps, each with `unpriced_calls = 1` and a null cost. All 11 are
angle steps (architect 1, security 2, data-migration 2, concurrency 1, senior-dev 1, frontend 1, backend 1, typescript 1,
api-contract 1) of two `deep` review runs; no other workflow, no judge call and no capability call was unpriced.

**By design, not a missing rate.** `OpenCodeHost.usage` prices a step message by message and returns `unpriced` for
the whole step when any one message has a prompt (input plus cache reads and writes) above 100K tokens
(`LONG_PROMPT_TOKENS`): vendors bill the long-prompt tier of Haiku at 5x, which `Rate` does not model, so the cost is
unknown rather than under-priced. Checked against the OpenCode sessions of every agent step in the window (219): the
11 unpriced steps each contain a message with a 104K to 146K prompt; the 208 priced ones peak at 99K. Deep reviews
read many files, so their angle steps cross the line; the standard and light runs in the window did not. The unpriced steps are
a visible undercount of the total (their tokens are recorded, `costExact: false` on the harness side), not a lost
run. Pricing the tier needs the vendor's exact rule (which rates the 5x applies to), so it stays unpriced until a
`Rate` can say it; setting `longPromptTokens` higher on the route would silently under-price these calls.

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

`self-agreement` adds no prompt text either; it is N more cold runs of the side under test per case (`--runs`, default
2), tagged the same way, plus the judge on unsure pairs with `--judge`. Measure a set once and read the file; the
`review` and `check` modes spend nothing extra for it.

# @agent-workflows/eval

The data side of the evals (concept §6): case schemas and the reader/writer of `$AGW_EVAL_DIR/<workflow>/cases.jsonl`
(`CheckCase`, `PlainCase`, `casesPath`), the paired comparison of two arms (`compareArms`, seeded bootstrap CIs; the
`agw eval compare` workflow reads it), the throwaway case checkout (`materialize`, `exec`) that `agw eval run` replays
cases on, and the review ground truth (`gt*.ts`, `mine/`) below. The side-by-side harness of the P1 cutover gate, its
`ReviewCase` reader and the 138 legacy review cases went with review v1: the review is v4 host operations now, which
`agw eval run` cannot replay (it is no workflow). The ground truth's replay arm is `agw eval recall` (below).

## Recall run

`agw eval recall [--split dev|test] [--cases a,b] [--kind bug|control|all] [--limit N]` (mutating: off a TTY it needs
`--commit`; run it with `AGW_PURPOSE=eval`, which `eval.recall` defaults to) runs the cases of `review-gt/cases.jsonl`
through review v4's hidden transport and scores them (`packages/host/src/workflows/eval-recall/`). One run at a time
(`concurrency: 1`), the cases in file order after the filters. Step ids are literals, so each case is a child run
(`eval.recall.case`, internal) with the steps `clone`, `request`, `wait`, `score`, `cleanup`; the children wait in file
order for one of `--concurrency N` slots (1 by default, at most 2: the factory holds two reviewer sessions host-wide) before
their first step. A child that fails (a judge outage, a missing credit) leaves its case `unscored` with the reason
`case run failed`; rerun it with `--cases`:

- **Clone.** `materialize` with `isolate: true` at the case's sha: no refs, origin or alternates, the parent reachable.
  It lives under `$HOME/SourceRoot/.agw-eval-recall/` (`AGW_EVAL_CLONES_DIR`): the factory refuses a repo outside its
  `FACTORY_REPO_ROOTS` (default `$HOME/SourceRoot`), and the miner skips dot names. With no origin the repo identity of
  the clone is its own path, so the ledger's earlier findings of the live repo never reach `prior.json`, and
  `history.txt` ends at the parent (`test/eval-recall-isolation.test.ts`).
- **Request.** `review.request` in process: scope `<parent>..<sha>`, context the commit **subject** only (never the bug
  description, the fix or the label), `min: light` so no case is skipped, thread `eval:<runId>:<caseId>`. A resumed
  step looks the clone's live (not abandoned) job up first and adopts it, so a case is never requested twice. The
  factory spawns one reviewer session on Max, paced by its quota ceiling.
- **Wait.** Polls `review.status` every 60 s until the job is `submitted` or `abandoned`; no wall-clock ceiling (a job
  the ceiling holds may wait hours). A job whose factory retry (a2) ended without a submit (`status` shows `hidden.gaveUp`) is cancelled, which abandons it, and recorded `unscored` as `review gave up: <factory state>`; a job merely waiting or queued (the ceiling) keeps polling. A `needs-human` or `skipped` request, an abandoned job, a failed clone and a judge
  answer that is unusable are `unscored` with the reason, never a miss and never in a denominator.
- **Score.** The restored scorer v3 on REVIEW_OUTPUT v4 (`scorer.ts`): the token-overlap preselection, one `eval.judge`
  call (judge `a`, pinned route, purpose `eval`; both judges when `judge-calibration.json` does not clear `KAPPA_BAR`
  for the current judge versions, a disagreement being `unclear`). Bug case: `recall` (an important finding judged
  `match`), `detected`, `severityCalibration`; control: `falseAlarms` (important findings), `clean`; both: `noise`,
  `findings`, `important`, `realOther`. A finding's text for the judge is its message plus its failure scenario.
- **Cleanup.** The clone is removed after scoring; agw removes the job's tree on submit (an unsubmitted one is swept
  after 24 h). A cancelled or crashed run leaves its current clone behind.

The output holds, per case, `tier`, `seat`, `account`, `wallMs` (request to submit, held time included), the findings
(`id`, `tag`, `file`, `line`, the judge's class; no text) and the scores, and per run the `summary`: recall with a Wilson
95 % interval (`wilson` in `gt-stats.ts`), detected, severity calibration, false alarms per control, pooled noise, tier
counts and wall p50 and p95, with `GT_LIMIT`. The metric is defined on `test` (`docs/review-v2.md` §Metrics); `dev` is
for trying the path. The runaway cap's static ceilings for `eval.recall` are $30, 30 days of wall (`STATIC_CEILINGS`), far above a real run; after 20 done runs of its own the learned cap (10 × p95, so a long run after twenty short ones could be stopped) replaces them. The reviews cost no API money; the judge draws on eval credit. `agw eval compare` reads only
`eval.run` suites, so two recall runs are compared by their `summary`.

Cases and reports hold private code and findings, so they never enter this repo: they live under `$AGW_EVAL_DIR`
(default `~/.local/share/agent-workflows/eval`). Only aggregate numbers are published.

## Judge calibration

No human checks the review ground truth (owner decision, 2026-11-02; `docs/review-v2.md` §Ground truth step 5,
§Matching and judging Calibration). The labels are validated by 2-of-3 labeller consensus (below), and the judge by a
second judge on another vendor. Every report that rests on it states `limit: "LLM consensus (labellers a/b/c, judges
a/b), no human check"` (`GT_LIMIT`): the mine's `report.json` and output, the calibration's output and file, and the
recall scorer's notes. The pure parts live in `src/gt-stats.ts` (Wilson interval, Cohen's κ with its 95 % interval,
`KAPPA_BAR`) and `src/gt-sample.ts` (seeded sampling); the workflow in `packages/host/src/workflows/eval-gt/`.

`agw eval gt calibrate --eval-runs <runId> [--pairs 100 --seed 1] [--yes]` (mutating: off a TTY it needs `--commit`).
Needs an eval run whose judge calls are `cap.eval.judge` runs (the `review` suite that `agw eval run review` replayed went with review v1). `agw eval recall` does not produce them: it calls the judge in process, as a step of its own run, so it cannot be calibrated against and `gt calibrate` still has no input. Pass such eval run id(s):

- It reads the `cap.eval.judge` runs below those eval runs and `cases.jsonl`, and builds the pairs from **judge-`a` runs of the current capability version only**: a run with `seat: 'b'` (the scorer's dual mode) and a run whose recorded workflow version is not the current one (or a known earlier one that asked the same judge `a`; `eval-gt/versions.ts`) are skipped and counted in the output. The journal records a hash of the capability's definition per run, not `JUDGE_VERSION`; the pairs (a finding and the
  case's bug): half judge-`a`-positive (`match`), half preselected non-matches (right file, plausible, wrong defect). When
  fewer positives exist than half, all go in, non-matches fill, and the output says the shortfall.
- **Without `--yes`** it prints the plan: pairs, judge-`b` calls (one per judge-`a` run that holds a sampled pair), and an
  estimate (prompt size at the route's rate, a rough figure). Nothing is spent.
- **With `--yes`** it re-asks judge `b` (`eval.judge.b`, GPT) on exactly the recorded judge-`a` inputs, compares per pair
  (match or not), and writes `$AGW_EVAL_DIR/review-gt/judge-calibration.json` (0600, aggregates only): κ with a 95 %
  interval, raw agreement, the confusion table (`yy` both match, `yn` a match and b not, `ny`, `nn`), the agreement on
  the classes of the findings neither judge matched (`real`, `not-a-bug`, `nit`, `unclear`, as a table), `n`, the judge
  versions of both judges (`JUDGE_VERSION`, `JUDGE_B_VERSION`), both judges' models, the eval runs and `at`. Each judge-`b`
  answer is appended to `judge-b.jsonl` as it arrives, so a rerun asks only the missing ones; an unusable answer skips
  its run (counted); any other failure (no credit, an outage) stops the calibration and keeps what was paid for.
- **The bar is κ ≥ 0.8.** The recall scorer reads the file in each `agw eval recall` run's `plan` step: at or above the
  bar for the current judge versions of both judges it asks judge `a` alone; otherwise (below, missing, either judge
  changed) it asks both and a finding they classify differently is `unclear`. The mode and why are in the run output
  (`judges`) and the mode is in the scorer version, so runs of different modes are not mixed.

## Ground truth miner

`agw eval mine review` builds the review ground truth from the owner's own fix history (`docs/review-v2.md` §Ground
truth). Mining spends nothing; labelling spends eval credit and needs `--yes`. Run it with `AGW_PURPOSE=eval`. The command
is `mutating` (off a TTY it needs `--commit`), and one run at a time (`concurrency: 1`): two would race on the files.

```
agw eval mine review                           # mine: candidates, controls, report
agw eval mine review --label 20                # plus the labelling plan and an estimate; spends nothing
agw eval mine review --label 20 --yes          # label the next 20 candidates (2 paid calls each, a third when they disagree)
agw eval mine review --label 0 --yes           # only ask seat c of the records that lack it (IU key, no credit)
agw eval mine review --label 50 --yes --relabel-errors
agw eval mine review --auto --yes              # the workflow sizes the run itself (see below)
```

Measured 2026-11-02 on 150 candidates: $0.068 a candidate ($0.051 Sonnet on the credit, $0.018 Terra on the IU key),
23 % accepted (35 of 150; rejected: both no 76, `b` no 28, no overlap 8, `a` no 3). **Label in batches of at most 60**
until `eval.mine` has 20 done runs: below that the runaway cap applies a static ceiling per run, $30 for `eval.mine`
(`STATIC_CEILINGS` in `boot.ts`; the $5 default stopped a 147-candidate run in its final `cases` step at $10.12, every
label already appended, and a mine-only run rebuilt the cases). Size a batch to the gateway's `evalAvailableUsd` first.

| Flag | Default | Does |
|-|-|-|
| `--label N` | off | Label the next N unlabelled candidates, taken from a seeded shuffle, after adding seat `c` to every record that needs it and lacks it (given with `--yes`, `0` included). Without the flag: mine only |
| `--seed N` | 1 | Seed of the label order and of the control pick |
| `--controls N` | 100 | Clean controls to pick |
| `--concurrency N` | 2 | Candidates in flight (each is two parallel calls) |
| `--relabel-errors` | off | Label again candidates whose last record has an `a` or `b` error, and ask `c` again where it failed; they are never retried otherwise |
| `--auto` | off | Exclusive with `--label`: the workflow decides N (below) and records why in the output's `auto` object. Without `--yes` it only plans |
| `--target N` | 200 | `--auto`: bug cases (dev + test) the ground truth needs; at or above it nothing is labelled (`target-reached`) |
| `--iu-line-usd X` / `--iu-margin-usd X` / `--iu-since T` | 20 / 0.75 / `2026-11-03T00:00:00Z` | `--auto`: the line on IU eval spend (the eval workflows' spend on the personal key, not the key's whole total), the margin kept under it, and when counting starts |
| `--max-per-run N` | 150 | `--auto`: most candidates one run labels (at least 1: a plan of nothing is refused) |
| `--yes` | off | Spend. Without it `--label` prints the plan: candidates, records waiting for seat `c`, and 2 calls × the mean cost of the last 20 `cap.eval.label` runs (or `unknown`) |

**`--auto` sizing** (`packages/host/src/workflows/eval-mine/auto.ts`). Bug cases are `summary.cases.dev.bug + test.bug`
before labelling; at the target the run labels nothing and reads nothing else. Otherwise N is the floor of the smallest of:
90 % of the gateway's eval credit (`/health`: the sum of `evalAvailableUsd` over `evalEligible` pools) over the credit cost
of a candidate; the IU room (`line − margin − IU eval spend`, minus the records still waiting for seat `c`, each at the IU
cost) over the IU cost of a record; `--max-per-run`; the candidates left. The IU side plans with **1.25 × the measured IU
cost per record**: the gateway refuses credit mid-run but nothing stops IU mid-run, so the estimate is the only guard. The
line covers **IU eval spend**, the eval workflows' spend on the personal key, not the key's whole total: it is
`sum(cost_usd)` of `usage.records` with `source='gateway'`, `billing='api_key'`, `api_key='personal'`,
`lane_detail->>'workflow' like 'eval.%'` since `--iu-since` (by workflow, not purpose: some early eval calls were tagged
`prod`). A personal-key eval row in range with no `cost_usd` is unknown spend, not zero: the read fails naming how many, the
night logs it and the next night retries. The cost per payer is pooled over the newest 20 `eval.mine` runs that wrote
records (`usage.records` by `run_id`, journal counts from the run output): credit per candidate is the credit spend over
`labelledThisRun` (a third-seat record costs no credit); IU per record is the IU spend over `labelledThisRun +
thirdSeatThisRun`. Without history: `$0.05` credit / `$0.035` IU. No room under the line is `iu-line`, none in the credit
`no-credit`; both label nothing. With every candidate labelled and the target not reached the run fails (`no unlabelled
candidates are left`); it never reads as a finished night. A read that fails (gateway, `USAGE_PG_URL`, journal) fails the run on its `size` step with
the reason; nothing is planned from a guess. A 403 from the gateway mid-run still ends labelling cleanly (`stopped`).
The run output's `auto`: `{ state: labelled|target-reached|no-credit|iu-line, target, bugCasesBefore, bugCasesAfter,
creditAvailableUsd, creditPerCandidateUsd, iuSpentUsd, iuLineUsd, iuPerCandidateUsd, planned }` (`null` without `--auto`;
the credit and IU reads are `null` at the target).

**The nightly job.** `make eval-mine-job` installs the LaunchAgent `com.jkrumm.agent-workflows-eval-mine` (04:30 daily,
`scripts/eval-mine-daily.sh` of the live release). It runs `AGW_PURPOSE=eval agw eval mine review --auto --yes --commit
--format json --idempotency-key eval-mine-daily-<UTC date>` (a second trigger the same day adopts the run), follows an exit
10 with `agw run wait` for up to 3 h (the run is never cancelled, only the waiting stops), and appends one line to
`~/Library/Logs/agent-workflows-eval-mine.log`:

```
2026-11-04T04:41:07Z bug cases 61/200 (dev 33, test 28); labelled 40 (+2 third seat), accepted +18; credit available 3.21, run cost 2.76; IU eval 2.7 of 20 before the run; planned 40; state labelled; run <runId>
```

A failure logs `FAILED: <reason>` and exits non-zero. `run cost` is the run's total over both payers (the run record has no
per-payer split); the IU eval spend after the run is the next night's `IU eval … before the run`. At `target-reached` the script logs
it, removes its own plist and boots the label out, so it never runs again.

**Files**, all under `$AGW_EVAL_DIR/review-gt/` (dirs 0700, files 0600; cases name private repos):

| File | Written | Holds |
|-|-|-|
| `candidates.jsonl` | whole, by every mine | SZZ candidates (`GtCandidate`) |
| `labels.jsonl` | appended as each candidate finishes; a record that gains seat `c` is appended again whole, and the latest line of a candidate wins | each seat's answer (`GtLabelRecord`: `a`, `b` under `labelerVersion`; `c` under its own `cVersion`, with `cRunId`); the resume point |
| `cases.jsonl` | rebuilt by every run | accepted bugs and clean controls (`GtCase`), what the former `agw eval run review` read |
| `rejected.jsonl` | rebuilt by every run | candidates the labelers did not accept, with the reason |
| `report.json` | by every run | the funnel, the accepted count per pair of seats (`a+b`, `a+c`, `b+c`), the rejected count per reason, the `limit`; no code. After an incomplete mine: `incomplete: true` and the repos that failed, with their errors |
| `judge-calibration.json` | by `agw eval gt calibrate` | the judges' κ and agreement (see Judge calibration); aggregates only |
| `judge-b.jsonl` | appended as each judge-`b` answer arrives | `JudgeBRecord`: judge `b`'s answer on one judge-`a` call, keyed by its run id and `JUDGE_B_VERSION`; the calibration's resume point (the answers' reasons, so private) |
| `owner.json` | by the owner, read only | `{ "emails": [...] }`: the author emails that count as the owner's |

Every file is written to a temp file and renamed, so a reader or a crash sees the old file or the new one.

**Mining** (`packages/eval/src/mine/`, pure over an injected `Exec`; bump `MINER_VERSION` on any filter change):

- **Repos:** every direct child of `$HOME/SourceRoot` with a `.git` directory, minus `dispatch-scratch`, `brain`,
  `dotfiles-private` and dot names. Linked worktrees and nested repos are not walked. History is `HEAD`'s.
- **Owner:** commits whose author email is in the owner set; merges never count. The set is private, so it is not in
  the source: `AGW_EVAL_OWNER_EMAILS` (comma separated) over `owner.json`. Mining refuses, naming both, without one.
- **Fix commits:** the owner's `fix`, `revert` and `Revert ` subjects, minus any whose scope or subject names deps, ci,
  docs, release, style, lint, typo, format or fmt.
- **SZZ:** the removed and changed lines of each fix (`git show -U0`), minus blank lines, comment-only lines,
  whitespace-only changes and non-code files, are blamed at the fix's parent with `git blame -w -M -C`. Mass reformats
  (a style or chore subject naming a formatter, or 20 or more files with 80 % or more whitespace-only changed lines)
  go into an ignore-revs file, so blame looks past them.
- **Kept introducing commits:** the owner's, not a merge, at most 182 days before the fix by author date, at most 1,500
  changed lines. One candidate per (fix, introducing commit).
- **Controls:** owner commits at least 84 days old that change a code file, have at most 1,500 changed lines, and that
  no fix commit's blame landed on at all (the blame is taken before the owner, age and size filters). Docs, test,
  refactor and chore commits are at most 15 % of the picked sample, also when logic commits run short. Only the owner's fixes count as fix commits, so a later fix by someone else
  does not disqualify a control.
- **Split:** `dev` when the first 8 hex of `sha256(id) / 2^32` is below `DEV_SHARE`, else `test`; bugs and controls alike.
- **Labellers:** `a` (Claude), `b` (GPT) and `c` (Gemini, a third vendor). `c` is asked only when `a` and `b` disagree:
  one says defect and the other not (`a-no`, `b-no`), or both say defect at locations that do not overlap or are missing (`no-overlap`, `no-location`).
  Not on `both-no`, not when both accept, not on a seat error.
- **Acceptance (2 of 3):** at least two seats say defect and the locations of two of those name the same file within
  `LOCATION_SLACK` lines of each other. The case takes the location, description, class and severity of seat `a` when
  `a` is in the agreeing pair, else of the pair's first seat (`b` in `b+c`). Otherwise the reason is `a-no`, `b-no`,
  `both-no`, `no-overlap` or `labeler-error` for a record without `c`, and with `c`: `c-no` (it says no), `c-no-overlap`
  (it says defect, but its location overlaps neither), `c-error` (it failed with an answer) or `no-location` (fewer
  than two defect answers name a place: a `defect: true` with `location: null` cannot form a pair). `c` is asked whenever
  `a` and `b` answered, one says defect and they do not agree, a defect without a place included.
- **Seat `c` and the versions.** `LABELER_VERSION` covers `a` and `b` only; `c` has `LABELER_C_VERSION`, stored on the
  record as `cVersion`, so adding `c` never invalidates a record's `a` and `b`. A `c` under another version is treated
  as not asked. Resume asks `c` alone of the disagreeing records that lack it (the record is appended again with `c`;
  `latestLabels` keeps the last line per candidate) and never asks `a` or `b` again; it costs the IU key only, no credit.

**Bias.** An additions-only fix (a missing guard, a new check) has no removed line to blame, so it yields no candidate.
Published SZZ studies put these near 17 % of fixes. The report states the loss; the eval's recall numbers read as recall
on bugs whose fix removed or changed code. Precision is the other limit: SZZ alone is about 50 % right, which is why
every candidate is labelled twice, and a third time when the first two disagree, before it becomes a case. No human checks the result; the report states `limit: "LLM consensus (labellers a/b/c, judges a/b), no human check"`.

**An incomplete mine stops.** A repo whose history cannot be read, or a root with no repos at all, would shrink the
ground truth without a word. The run fails instead, naming the repos; `report.json` holds their errors, and
`candidates.jsonl` and `cases.jsonl` stay as they were.

**Resume and stops.** A line of `labels.jsonl` that is not JSON (a torn write) is skipped with a warning naming
`file:line`; the next record starts a line of its own. A candidate with a record under the current `LABELER_VERSION` is never labelled again (only its seat `c` can be added), and a
resumed run counts the records it already wrote against `--label`. A stop on seat `c` keeps the record of `a` and `b`. A seat that fails with an answer (unusable or
truncated output, a refused input, a vendor refusal) is recorded as that seat's `{error}`, and so is a commit that is gone from the checkout (both seats). Any other error, such as the
gateway's 403 "no eval credit", an outage or a git failure other than a missing commit (a lock, a missing checkout),
stops labelling: the run reports it, keeps what it wrote and records
nothing for the candidate in flight. The journal keeps counts only; subjects, shas and diffs stay in the files.

**Costs.** Mining is git only: a read of every repo's history plus one `git show` and a few `git blame` calls per fix
(about two minutes of wall time on the owner's checkouts). Labelling is two calls per candidate, one per vendor, each
sent both diffs; `--label` without `--yes` prices that from the last 20 `cap.eval.label` runs once the host passes the
journal's cost history to the workflow, and prints `unknown` until then.

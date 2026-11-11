# @agent-workflows/eval

The data side of the evals (concept §6): case schemas and the reader/writer of `$AGW_EVAL_DIR/<workflow>/cases.jsonl`
(`CheckCase`, `PlainCase`, `casesPath`), the paired comparison of two arms (`compareArms`, seeded bootstrap CIs; the
`agw eval compare` workflow reads it), the throwaway case checkout (`materialize`, `exec`) that `agw eval run` replays
cases on, and the review ground truth (`gt*.ts`, `mine/`) below. The side-by-side harness of the P1 cutover gate, its
`ReviewCase` reader and the 138 legacy review cases went with review v1: the review is v4 host operations now, which
`agw eval run` cannot replay (it is no workflow). The ground truth's replay arm (`agw eval recall`) was removed with the hidden review transport.

`factory-ask` (`src/factory-ask.ts`, cases in `factory-ask/cases.jsonl`) is the eval of the factory's Judge: the case and
reference schemas and the pure scorer behind `agw eval run factory-ask`. Its cases are the one set committed here: real
factory Decisions scrubbed of private names, hosts and ids (the factory's questions name no code), guarded by
`test/factory-ask.test.ts`.

Cases and reports hold private code and findings, so they never enter this repo: they live under `$AGW_EVAL_DIR`
(default `~/.local/share/agent-workflows/eval`). Only aggregate numbers are published.

## Judge limit

No human checks the review ground truth (owner decision, 2026-11-02; `docs/review-v2.md` §Ground truth step 5,
§Matching and judging). The labels are validated by two-labeller consensus (below), and the findings by two judges on
different vendors. Every report that rests on it states `limit: "LLM consensus (labellers a/b, judges a/b), no human
check"` (`GT_LIMIT`): the mine's `report.json` and output. `src/gt-stats.ts` holds the
Wilson interval.

Judge calibration (`agw eval gt calibrate`, a single-judge mode gated by `judge-calibration.json`) was removed
2026-11-03: it had no source of judge-`a` calls. Wave 11 may add a calibration back with a real source.

## Ground truth miner

`agw eval mine review` builds the review ground truth from the owner's own fix history (`docs/review-v2.md` §Ground
truth). Mining spends nothing; labelling spends eval credit and needs `--yes`. Run it with `AGW_PURPOSE=eval`. The command
is `mutating` (off a TTY it needs `--commit`), and one run at a time (`concurrency: 1`): two would race on the files.

```
agw eval mine review                           # mine: candidates, controls, report
agw eval mine review --label 20                # plus the labelling plan and an estimate; spends nothing
agw eval mine review --label 20 --yes          # label the next 20 candidates (2 paid calls each)
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
| `--label N` | off | Label the next N unlabelled candidates, taken from a seeded shuffle. Without the flag: mine only |
| `--seed N` | 1 | Seed of the label order and of the control pick |
| `--controls N` | 100 | Clean controls to pick |
| `--concurrency N` | 2 | Candidates in flight (each is two parallel calls) |
| `--relabel-errors` | off | Label again candidates whose last record has an `a` or `b` error; they are never retried otherwise |
| `--auto` | off | Exclusive with `--label`: the workflow decides N (below) and records why in the output's `auto` object. Without `--yes` it only plans |
| `--target N` | 200 | `--auto`: bug cases (dev + test) the ground truth needs; at or above it nothing is labelled (`target-reached`) |
| `--iu-line-usd X` / `--iu-margin-usd X` / `--iu-since T` | 20 / 0.75 / `2026-11-03T00:00:00Z` | `--auto`: the line on IU eval spend (the eval workflows' spend on the personal key, not the key's whole total), the margin kept under it, and when counting starts |
| `--max-per-run N` | 150 | `--auto`: most candidates one run labels (at least 1: a plan of nothing is refused) |
| `--yes` | off | Spend. Without it `--label` prints the plan: candidates and 2 calls × the mean cost of the last 20 `cap.eval.label` runs (or `unknown`) |

**`--auto` sizing** (`packages/host/src/workflows/eval-mine/auto.ts`). Bug cases are `summary.cases.dev.bug + test.bug`
before labelling; at the target the run labels nothing and reads nothing else. Otherwise N is the floor of the smallest of:
90 % of the gateway's eval credit (`/health`: the sum of `evalAvailableUsd` over `evalEligible` pools) over the credit cost
of a candidate; the IU room (`line − margin − IU eval spend`) over the IU cost of a record; `--max-per-run`; the candidates left. The IU side plans with **1.25 × the measured IU
cost per record**: the gateway refuses credit mid-run but nothing stops IU mid-run, so the estimate is the only guard. The
line covers **IU eval spend**, the eval workflows' spend on the personal key, not the key's whole total: it is
`sum(cost_usd)` of `usage.records` with `source='gateway'`, `billing='api_key'`, `api_key='personal'`,
`lane_detail->>'workflow' like 'eval.%'` since `--iu-since` (by workflow, not purpose: some early eval calls were tagged
`prod`). A personal-key eval row in range with no `cost_usd` is unknown spend, not zero: the read fails naming how many, the
night logs it and the next night retries. The cost per payer is pooled over the newest 20 `eval.mine` runs that wrote
records (`usage.records` by `run_id`, journal counts from the run output): credit per candidate is the credit spend over
`labelledThisRun`; IU per record is the IU spend over `labelledThisRun`. Without history: `$0.05` credit / `$0.035` IU. No room under the line is `iu-line`, none in the credit
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
2026-11-04T04:41:07Z bug cases 61/200 (dev 33, test 28); labelled 40, accepted +18; credit available 3.21, run cost 2.76; IU eval 2.7 of 20 before the run; planned 40; state labelled; run <runId>
```

A failure logs `FAILED: <reason>` and exits non-zero. `run cost` is the run's total over both payers (the run record has no
per-payer split); the IU eval spend after the run is the next night's `IU eval … before the run`. At `target-reached` the script logs
it, removes its own plist and boots the label out, so it never runs again.

**Files**, all under `$AGW_EVAL_DIR/review-gt/` (dirs 0700, files 0600; cases name private repos):

| File | Written | Holds |
|-|-|-|
| `candidates.jsonl` | whole, by every mine | SZZ candidates (`GtCandidate`) |
| `labels.jsonl` | appended as each candidate finishes; a relabelled candidate is appended again whole, and the latest line of a candidate wins | each seat's answer (`GtLabelRecord`: `a`, `b` under `labelerVersion`); the resume point. Legacy `c`, `cVersion`, `cRunId` fields of the removed third seat still parse and are ignored |
| `cases.jsonl` | rebuilt by every run | accepted bugs and clean controls (`GtCase`), what the former `agw eval run review` read |
| `rejected.jsonl` | rebuilt by every run | candidates the labelers did not accept, with the reason |
| `report.json` | by every run | the funnel, the accepted count (`acceptPaths`: `a+b`), the rejected count per reason, the `limit`; no code. After an incomplete mine: `incomplete: true` and the repos that failed, with their errors |
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
- **Labellers:** two, `a` (Claude) and `b` (GPT), both called for every candidate.
- **Acceptance:** `a` and `b` both say defect and their locations name the same file within `LOCATION_SLACK` lines of
  each other. The case takes the location, description, class and severity of seat `a`. Any other outcome is a rejection
  with its reason: `a-no` or `b-no` (they disagree on defect), `both-no`, `no-overlap` (both say defect, places apart),
  `no-location` (a `defect: true` with `location: null`) or `labeler-error`.
- **Versions and legacy fields.** `LABELER_VERSION` covers `a` and `b`. Stored `labels.jsonl` records may carry the
  fields `c`, `cVersion` and `cRunId` of a removed third labeller (and `rejected.jsonl` the reasons `c-no`,
  `c-no-overlap`, `c-error`): they still parse, acceptance ignores them, and nothing writes them.

**Bias.** An additions-only fix (a missing guard, a new check) has no removed line to blame, so it yields no candidate.
Published SZZ studies put these near 17 % of fixes. The report states the loss; the eval's recall numbers read as recall
on bugs whose fix removed or changed code. Precision is the other limit: SZZ alone is about 50 % right, which is why
every candidate is labelled by both labellers before it becomes a case. No human checks the result; the report states `limit: "LLM consensus (labellers a/b, judges a/b), no human check"`.

**An incomplete mine stops.** A repo whose history cannot be read, or a root with no repos at all, would shrink the
ground truth without a word. The run fails instead, naming the repos; `report.json` holds their errors, and
`candidates.jsonl` and `cases.jsonl` stay as they were.

**Resume and stops.** A line of `labels.jsonl` that is not JSON (a torn write) is skipped with a warning naming
`file:line`; the next record starts a line of its own. A candidate with a record under the current `LABELER_VERSION` is never labelled again, and a
resumed run counts the records it already wrote against `--label`. A seat that fails with an answer (unusable or
truncated output, a refused input, a vendor refusal) is recorded as that seat's `{error}`, and so is a commit that is gone from the checkout (both seats). Any other error, such as the
gateway's 403 "no eval credit", an outage or a git failure other than a missing commit (a lock, a missing checkout),
stops labelling: the run reports it, keeps what it wrote and records
nothing for the candidate in flight. The journal keeps counts only; subjects, shas and diffs stay in the files.

**Costs.** Mining is git only: a read of every repo's history plus one `git show` and a few `git blame` calls per fix
(about two minutes of wall time on the owner's checkouts). Labelling is two calls per candidate, one per vendor, each
sent both diffs; `--label` without `--yes` prices that from the last 20 `cap.eval.label` runs once the host passes the
journal's cost history to the workflow, and prints `unknown` until then.

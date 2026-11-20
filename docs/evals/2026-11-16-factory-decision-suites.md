# First runs of the factory-decision suites, and the references refreshed (2026-11-16)

> 2026-11-20: the `factory-digest` workflow, its suite and route were removed (software-factory builds the digest in code); its row below is history.

Issue 1602. Five model decisions that steer the factory had no eval: `factory-steward`, `factory-queue`,
`factory-fix-classes`, `factory-digest` and the `factory-hygiene` agent. Each now has a committed suite and a scorer with a
score beyond `valid` (`packages/host/src/workflows/<id>/eval/cases.jsonl`, `scorer.ts`; the steward's arm comparison is
`2026-11-16-steward-wording.md`, the judged drift scores `2026-11-16-judged-drift.md`). This is the first run of each on the
deployed release, on the route as the table has it, with the limits each number carries. One run each: these are baselines for
the next change, not comparisons.

| Suite | Cases | Scorer | Result | USD |
|-|-|-|-|-|
| `factory-steward` | 14 | `2026-11-16.1` | per action, in the wording report: 76 % correct on the new wording, 62 % on the old | 0.0105 a run |
| `factory-queue` | 10 | `2026-11-16.1` | 9 of 10 pass; `edgeRecall` 0.83 (5 of 6 pairs), `quiet` 1.00 (4 of 4) | 0.0060 |
| `factory-fix-classes` | 9 (33 commits at the first run, 30 now) | `2026-11-16.1` | 25 of 33 commits right; 25 of 30 once three contested labels are dropped | 0.0053 |
| `factory-digest` | 9 | `2026-11-16.1` | 8 of 9 pass; `riskRecall` 0.67, `sections`, `grouped`, `quiet`, `nextEmpty` and `clean` 1.00; `judged` 0.22 | 0.0032 |
| `factory-hygiene` | 3 | `2026-11-16.1` | 2 of 3 pass; `recall` 0.96 (7 of 8 plants in the full case), `anchored`, `precision` and `cleanKept` 1.00 | 0.0139 |

## What each run shows

- **Queue.** The one miss is the pair where the later Issue's own words say it is unrelated to the earlier one ("pre-dates the
  mount work and is unrelated to it") and the factory later closed it as already fixed by that work; the seat answered "no queued Issue shares a
  file or feature" and proposed nothing, as the Issue's own words invite. Every other edge pair was found, and no quiet queue got an edge. The order is not scored (README: no independent truth).
- **Fix classes.** Five commits are wrong on the 30-commit set, and they are the readings two people would split: a fix of the
  `GIT_CONFIG` environment family called `logic` against `environment`; a gateway `/health` fix called `logic` against `contract`;
  a CLI project header called `logic` against `environment`; the removal of dead pushes called `contract` against `other`. One
  is not a reading: a test-only fix (a timing race in a test) was called `concurrency`, where the class `tests` says "in tests
  only". The first run also missed three fixes of deploy and probe scripts that the set had labelled `tooling` from their
  paths; the seat said `environment` (deploy, host), which the class's own words allow, so the three were dropped from the set
  as labels two readers would split.
- **Digest.** `judged` 0.22 is the finding: the judge calls 7 of 9 digests unfaithful, and in the three digests read for this
  report it is right: the Haiku-no-thinking digest writes "so customers can see when they will be charged" and "for users who prefer a
  darker interface" for Issues whose titles say neither. The deterministic scores say the structure is sound (right lists,
  grouped themes, no canary). The one real structural miss: a fix that followed the export it fixes, and dropped work, were
  not named as risks. The judge's own probe (judged-drift report) had it refuse one faithful digest in three, so 0.22 is a
  lower bound on faithfulness, not an estimate of it.
- **Hygiene.** The agent found 7 of 8 plants and nothing on the clean controls, at 11 to 19 tool calls and $0.003 to $0.007 a
  case. The missed plant is the weakest of the three filler plants (`docs/roadmap.md`: "describes the future plans"); the
  controls-only case and the mixed case passed.

## The other references

| Reference | State before | Done |
|-|-|-|
| `otel` | 8 prod windows of 2026-10-25 to 28; did they still hold data? | All eight hold it. Counts read from ClickStack match the references (12 `research-gateway` error logs in the 03:00 hour of the 28th, 30 `email-gateway` error logs in the window, 99 `weatherorb-tileserver` spans on the 26th). `agw eval run otel` returned data for every case: 8 scored, `status` right 8 of 8, `facts` 0.94, `grounded` 0.78, $0.048. The windows will age out with the retention; refresh them from live incidents then (the refresh recipe is the research suite's, README) |
| `prose` | references recorded on the DeepSeek route that `prose.review` left on 2026-11-04 | Re-recorded on the current route (`gpt-6.1-terra`, medium): one run's `review.scores` and lint findings per case. Lint was identical in all 10 cases (it is code); every score set changed. Agreement against the old references 0.86; a second run against the new ones 0.96, which is the route's own noise: a prose arm now scores against a reference it can reach, and the ceiling is 0.96, not 1 |
| `check` | references recorded from a legacy run of 2026-10-27, with a `fallow` step the current workflow does not run | Re-recorded from one run of the current workflow on each recorded tree (`passed` and each step's outcome). The legacy run and the current one disagreed on the outcome in 2 of 7 cases (one that was red only under `fallow`, one whose recorded `check` failure no longer reproduces) and on the steps in 2 (one of them the same case), which is the 0.86 ceiling every arm scored. Two dotfiles cases read the host's live launchd state, so their reference can drift with the host: re-record them when `make doctor` changes |
| `diagram` | structure only (bound arrows, overlaps, element count) | Not changed: the scorer does not check that the diagram matches its brief. A judged score is the same shape as the one added for digest and spec-screen and is its own Issue |

The `eval-mine`, `review-gt` and other review-ground-truth files are untouched. The previous references stay beside the
cases as `cases.2026-11-02-deepseek-flash.jsonl` (prose) and `cases.2026-10-27-legacy-runs.jsonl` (check) under
`$AGW_EVAL_DIR`.

## Spend

17 eval runs and about 30 direct `decide` calls, **$0.35 in all**, on the gateway's eval reserve and the IU key (`decide`):
steward $0.10 (9 runs, 126 case runs), hygiene $0.014, queue $0.006, fix-classes $0.005, digest $0.003, otel $0.048, prose
$0.17 (two runs), check $0 (`make check` on 7 recorded trees; no model), judge probes $0.001. No full-suite rerun and no run to
confirm a refactor; the arms ran three times each because 14 cases at one run cannot tell a 7-point difference from noise.

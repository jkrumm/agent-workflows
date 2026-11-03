# Evals (concept §6)

`src/workflows/eval/` serves the regression and comparison side of the scorers; `review` and `check` carry a scorer
(`src/workflows/{review,check}/scorer.ts`), attached for regression and drift only: neither workflow calls
`ctx.score`, so production behaviour is unchanged (an inline gate is a later experiment).

A module's suite reads its cases from `$AGW_EVAL_DIR/<workflow>/cases.jsonl` unless it declares `path(env)`: review's
reads the ground truth, `$AGW_EVAL_DIR/review-gt/cases.jsonl`, and its `tree` carries `isolate: true`, which
`materialize` turns into a clone with no refs, no reflog and no shared object store, so a later commit is unreachable from a shell.

| Command | Does |
|-|-|
| `agw eval run <review\|check\|research> [--ids a,b] [--limit N] [--concurrency N] [--args '{…}'] [--arm <file>] [--yes]` | Without `--yes`: the plan (selected case ids) and an estimate (mean cost of the workflow's latest 50 done runs × cases), nothing runs. With `--yes`: each case materialized like the harness does (`materialize` from `@agent-workflows/eval`; a plain case, research's, needs no tree and runs its recorded input), run as a child of the eval run (`parent_id`; its own root, so it is leased and redelivered on its own by the process that serves the workflow) with purpose `eval`, scored against the case's reference, the verdict and the arm's `args` recorded on that run (`scores.final`); the output lists per-case scores and cost (`costUsd`, `unpricedCalls`, read once the case run's record is written), the fingerprints, the means and the case runs' total (`summary.costUsd`). The eval run's own `cost` in the journal is the whole spend: its case runs and the regression judge calls, all its descendants |
| `agw eval compare <review\|check> --a <fp> --b <fp> [--a-args '{…}'] [--b-args '{…}'] [--a-workflow <id>] [--b-workflow <id>] [--seed N]` | Two arms paired by case id: per metric the means, the mean and median delta (B − A) with seeded bootstrap 95% CIs (harness `stats.ts`), and which arm the CI favours. Scores are higher-is-better except `falseAlarms`, `noise`, `findings`, `important` and the spend metrics `costUsd`, `wallMs`, `tokens`, `toolCalls` (`LOWER_IS_BETTER`). Reads only |
| `agw eval import <review> --label <name> --findings <file> [--ids a,b] [--concurrency N] [--yes]` | Scores an external arm's findings (the native `/code-review` session per ground-truth case, `docs/review-v2.md` §Arms) with the suite's own scorer, so it is judged like every arm. Without `--yes`: the plan (cases to score, `missing` cases, finding count, judge calls) and nothing runs. With `--yes`: an eval run whose case runs are the internal workflow `review.imported` (no model call: it turns the findings into a REVIEW_OUTPUT v2, `important` → `blocking`, `nit` and `pre-existing` → `improvements`, `angle` = the label), keyed, parented, scored (`source: regression`, the review scorer's version, the very instance the `review` workflow registers: one `eval.judge` call per case with a finding when the calibration clears the bar, a call per judge otherwise) and rolled up like `eval run`'s. No clone: the scorer reads the commit's diff from the owner's checkout |
| drift (no command) | every `AGW_DRIFT_INTERVAL_S`, up to 20 sampled, unscored production runs of a workflow with a scorer are scored (`source: drift`); the sample is a hash of the run id, the write first-writer-wins, so several hosts never score a run twice. A tick counts verdicts and recorded scorer errors apart (and warns on errors) |

**Suites by workflow** (each module's `eval/cases.jsonl` is committed and synthetic unless noted; the scorers are deterministic, none calls a judge):

| Workflow | Cases | Scorer measures |
|-|-|-|
| `digest`, `factory-classify` | committed | see their READMEs |
| `narrative` | 6, a `fixture` of commits, `polish: false` | `changed`, shape, must-mention terms, no removed mechanism as current, no hash or canary, length band, dated entries |
| `prose-polish` | 8 drafts with planted lint issues | lint recomputed (honest, not worse, fixed), planted phrases gone, must-keep facts, length band |
| `overview` | 6 fleets as a `fixture` | every agent once, answered, recommendation match |
| `retrospective` | 5 `fixture` samples of runs | grounded evidence, planted patterns found, restraint, no canary, URL or path |

- **Spend gate: `--yes`, not `--commit`.** The CLI's `--commit` gate (mutating operations) applies only off a TTY and
  shows nothing first; an eval spends IU money (concept N8) whoever types it, so `eval.run` is not `mutating`: the
  default answer is the plan with the estimate, and only `--yes` spends.
- **Purpose.** Eval commands run as purpose `eval` without `AGW_PURPOSE` (`EVAL_WORKFLOW_IDS` in `operations.ts`); an explicit `x-agw-purpose` wins.
- **An arm is a fingerprint plus the exact `--args`.** A workflow input that is not part of the fingerprint
  changes behaviour without changing the fingerprint, so compare selects by both: equal fingerprints compare when the args differ, and two
  identical arms are refused. A fingerprint may be given as a unique prefix (8+ characters). Reruns of a case in one
  arm are averaged before pairing; a run with unpriced calls leaves its cost out instead of comparing a lower bound;
  mixed scorer versions and fewer than 10 paired cases are reported as `warnings`.
- **`--arm <file>`: route patches and params for this eval only.** The file is an arm, `{ routes?: { <route id>:
  <patch> }, params?: { <name>: <json> } }` (routes README §Arms); the CLI sends its content, never the path. It is
  validated at admission (an unknown route, a bad patch, a model the table does not name, an effort the model's
  provider does not take, an agent model the OpenCode server does not serve: refused before any run exists, naming the
  route), kept in this run's input and on its row (`runs.arm`), and copied to every run below it: case runs and their
  fan-out children. The judge is not armed: the regression judge's calls are children of the eval run (`unarmed`, so
  they count in its cost) and the inline gate's judge passes no arm, so an arm patching `cheap.*` never changes the
  grader. An arm whose `routes` and `params` are both empty is no arm (the baseline).
  Each of those resolves every route with the patch; any other run, concurrent or not, resolves the table, so an arm
  needs no restart and never moves production. The arm is part of the fingerprint of the eval run and of each case
  run, so `compare` tells arms apart by fingerprint alone. Workflows read `params` with a default (`ctx.param`). A
  release before migration 0015 ignores `runs.arm`: drain armed eval runs before rolling back past it.
- **`eval import`: the file, the label, the compare call.** `--findings` is a JSON file, case id → findings:
  `{"<case id>": [{"file": "src/a.ts", "line": 12, "endLine": 14, "message": "…", "tag": "important"}]}`. `tag` is
  `important | nit | pre-existing`; `line` and `endLine` are optional (`endLine` needs `line`; the scorer sees `file`,
  `line` and `message`, so a range travels in the message as `(lines 12-14)`). An empty list is a review that found
  nothing: scored without a judge call. A bad finding (named by case and index) or a case id the suite does not have
  refuses the import before any case run starts; a suite case the file lacks is reported as `missing` and not run,
  never scored as 0. `--label` is the arm (`params.external`): each label has its own fingerprint, stable for the same
  label, so import a changed file under a new label. Re-sending the same import with the same `--idempotency-key`
  returns the first run, so no case is run or judged twice; a resumed import adopts its case runs as `eval run` does.
  The case runs make no model call, so `summary.costUsd` is the case runs only; the judge calls are children of the
  eval run, and its own `cost` is the import's whole spend.
  Compare it against a `review` arm by case id: `agw eval compare review --a <review fp> --b <imported fp>
  --b-workflow review.imported` (`--a-workflow` likewise). An imported side has no cost, wall time, tokens or tool
  calls here: compare reports them as `null` (`n: 0`, `better: unknown`), never as 0, and warns `imported arm: cost and
  wall are not measured`.
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
- **Cost.** Case runs and the regression judge's call runs are children of the eval run (`parent_id`), so the run
  record sums their steps into the eval run's `cost`. A case's `costUsd` is read from its run record once delivered;
  a record given up on, or still missing 120 s after the run ended, is reported as last read with `unpricedCalls` at
  least 1 (a lower bound) and logged. A scoring that fails after that read keeps the cost on the error result.
  Cancelling the eval run cancels its case runs and judge calls in the journal (every descendant by `parent_id`), so
  a host that dies after the cancel, or a case slower than the 30 s settle, leaves none running. Not covered: a resumed eval that adopts a case run started
  before case runs were children (no `parent_id`) reports that case's cost in its output, but the eval run's `cost`
  leaves it out, and so do the judge calls scored for it before then.
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
  or `drift` (a regression call inside `agw eval run` is a child of the eval run, so the eval's cost includes judging), keyed by the score source (drift also by its pass, the UTC day), the scorer version, the scored run, the capability and its input under the
  shared attempt rule (a retried scoring adopts a finished call and re-runs a failed one; a drift re-score under a new
  scorer fetches fresh; an aborted scoring cancels the call it started); an inline gate (none judges today) calls in process on its step. Only a failure that is an
  answer comes back (`answerOf`: a 4xx from the source, such as a page gone, forbidden or rate-limited, or a package
  not found; a refused URL; as `{error: {code, message}}`);
  every other failure, an outage, throws and the scoring retries.
  Check's scorer never judges; review's makes one `eval.judge` call per scored regression run with findings (`review/README.md` §Scorer), none on drift. **Drift on research** spends per sampled run up to three `web.fetch` (direct
  or Tavily Extract, ≈ $0) and three `decide` calls on ≤ 20k characters each (≈ 5k tokens at $0.04/M, ≈ $0.0002 each):
  ≈ $0.001 per scored run, as up to six `cap.*` runs with purpose `drift`; drift has no reference, so no `web.package`.

## Media suites

Three suites for workflows that spend on images and audio; all cases are synthetic (the repo is public), all scorers
deterministic (no judge call), each scorer unit-tested on perfect, partial and broken outputs.

|Suite|Process|Cases|Scores (0 or 1 unless said)|Cost of a run|
|-|-|-|-|-|
|`image-icon`|host|6 (`image-icon/eval/`, masters drawn by `generate.ts`)|`valid`, `files`, `dimensions`, `manifest`, `svg`, `background`, `cost`; with a reference `steps`, `alpha`|$0 to about $0.022 (cases 05, 06 run no model)|
|`podcast`|audio|5 (`podcast/eval/cases.jsonl`: 3 minutes, `research`, `cover`, `brainNote`, `publish` all off)|`valid`, `metadata`, `language`, `chapters`, `duration`, `cost`; with a reference `grounded`|the most expensive workflow: the full room plus TTS of 3 minutes|
|`speech-roundtrip`|audio|6 (3 English, 3 German, one with digits)|`valid`, `werOk`, `pace`, `recorded`; reported `wer` (0..1, lower is better) and `secondsPerWord`|TTS and STT of one sentence, about $0.001|

`speech-roundtrip` is an eval-only workflow in the audio process (`packages/audio/src/workflows/speech-roundtrip/`, internal:
no HTTP route, no CLI command, not on the door). It speaks a sentence on `ttsRoute`, transcribes the audio on `sttRoute` (both
inputs, so `--args '{"sttRoute":"audio.stt.openai"}'` is an arm) and returns the transcript, the audio's length and each
leg's route, calls and price. Speech and transcription are the audio door, not workflows, so this is where they get a score.

### The audio process's suites: what is built, what is missing

The audio modules declare their suite and scorer the way the host's do (`speech-roundtrip` has `suite`; `podcast` exports
`podcastSuite` without declaring it, see below), and the scorer is on the workflow definition, so the process that
runs a case also holds the code that scores it. What is **not** there is the host's side: `agw eval run|compare` is served by
the host, which reads suites from the host's modules only (`suitesOf(hostModules)`) and starts and scores a case through its own
`Runtime` (`runtime.start(workflow)` registers the workflow it is given and then claims and drives the run itself;
`scoreRun` takes the scorer from the runtime's registry). The host can neither list `speech-roundtrip` among the eval
workflows nor start it without driving it with a stand-in, in a process that has none of its deps. The smallest correct wiring
needs a change in `packages/runtime` (a workflow the runtime knows for `start` and `scoreRun` only, never claimed, recovered
or counted: `RuntimeOptions.foreign`), in `packages/host/src/boot.ts` (hand the audio modules' declarations to `suitesOf` and
`wireEval`) and a way for the host to get the audio modules' suites and scorers without importing the audio package (it
depends on the host). That is more than the 150 lines this change was allowed, and two of the files are not this change's to
touch.

`podcast` is held back for a second reason: the produce stage's Slack notice (`PODCAST_NOTIFY_CHANNEL`, set in the audio
process's env) is sent for every finished episode whatever `publish` says, so an eval run would post to the channel. With
`publish: false`, `cover: false` and `brainNote: false` nothing else leaves the process (the show's history reads only
`purpose = 'prod'` runs, so eval episodes never feed the next one). Declare `suite: podcastSuite` once the notice is skipped
for purpose `eval`.

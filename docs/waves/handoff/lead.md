# Lead handoff — Wave 16 (Accounting and eval import): CLOSE-OUT

Lead `agent-workflows-w1-r12`, spawned by mother `agent-workflows-w1-r4`, 2026-11-02 ~20:30 → ~23:35 local. Wave 8's
pre-session close-out is in git history (`e637fcc`).

## Delivered

| What | Where |
|-|-|
| `agw eval import <suite> --label <arm> --findings <file>`: an external arm's findings (case id → `{file, line?, endLine?, message, tag}`) scored by scorer v3 as internal `review.imported` case runs (no model call; judge only for cases with findings); each label its own fingerprint; `agw eval compare … --b-workflow review.imported` pairs it with a `review` arm by case id, cost and wall reported as not measured | #117 `53e4841`..`148e3dc` |
| Failed agent steps keep their spend: `WorkflowError.carryUsage` (read-only after; `Cancelled` ignores it), OpenCode `wait`/`waitTurn` carry what they read, a failed outcome re-reads the session once, a gone session keeps what was seen, a balance fallback reports both sessions (`AgentResult.usage` is `Usage \| Usage[]`); a prompted wait that fails with nothing to report adds one unpriced report (unknown, never free); an infra error adds nothing (re-attach) | #118 `119da22`..`f20c90d` |
| `cost` null means unknown only: a step that ended `done` with no report records 0; failed or cancelled without a report, or only unpriced reports, stays null. Run roll-up: the known sum when any step is positive, else null on a null step or an unpriced call, else 0. Outbox candidates `cost > 0` (migration 0016 builds `steps_usage_outbox` first, then drops the old index); `scripts/verify.sh` follows; `trackUsage` zero calls = 0 | #115 `08e59d0`..`b8986eb` |
| Door errors are run failures: speech door and image door, an answer ≥ 400 ends the run `failed` (`invalid_input` for 400/413/422, else `error`) with the step's usage kept and the status plus error text in the message; the caller's response is unchanged; client-gone stays `done`; no call = cost 0, a started call without a report = null | #116 `45b6374`, `49bcb0c` |
| `eval.mine`'s label estimate: mean cost per labelled candidate = the `label` step cost of recent `eval.mine` runs / their `labels.jsonl` records (#119 wired a port to `cap.eval.label` runs, which never exist: labelling runs in-process inside the `label` step; #120 replaced it) | #119 `164d7a8`, #120 `9c34697` |
| Deployed | release `b8986eb` (#115-#117, #119), then `9c34697` (all); `make verify` PASS both (review runs `01a19e17-1c6c`, `01a19e2e-ba55`) |

Reviews: `agw review` on every PR (#115 actionable → fixed: a run with an unpriced call no longer rolls up free;
#118 actionable → fixed: the fallback stamped the shared `Cancelled`; #116, #117, #119, #120 clean, improvements taken
where cheap). The lead's `/code-review high` on the core PRs: #115 (a failed or cancelled step without a report must
not read free; index built before the drop) and #118 (per-session reports instead of a merged sum, re-read on failure,
private carried usage), all fixed before merge. Gate: CI's `make check` on every rebased head (the train's CI gate).
Local `make check` timed out in the train at load 24-48 (iOS simulator, other fleets); CI was the gate, as in Wave 8.
#118's train saw no check within its 30 s grace and merged ungated: master CI on `5389d32` (which contains it) passed
afterwards; #120 used `RD_CI_GRACE=90`. One CI flake rerun: `usage outbox > 24 concurrent runs, two flushers racing`
(also flaky on master).

## Proofs on stored rows (after deploy)

- **Free = 0, unknown = null:** review code steps `prepare`/`react-doctor`/`plan` NULL before `b8986eb`, 0 after;
  `audio.ping` run cost 0; those free runs wrote no `usage.records` row; outbox backlog 0; index `agw.steps_usage_outbox`.
- **Door failure:** verify's bad-body request: `door.speech` run `failed`, `invalid_input`, "door answered 400: input
  is required", cost 0; the caller still got the legacy 400 (`make verify` ok).
- **Eval import, no spend:** run `01a19e18-57e2` (one GT case, zero findings): child `review.imported` `done`, purpose
  `eval`, `score_source` `regression`, scorer `2026-11-02.v3+eval-judge-ced286944fd4`, recall 0, cost 0, no judge call.
- **Cancelled agent steps:** review `01a19e30-d321` cancelled mid-angle: both `angle:*` steps `cancelled` with cost
  null (unknown, by rule now, never 0), run cost $0.011 = the known steps.
- **Label estimate:** journal `label` steps $0.161 (3 labels) + $10.124 (147) → $0.0686 per candidate (Wave 8 measured
  $0.068). Not run live: `agw eval mine` re-mines and rewrites the ground-truth files.
- **Failed agent steps with tokens:** none occurred after the deploy; proven by tests only (overflow, invalid output,
  failed turn, gone session, fallback, retry counted once).

Spend: $0.77 on 8 production review runs (5 PR reviews, 1 re-review, 2 cancel probes); eval credit $0; no
`agw eval gt pack`.

## After the close-out: owner hotfix 2026-11-03

`research.agent` onto Haiku 5.5 high (`EASY.agent`, `7a58222`; modelpick `64cb58e`), release `7a58222`, `make verify`
PASS; live research run `01a19e3d-885a`: agent step and both gateway rows on `claude-haiku-5-5`, `api_credit` iu. The
48 h production credit table (top 10 consumers and their Haiku estimates) went to the mother; review is ~97 % of the
current pace, and Haiku angles mostly bill at the 5x long-prompt tier (prompts over 100k tokens).

## After the close-out: review pacing hotfix 2026-11-03

#121 (`d9a8582`): an agent route's `contextLimit` (60k/80k/100k) runs on a bounded OpenCode row (`modelID` = the real
model) that compacts at bound/1.25; compaction summary calls now count in the step's usage and price. #122 (`f889a72`):
`review.angle` `contextLimit: 100_000`, `review.synthesis` onto Haiku high (owner); `angle.deep` stays Sonnet. Release
`f889a72`, `make verify` PASS. Eval (GT dev, 4 bug cases, standard; `01a19e41` vs arm `01a19e7a`): recall 0.75 -> 0.50
(one case, basalt-ui: same mechanism named on another instance), noise 0.13 -> 0.03, $0.186 -> $0.105 per review; eval
spend $1.48. Live standard review `01a19e8c-cb80`: synthesis on Haiku, 24 angle calls, max prompt 66k, $0.117.
Left behind: n=4 cannot separate the synthesis seat from run noise (Wave 9's baseline on `test` can); an arm moving
`review.angle` off Claude must clear `contextLimit` (`null`); `live-gateway.test.ts` builds resources at collection time.

## Left behind

- **Abort-driven agent failures** (idle timeout, cancel, tool refusal): `raceAbort` settles the attempt before
  `host.wait` rejects, so the step row is written before the carried usage or the unknown report lands; `Cancelled`
  carries none by design (one instance per run). Such steps read null (unknown), not their real tokens. Fix belongs
  with Wave 14 (compaction/runaway): the attempt should await the host's settle, bounded.
- **Run roll-up does not flag a null step as a lower bound:** a run with priced steps and a cancelled agent step shows
  the known sum with `unpriced_calls` 0 (e.g. `01a19e30-d321`). Same as before this wave; a `cost_partial` flag or an
  unpriced count per null step would say it.
- History is not backfilled: rows before `b8986eb` keep NULL for free steps; `recentCost` mixes the two until 50 new
  runs; a re-delivered `runPost` of an old run may re-roll its cost to null. Pending cost-0 outbox rows from before the
  cut-over stay unsynced (never posted, harmless).
- `prose-polish` keeps its own cost tally (null for no calls), now unlike the runtime's rule.
- `eval import` records no wall time or tokens for the external arm; Wave 9's native arm may want the session's wall
  per case in the file. The importer mapping lives in the eval layer, not on the review suite.
- The audio door's "started but unreported call" check compares counts (lost vs recorded calls), not call identities.
- Local `make check` unreliable under the mini's load; CI is the gate.
- **Owner session dropped** (owner, 21:00, PLAN Wave 8): the owner-session sections are gone from this file (history
  in `e637fcc`). The owner pack files stay untouched; Wave 8 deletes them and `agw eval gt pack|ingest` when it resumes.

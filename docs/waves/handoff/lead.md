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
- **Owner session dropped** (owner, 21:00, PLAN Wave 8): the two sections below are kept verbatim for the history;
  Wave 8 now validates ground truth with a third labeller and a second judge, and the owner pack and
  `agw eval gt pack|ingest` go.

## How to start the owner session (about two hours)

1. On the MacBook, open `~/Downloads/agw-owner-session/session.html` in a browser (a copy of
   `$AGW_EVAL_DIR/review-gt/owner/session.html` on the mini; self-contained, works from `file://`, no network).
2. 155 items, one at a time, ~40 s each. Keys: `y` / `n` / `u` answer and move on, `j` / `k` move, `e` writes a note.
   - **Commit items (55):** "Is this a real defect that this commit created, at about this place?" `no` for a feature
     change, refactor, preference, an older bug or a different problem.
   - **Finding items (100):** "Does this finding describe this bug?" `yes` only for the same defect (other words are
     fine); `no` for a different issue, even a plausible one in the same file.
   - Answers save in the browser as you go; the page is blind (it never says which cases the labellers accepted or what
     the judge answered).
3. Click **Export** at the end (repeatable): it downloads `owner-labels.jsonl` to `~/Downloads`.
4. Tell the lead/mother it is done. The next session ingests it on the mini:
   ```sh
   scp iumac:Downloads/owner-labels.jsonl /tmp/owner-labels.jsonl
   agw eval gt ingest --commit --labels "$(cat /tmp/owner-labels.jsonl)"
   ```
   It reports case precision (Wilson CI), what the filter drops, Cohen's κ owner vs judge, and the bars.
   **Do not run `agw eval gt pack` again before ingesting**: a new pack rewrites `owner/manifest.json` and the answers
   no longer match it (session id `24b43b759558ca7f`).

## After the owner session (next lead, not done)

1. Ingest (above). Bars: accepted ≥ 90 % right; κ ≥ 0.8. Below the case bar: tighten the filters (`MINER_VERSION`
   bump) and re-mine. Below κ: a second judge on another vendor, disagreements scored `unclear` (`docs/review-v2.md`).
2. Toward 200 bug cases and 100 controls: ~165 more accepted ≈ 720 labelled candidates ≈ $49 (≈ $37 credit + $13 IU,
   over the ~$20 IU stop: ask the mother first). Label in batches ≤ 60 (`eval.mine` hits the runaway cap's static $5
   ceiling until it has 20 done runs; a 147-candidate run was stopped in its rebuild step at $10.12, labels kept).
   Size each batch to `evalAvailableUsd` on the gateway's `/health` (≈ +$3.7/day on `me`; me2's +$100 needs its claim).
   Seeded defects only if fewer than 150 cases survive.

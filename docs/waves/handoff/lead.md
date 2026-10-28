# Lead close-out — Wave 4 (review and check cut over; P1c)

Leads: `agent-workflows-w1` 2026-10-28 ~05:10 → ~09:25 (rotated at the context limit), then the second lead (same pane)
~09:25 → ~13:15. Briefs: `~/.local/state/agent-workflows/briefs/w4/` on the mini (not in git: they name local paths).
Master: `fd03b01` (#22), deployed and verified. **Every Wave 4 step is done**; the mother flips the PLAN.

## Per step

|Step|Verdict|Evidence|
|-|-|-|
|Owner-gated deploy chain|**done**|First lead: owner request `20261028T085931-14819`, refs in `headless.refs`, reseal, release `d718900`, `make verify` PASS, `@verifier` PASS (journal, ClickStack, Argo, CLI), dotfiles #34. Redeploys this lead: `4e59492` (#18–#20), `001e721` (#21), `fd03b01` (#22): `make verify` PASS each time|
|Direct capability calls recorded (N6)|**done, #18**|`make verify` proves a direct `agw llm title` leaves a `cap.llm.title` run `done` with priced usage, on every deploy above (last: run `01a1824d-4ca6-710d-b8e3-7c6861b2c3cc`, $0.0000186)|
|Route fallback on provider balance|**done, #22**|Per-route `fallback` (GPT-6.1 Terra, medium) for single calls and OpenCode steps (a turn that did nothing reopens once on a derived fallback session; a turn that ran is never re-prompted); one balance classifier (402, 503 + IU body, the transports' marker, a text 402 only with payment wording); review degrades to `needs-human`/`spend` with `degraded: "provider_balance"` and salvages findings that did run; `review.ocr` is an internal workflow (`agw ocr` gone from the CLI, verified on `fd03b01`); concept v3.3. Not exercised live: no balance failure since ~09:10; unit and host tests with fake 402/503 bodies|
|IU key label (usage-tracker contract)|**done, #21**|`runs.iu_key` stamped at admission from `IU_KEY_ID` (unknown id refuses to start), top-level `iu_key` on `billing='iu'` Argo rows, never in `raw`/`account`; `serverEnv` forwards it; `launch.sh` reads an untracked 0600 `~/.config/agw/iu.env` (both `IU_API_KEY` and `IU_KEY_ID`, validated). Live: eval runs labelled `athena-team`, runs before and after the window `personal`. Argo's ingest schema has no `iu_key` yet (plain `z.object`, strips it): Argo's side of the contract|
|Eval sets|**done, #16**|138 review, 7 check (first lead's evidence in git history at `772c3f4`)|
|review + check ported|**done, #17 + #20**|`@verifier` on `4e59492`: review run `01a181b3-6ca9-768a-86d9-49d1531bcb81` PASS on journal, Argo (rows match to the digit), ClickStack (`agw.run review` + 7 step spans), err log clean. On `fd03b01`: `agw review --scope head --depth standard` exited 10 at 110 s, `agw run wait` → done, `clean`, 11 steps all `done` (router, adversary, 5 angles, synthesis), 179 s, $0.043, run `01a18255-7de6-73ed-a149-9a07d58adaad`|
|Side-by-side|**done: not-worse (check and review)**|Numbers below|
|Skills switched, MCP tools removed|**done**|dotfiles #38 (`/check`, `/review` run `agw` with the exit-10 → `agw run wait` loop; balance degrade keyed on `degraded`; global CLAUDE.md async-jobs line). agent-gateway #37 (`check`/`review` MCP tools gone; HTTP routes and `agw-legacy check|review` kept for the harness until P6), deployed `15a8e6d`, `make verify` OK. Live MCP children keep the old tool list until their sessions restart (not forced: other fleets' sessions)|

## Side-by-side

**Check** (7 cases): first run said worse (1 legacy-red case green on the new side; the 2 disagreements were both the
fallow step). A legacy rerun on the same trees agreed with the new side on both (fallow green): the recorded red came
from uncommitted state a patchless case cannot replay. On reproducible trees 7/7 agree; wall ratio median 1.07.

**Review** (personal key for legacy, Athena team key for the new side):

|Comparison|n|Result|
|-|-|-|
|New vs recorded legacy (new side only)|19|blocking recall 2/19 refs; legacy `actionable` 19/19, new `clean` 14/19. Run paused here (`reports/2026-10-28T09-06-50-680Z`, resumable)|
|Legacy rerun vs its own recorded run|19|**blocking recall 0.0 %**, outcome agreement 21 %: the recorded corpus does not reproduce|
|Harness verdict, 20 paired cases with `--rerun-legacy --judge`|20|**not-worse**; cost ratio median 0.94 (CI 0.62–1.18), wall 1.04 (0.70–1.32); `reports/2026-10-28T09-48-44-445Z`|
|New vs today's legacy rerun, same trees|19|blocking 10 vs 5, improvements 89 vs 80, needs-human 3 vs 14, cost $1.49 vs $3.04, wall median 1.01|

Why the recorded baseline fails: the corpus predates 2026-10-15, when angles ran on Sonnet with an open shell; today's
legacy (Haiku angles, read-only shell allowlist) finds none of those blockers either, and on the eval clones its angles
often fail ("2/4 reviewers failed … the shell tool was denied"), which is most of its `needs-human`. Improvements: legacy
capped at 5 since then too (`agent-gateway/server/skills/review/synthesis.md:35`).

## Left behind

- **Review angles lack legacy's read-only shell** (`git grep|show|log`, `rg`; legacy `opencode-server.ts:116-131`) and run
  from a scratch location, not the repo. The most likely lever for stale-call-site and broken-test findings. Candidate for
  Wave 5's first review experiment (shell allowlist on, angles told to grep callers of changed exports).
- Adversary (DeepSeek, 16K output) dominates review wall time: 200–550 s while angles take under 100 s.
- `agw schema review` leaves `output` untyped: REVIEW_OUTPUT is not in the CLI schema (the skill worker read `schema.ts`).
- Harness `--resume <dir>` takes the path literally: a bare timestamp resolves against the cwd (it started writing into
  the repo checkout once; removed, nothing committed). Accept a timestamp or resolve under `<evalDir>/reports`.
- 11 unpriced calls in the Athena eval runs (cost recorded as unknown): not investigated.
- Live fallback never fired (no balance failure); first real one should be read in the host log (`falling back`).
- Argo needs `iu_key` in its `UsageRecordInputSchema` (usage-tracker/Argo side) before the label shows there.
- dotfiles worktree `w3/rd-say-verify` kept by `rd fan --clean` as unmerged; check whether its branch landed by squash.
- Not ours (unchanged): dotfiles architecture-check rows; agent-gateway `dispatch-worktree.test.ts` credential helper.

## make check

Master `fd03b01` via the train: **769 pass, 0 fail** (`==> check passed`). #21's first train run: 3 timing failures
under load, 724/0 on rerun, then 724/0 in the train. #20: 705/0. #22: 769/0.

## Reviews

|PR|Review|
|-|-|
|#20 review workflow|lead r1 (10), gateway deep r1, lead r2 (10), lead `/code-review high` r3 (10: 8 fixed, 2 regressions from round 3 among them; 3 skipped with reason), lead read r4; lead fixed one misplaced JSDoc|
|#21 iu_key|lead `/code-review high` r1 (8: 6 fixed, Argo strictness verified as no-change, 1 folded), lead read r2|
|#22 route fallback|lead `/code-review high` r1 (10: 7 fixed, 2 skipped: refused turns bill nothing, steer carry-over noted as a known limit), r2 (8: 5 fixed, 2 skipped), lead read r3|
|dotfiles #38, agent-gateway #37|lead reads, two rounds each. No `/code-review`: skill text, docs and a tool deletion with tests|

No gateway `/review` this lead (owner direction).

## IU spend (this lead)

|Key|What|USD|
|-|-|-|
|athena-team|eval: 61 runs (19 + 20 review new side, check 7 + 2, judge calls); DeepSeek 3.24, Haiku 1.49, judge 0.001; 11 calls unpriced|**4.73**|
|personal|legacy reruns through agent-gateway (20 review + 2 check; harness report, cost inexact)|3.04|
|personal|platform verify and build runs (verify, live reviews, skill acceptance)|0.06|

athena-mother was told before the window (`rd say`, ~10:05); the host ran on the team key only during the eval
(override file removed, `fd03b01` deployed on the personal key, runs labelled `personal` again).

## Retro notes

- A recorded corpus is not a baseline. Legacy's own rerun recovered 0 % of its recorded blockers; ten paired cases on the
  same trees said more than 19 cases against records. Pausing at 19 cases on an alarming signal saved about $40 of the
  team key and found the real comparison. Eval sets need a reproducibility check (legacy rerun self-agreement) first.
- Each fix round needs its own review: #20's round 3 introduced two regressions (empty root pathspec, clone leak on an
  error result) that round 4 fixed.
- The "never end a turn on a background shell" failure recurred in a worker (route-fallback); one `rd say` fixed it.
  Worth a line in `roles/worker.md`.
- Prompt suggestions in an idle worker's input box ("merge it", "/review 21") read like typed input in `rd read`; they
  are not sent. Harmless, confusing.
- The merge train still flakes under load (3 timing failures at load ~9, green on rerun).
- Carried from the first lead: a contract commit before the fan let five workers build in parallel; lead reads on Max
  found what tests and gateway reviews did not; every `op` in an ask-human command gets `</dev/null`; deep gateway
  reviews cost ~$2 each and added little once the cross-family critic was dead.

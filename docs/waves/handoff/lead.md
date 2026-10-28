# Lead handoff — Wave 5 (evals and self-improvement; P2), close-out

Leads: `agent-workflows-w1` 2026-10-28 ~15:00 → ~18:45 (rotated), then the second lead in the same pane (w40:p14)
~18:45 → ~21:55. Master `85b326f` deployed on the personal key, `make verify` PASS, `@verifier` PASS (6/6). Briefs:
`~/.local/state/agent-workflows/briefs/w5/` on the mini (not in git: they name local paths).

## Per-step verdict

|Step|Verdict|Evidence|
|-|-|-|
|Scorer API (inline gate, regression, sampled drift); `agw eval run\|compare`|**done, #26**|Live: `eval.run` `01a183d5-d95a…` (fingerprint `4ac59d96`, 5 cases scored, 0 errors, pass 0.2) and `01a18441-6ee5…` (`c244dcb6`, after #27, pass 0); `agw eval compare` on the pair (below). Drift live: prod review `01a1825b-91d5` scored `source=drift` right after the deploy; the next prod review fell outside the 10 % sample (`drift_sample` 707M > 429M), as designed|
|Friction counters, repeat-tool nudge (3, 5, 8), threshold → GitHub issue|**done, #25** (+ `AGW_FRICTION_REPO` in `.env.tpl`, #27)|`/health` `friction: {enabled: true, state: on}`; every run after the deploy carries `runs.friction` v1 (a review case run: 6 sessions, 24 tool calls, all counters 0 but `repeatToolCalls` 1); `agw.friction_issues` exists, empty (no breach yet). Nudge in-turn measured live on 2.0.32 (`opencode-host/test/live-nudge.test.ts`)|
|Retrospective workflow (weekly) + learnings store|**done, #24**; first runs judged|First weekly runs (`review`, `check`, 17:25 UTC): 0 proposals, 5 proposed learnings. None activated; #4 ("adversary finds nothing on docs diffs") and #5 (one 450-line file) **retired**: as active facts they would bias the angles. `AGW_RETRO_FILE_ISSUES` stays **off**: nothing to file|
|First experiment on review (angle shell, owner's ask)|**done, answered: no gain** (numbers below); arms removed in #27|Reports `reports/2026-10-28T16-34-3{2-480Z,3-749Z,4-806Z}`|
|Reproducibility check for eval sets|**done, #23** (mode `self-agreement`)|Not run live on the 20-case set this wave (legacy reruns ≈ $6 on the personal key under the IU constraint): Left behind|
|Wave 4 leftovers|**done, #23**|typed `agw schema review`, `--resume` paths, the 11 unpriced calls explained (long-prompt tier); `roles/worker.md` background-shell rule (dotfiles `d5a91ab`)|
|Cleanup + security (not a PLAN step; from the experiment)|**done, #27**|Deny by default, measured live on 2.0.32 (below)|

## Experiment: does review find more with a caller instruction or a read-only git shell?

Question (the Wave 4 close-out's first candidate): legacy angles had a read-only shell; do agw's angles find more stale
call sites and broken tests with (a) an instruction to check callers of changed exports, (b) that plus a read-only git
shell? Arms chosen per run by a review input (`angleVariant`), so all three ran side by side on one deploy (`3490b50`),
20 paired cases (the Wave 4 side-by-side set), same depth, judge on, team key. Reports:
`reports/2026-10-28T16-34-3{2-480Z,3-749Z,4-806Z}` (baseline, callers, shell).

|Arm|Blocking|Recorded blockers recovered|New-only blocking|Improvements|clean/actionable/needs-human|Cost|Wall median|grep / read calls per angle session|
|-|-|-|-|-|-|-|-|-|
|Wave 4 run (same code, earlier)|11|4/30|8|94|12/4/4|$1.53|261 s|n/a|
|baseline|13|5/30|10|94|8/8/4|$1.13|252 s|1.4 / 1.0|
|callers|14|5/30|10|93|11/6/3|$1.42|286 s|3.5 / 1.7|
|shell|10|5/30|7|96|12/4/4|$1.27|206 s|3.0 / 1.7, shell 0.3 (8 of 25 denied)|

**Answer: neither lever changes the findings.** The two baseline runs differ by 2 blocking findings, 4 `clean`
outcomes and $0.40; every arm sits inside that noise on blocking, recall, improvements and outcomes. The caller
instruction is followed (grep calls ×2.5, reads ×1.7) and costs about +25 % and +13 % wall for no measurable gain.
The shell is barely used: the angles already have OpenCode's grep tool on the repository, which covers what `git grep`
would, and the history verbs (`log`, `show`, `blame`) were almost never called. So legacy's recorded blockers did not
come from its shell. What differs is the model: the recorded corpus is from Sonnet angles (before 2026-10-15), and
today's angles are Haiku.

**Recommended next experiment (the PLAN's "model question"): Sonnet angles on the same 20 cases.** It needs an IU
Sonnet model id and rate in `packages/routes/src/table.ts` (ids from `agw-legacy routing` / the IU catalogue, never
from memory) and a way to select it per run: `AGW_ROUTES` is not plumbed into the host by `scripts/launch.sh`.
Estimate $4–6 on the team key.

Also measured: the shell rules (live probe, 12 commands on 2.0.32). Allowed `git -C <repo> grep -n -e <token>|show|log|blame|ls-files`
ran; `cat`, chaining, pipes, `-O`/`-nOcat`, quotes, `blame --contents`, `diff` outside the tree, `--outp=` and another
directory were refused; a refused call does not end the turn. Open hole: OpenCode's glob cannot match a backslash, so
`--o\utput` passes the text rules. The variant was opt-in, refused with `pr`/`branch`, and used only on eval trees.

**Regression check of the cleanup (#27) with the new `agw eval compare`** (same 5 cases, team key, before = `4ac59d96`
on `8999b0c`, after = `c244dcb6` on `85b326f`): every quality metric a tie (pass 0.2 → 0, decided 1 → 0.8, located
0.79 → 0.93; all CIs include 0; recall/precision withheld below 5 pairs); `costUsd` flagged worse, +$0.017 per case
(CI 0.007–0.027), tool calls 10.4 → 16.2 (CI includes 0). The same-code reruns in the experiment differed by about
$0.02 per case, so this is a watch item, not a verdict: n = 5.

## Security: deny-by-default OpenCode sessions (#27)

Before: sessions started from OpenCode's allow-all base; only `shell` was denied, so angles, synthesis and check kept
`webfetch`, `websearch`, `subagent` (an eval angle completed a `webfetch`), and `review-adversary`/`review-router` had
no `edit` deny at all. Now (legacy's posture): catch-all `*` deny first, allows for exactly the measured session tools
`read`, `glob`, `grep`, `skill` (2.0.32 has no `list`/`todowrite`; `edit` covers `write`), `shell` only on
`permissions.shell` (check), every other tool only as an `allow` in the agent's `rules`; the same rules as a server-level
backstop (session rules still win, measured: an opted-in `webfetch` completes); patched onto a re-attached,
follow-up or fallback session when they differ (`PATCH /api/session/{id}`, measured between turns); strict `open()`
options; the base policy and every `agent.json` are now in the run fingerprint (a route change moves eval arms). A
denied tool is absent from the model's tool list; a call to it ends "No tool named …" and the turn continues; Code
Mode's catalog holds no built-in tool. Live: all 11 sessions opened after the deploy store the policy; tool calls in
them were only `glob`, `grep`, `read`. Check's shell is still its boundary (README says so).

## Left behind

- **CI on master has been red since `fd03b01` (Wave 4 close), every run**: two tests fail only on the GitHub-hosted
  Linux runner, `credentials of the host never reach make check or the make -p -q probe` and `run-step.sh > a silent
  command is killed alone after the idle window` (once also `bunExec > … killed after the idle window`). `make check` on
  the mini is green (1014 pass). The first may be a real env leak on Linux, not a test assumption: fix first next wave.
- Model question for review (the experiment's recommendation): Sonnet angles on the same 20 cases. Needs an IU Sonnet
  id and rate in `packages/routes/src/table.ts` (from `agw-legacy routing`), `AGW_ROUTES` plumbed through
  `scripts/launch.sh`; ≈ $4–6. Now measurable with `agw eval run --args` / `compare` (route is in the fingerprint).
- Reproducibility live run (`self-agreement review --side legacy --runs 2`, ≈ $6 personal key) not run.
- The recorded review corpus is weak as a baseline: pass 0–0.2 and recall 0 on 5 cases, same as the experiment's 5/30.
- Known, documented gaps: a schema miss on a retried attempt is invisible to hooks (the journal keeps the last
  attempt); the follow-up query has no index; a run whose scoring keeps failing on infra backs off until effectively
  never; a policy PATCH mid-turn is unmeasured; one open GitHub issue per workflow is our own record (`friction_issues`).
- Tests flake under host load (other fleets put the load average at 40–200): 5 s timeouts in git-heavy review, eval and
  process-spawn tests, and once `llm.title … nothing after cleanup is INVALID_OUTPUT` (passes 3/3 alone). Every merge
  went green on a rerun; a load-aware timeout or a serialized merge train would stop the reruns.
- `docs/waves/PLAN.md:149` still lists the cleanup as open (mother's file).
- biome reports `useRegexLiterals` in `retrospective/scrub.ts` (a note, not a failure).

## Validation, reviews, live proof

- `make check` at merge: #26 930 pass / 0 fail, #25 1011 / 0, #27 1014 / 0 (each after reruns for load timeouts).
- `make deploy` `8999b0c` (team key, eval window) and `85b326f`; in-flight runs drained (none) before the policy deploy;
  host back on the personal key (`launchctl kickstart`), `make verify` PASS (runs `01a18451-1c50…`, `01a18451-21bb…`,
  `iu_key personal`).
- `@verifier` PASS: migrations 0001–0006 and the score/friction columns; eval case runs scored (regression, scorer
  `2026-10-28.1`); drift scored a prod review; `/health` friction `on`; friction v1 on every new run; all new OpenCode
  sessions on the deny-by-default policy; smoke trace `fa286821…` in ClickStack (2 spans), usage in Argo
  (`argo_synced_at` set, no error); learnings 1–3 proposed, 4–5 retired.

|PR|Reviews|
|-|-|
|#23 eval leftovers|`/code-review high` r1 (10: 9 fixed), lead read r2, merged (first lead)|
|#24 retro + learnings|`/code-review high` r1 (10, public-issue redesign), lead read r2, merged (first lead)|
|#25 friction|`/code-review high` r1 (10), r2 (10, all fixed: own issue record instead of a 500-issue scan, prod-only rates, true recompute), r3 (9: 7 fixed, 2 dismissed with evidence: 0006 never applied anywhere; the finishedTurn preamble case is likelier), lead read r4; merged|
|#26 scorers + eval|`/code-review high` r1 (10), r2 (10: 9 fixed, in-place 0004 accepted: never applied live), r3 (8: 7 fixed, 0004 dismissed: `agw.schema_migrations` had 0001–0003, 0005), r4 (4 fixed), lead read r4; merged after a worker rebase over #24|
|#27 cleanup + permissions|`/code-review high` at security depth r1 (8, all fixed, plus the run fingerprint), r2 (5: 4 fixed, 1 dismissed: releases are immutable), lead read r3; merged|
|experiment `f377b87..3490b50`|lead read (3 shell escapes), `/code-review high` r1 (first lead)|

No gateway `/review` in this wave (owner direction under the IU constraint); `/code-review high` on Max was the review.

## IU spend, by key

|Window|athena-team|personal|
|-|-|-|
|First lead (experiment, 60 review runs + judge, one worker `agw review`)|$3.82|everything outside the window|
|Second lead (2 × 5 eval cases $0.75; 3 prod runs that were not the fleet's $0.07; verify ≈ $0)|$0.82|$0.16 (2 prod runs, not the fleet's)|
|**Wave 5 total on the team key**|**≈ $4.64**||

Live probes by the workers (opencode-host permissions and nudge) ran on the cheapest route, under $0.01 each. OCR
stayed refused by the wallet gate until 2026-11-02. **For the owner (athena-mother's pane is gone, so this is the only
notice):** the Athena team key carried ≈ $4.64 of agent-workflows evals on 2026-10-28, in two windows (16:30–17:10 and
18:45–21:50 UTC), labelled `iu_key=athena-team` on every run and Argo row; the override file is removed again.

## Retro notes

- First lead: an experiment that changes nothing is still an answer (the tool-call counts showed why); reading an
  allowlist before an eval found three escapes from a "read-only" shell, so text-matched shell rules are not a
  boundary; `/code-review high` with a PR target and "never check out a branch in the main checkout" worked on every PR;
  load 30–40 made 5 s timeouts flake.
- Fix rounds converge but slowly: #25 and #26 needed four rounds each, each `/code-review high` finding a new class
  (round 2 found the round-1 fixes' own gaps). Asking for a design change (own issue record, no throw-on-incomplete)
  instead of patching findings one by one is what closed them. Workers ended at 80–90 % context.
- Dismiss with evidence, not with an opinion: three findings were closed by one query each (`schema_migrations`,
  `information_schema`), which is cheaper than a fix round.
- The eval tooling earned its keep on day one: the cleanup's regression check was one `agw eval run` and one `compare`,
  and it surfaced that the run fingerprint ignored `agent.json`, which the next experiment (a route change) depends on.
- CI went unnoticed for a whole wave because the merge train gates on the mini's `make check`, not on CI. The gate
  should read CI too (the mother's call for PLAN).
- Mistake: a stray `pkill -f "bun test --isolate"` while stopping my own test run was host-wide and may have killed
  another fleet's test run around 21:25; scope kills to a PID.
- Load from parallel fleets (40–200) cost every merge one or two reruns.

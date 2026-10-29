# Lead handoff — Wave 6 (research; P3a), rotation checkpoint

Lead 1: `agent-workflows-w1` (pane w40:p16), 2026-10-28 ~22:05 → 2026-10-29 ~01:30 UTC+1, rotated at ~60 % context.
Briefs: `~/.local/state/agent-workflows/briefs/w6/` on the mini (not in git: they name local paths). This is a rotation
checkpoint; the wave-end close-out overwrites it.

## Next actions for the new lead (in order)

1. **#32 `w6/research-followup`** (worker `agent-workflows-research-compare`, Opus/medium) is fixing `/code-review high`
   round 2 of #32: drain gate calls before aborting at agent end; `answerOf` = any page 4xx + URL_REFUSED is an answer
   (citation unjudged), outages (5xx, timeout, network, NOT_CONFIGURED, CANCELLED) throw; compare excludes cancelled and
   in-flight runs from quality (only failed = 0); three ledger edge cases documented as experiment-only. Read the round's
   diff, then the worker merges it (the owner asked the worker directly to merge/deploy for the research window; it did so
   for #31), deploys on the team key and runs the full comparison: 3 runs × 28 golden questions × 5 arms, estimate ≈ $10
   (smoke-measured), approved.
2. **Verdict** by the pre-registered rule in `docs/research/2026-10-28-research-three-way.md` (worker fills results). Check
   the numbers yourself: `agw eval compare research …` or the worker's `research/compare.ts` report; judgedShare per arm
   must be in the table.
3. **Switch the host back to the personal key** after the window: `rm ~/.config/agw/iu.env`,
   `launchctl kickstart -k gui/$(id -u)/com.jkrumm.agent-workflows-host`, check `/health`; the worker stops its engine eval
   instance (`~/.local/state/agent-workflows/research-eval/engine.sh`, port 7795; never the live research-gateway).
4. **Port in the winning shape** (new brief, Sonnet/high per PLAN): the losing arms, `design`/`profile` inputs and the
   engine adapter deleted (concept §0, no shim; Wave 5's cleanup #27 is the pattern); follow-up on a finished report;
   research-gateway's output shape kept for `/research` callers; concept §8 says research runs in its own process: decide by
   evidence and write it down.
5. **`/research` switched** (dotfiles skill to `agw research`), then **research-gateway `/mcp` deleted** (one commit in
   research-gateway: `src/routes/mcp.ts`, `.use(mcpRoutes)` at `src/index.ts:316`) and its MCP registration removed
   (dotfiles `Makefile` target `_setup-research-gateway-mcp`, ~line 1537, plus `claude mcp remove research-gateway`).
6. Wave close-out: deploy on the personal key, `make verify`, `@verifier`, handoff overwrite, commit, push.

## Per-step state

|Step|State|Evidence|
|-|-|-|
|CI green on master|**done, #28**|(1) Not a credential leak: `commandEnv` passed the outer `make check`'s `MAKELEVEL`/`MAKEFLAGS` into the validated repo's make (GNU make 4 printed "Entering directory"); make state is dropped now, and the credential test's `leak-` assertions pass on Linux CI for the first time. (2) `run-step.sh` under dash (Ubuntu `sh`): `set -m` and `kill -- -PGID` fail without a tty, so the group kill reached nothing (orphan alive, PPid 1): it re-execs under bash. (3) The bunExec test raced the orphan's reap: a shared liveness helper (gone or zombie). Bun is not a subreaper (orphan PPid 1). Plus a friction query tiebreaker. CI green on master from `e65cebb`, every run since|
|Merge train gates on CI|**done, dotfiles #39**|`ci_wait`: one `gh pr view --json headRefOid,statusCheckRollup` per poll, trusted only on the pushed sha; pass needs ≥ 1 non-skipping check and `RD_CI_GRACE` (30 s, measured 0–5 s); failure dies with names + link; `RD_CI_TIMEOUT` 1200 s; `--no-ci`. Live: "CI passed for w6/… at <sha>" on #28, #29, #30|
|Load-aware test timeouts|**done, #28**|`bun test --timeout` = 5000 ms × load1/cores, floor 5 s, cap 30 s (printed). Limit: sampled once at start; spikes mid-run still hit 5 s (seen by three workers and one train run)|
|Sonnet angles (P2 gate)|**answered**, default unchanged|Below|
|Research three-way|harness merged (#31), smoke done, follow-up #32 in review; full run pending|Smoke below|
|`research` port, `/research` switched, research-gateway `/mcp` deleted|pending|—|

Also merged: #29 route override (`~/.config/agw/routes.json` → `AGW_ROUTES`, validated by `validateOverrides` in launch.sh and at
boot, exit 78 on a bad file, never echoes content), #30 `web.search|fetch|docs|package` (Sonar → Tavily fallback; SSRF guard
with pinned addresses on every hop; HTMLRewriter text; charset; typed `URL_REFUSED`), #31 research workflow with five arms, the
loopback tool gate for OpenCode plugins (per-process key in `<stateDir>/research/gate.json`, 0600, outside every location, serves
only `web.*` + `engine_research` to sessions of a running research step), the scorers' judge (allowlist), the tree-less eval suite,
route `research.agent`, migration 0007.

## Sonnet angles vs Haiku angles (review, 20 paired cases, team key)

Deploy `1625a3b`, same code both arms; B = `review.angle` → IU Sonnet 5.5 EU (id probed 200) via `routes.json`, vendor rate
2/10/0.10/2.50 per M. Fingerprints A `c244dcb6`, B `41ce61cd`. `agw eval compare review --a c244dcb6… --b 41ce61cd…`:

|Metric|Haiku|Sonnet|Δ (95 % CI)|Verdict|
|-|-|-|-|-|
|recall (n=15)|0.017|0.130|+0.113 (0.017..0.25)|Sonnet|
|located|0.868|0.960|+0.091 (0.022..0.185)|Sonnet|
|precision (n=5)|0.10|0.50|+0.40 (0.1..0.7)|Sonnet|
|pass|0.35|0.30|−0.05 (−0.25..0.15)|tie|
|decided|0.80|0.85|+0.05|tie|
|cost per review (17 priced)|$0.057|$0.542|+$0.485 (0.30..0.68)|Haiku|
|wall|264 s|281 s|+16 s (CI incl. 0)|tie|
|tool calls|17.6|36.1|+18.6|—|

**Answer:** Sonnet angles recover more recorded blockers (recall ×8, still only 13 %) and locate better, at 9.4× the cost, no
wall-time change; pass and outcome agreement do not move. Default left on Haiku: ~10× dearer reviews is a spend call under the
IU constraint (N8), the owner's. Recommendation for the mother/owner: Sonnet angles for `--depth deep` only (opt-in).

## Research smoke (deploy `fa5e07d`, team key, 3 questions × 5 arms, by the worker)

15/15 done, golden 15/15, 0 errors, 0 unpriced research runs.

|Arm|Cost (2 quick + 1 standard)|supported (3-citation sample)|median wall|
|-|-|-|-|
|E engine|$0.117|0.56|16 s|
|A-yolo|$0.036|0.89|9 s|
|A-focused|$0.038|1.00|7 s|
|P-yolo|$0.045|0.50|24 s|
|P-focused|$0.051|0.50|18 s|

n = 3, no verdict. OpenCode's own `websearch` hung and `webfetch` has no SSRF guard (fetched loopback), so "yolo" = all platform
web tools + broad directive, "focused" = search + fetch only (A) or the engine tool only (P) + narrow directive.

## Reviews (all `/code-review high` on Max; no gateway `/review`, owner direction)

|PR|Rounds|
|-|-|
|dotfiles #39 train CI gate|r1 (8: skipping-only/partial lists passed early → grace + non-skipping rule, one rollup call, gh timeouts; 1 dismissed), lead read r2; merged|
|#28 CI|lead read r1 (+friction tiebreak), r1 review (10: shared liveness helper, timeout as positional arg, robust make assertion; 3 dismissed: load-scaled timeout is the brief, bash-absent hosts, operator MAKEFLAGS), lead read r2; merged|
|#29 routes override|lead read r1 (boot validation added), review r1 (10: one validator for boot + launch.sh, read once, exit 78; 3 dismissed), lead read r2–r3; merged|
|#30 web capabilities|r1 (10), r2 (10, five tokenizer classes → design change to HTMLRewriter), r3 (8, converging), lead read r4; merged|
|#31 research harness|r1 (10 → persisted ledger), r2 (10 → simplified: one attempt-key rule, usage per call), r3 (8 → last round, edge cases documented), lead read; merged by the worker on the owner's direct ask; r4 on merged state (9 → #32)|
|#32 research follow-up|r1 (6: 3 fixed in progress, 3 documented)|

Fix rounds on #30/#31 kept finding new classes; design changes (HTMLRewriter; simplified key/usage rules; "experiment harness:
fix what bends the numbers, document the rest") closed them.

## IU spend so far, by key

|Key|Spend|What|
|-|-|-|
|athena-team|$13.08 (150 eval runs) + 9 prod/verify runs ≈ $0|Haiku baseline $1.18, Sonnet arm $11.60, research smoke $0.29; window open since ~22:55 UTC+1 2026-10-28|
|personal|< $0.05|worker live smokes of `web.*`, one `llm classify` probe|

The 7 `prod` runs on the team key during the window are not the fleet's (callers of the live host); list them in the close-out.

## Host state (now)

Deployed `fa5e07d` on the **team key** (`~/.config/agw/iu.env` present), no `routes.json`. Engine eval instance on :7795 (the
worker's). Main checkout clean on master (a review fork had left it detached at `origin/master`; restored).

## Left behind (so far)

- CONTEXT7_API_KEY resolves through research-gateway's 1Password item, which P6 archives: move it to a platform item first.
- Load-aware timeout sampled once per `make check`; mid-run spikes still flake 5 s tests.
- 13 unpriced calls per 20 reviews in both review arms (3 cases): the long-prompt tier, known.
- Sonnet-for-deep recommendation needs an owner/mother decision.
- `/code-review` forks run in the main checkout and may leave it detached: check `git status -sb` before committing there.

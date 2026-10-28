# Lead handoff — Wave 6 (research; P3a), in progress

Lead: `agent-workflows-w1` (pane w40:p16), 2026-10-28 ~22:05 → . Briefs: `~/.local/state/agent-workflows/briefs/w6/`
on the mini (not in git: they name local paths). This file is a rotation checkpoint; the wave-end close-out overwrites it.

## Per-step state

|Step|State|Evidence|
|-|-|-|
|CI green on master|**done, #28**|Root causes: (1) not a credential leak: `commandEnv` passed the outer `make check`'s `MAKELEVEL`/`MAKEFLAGS` into the validated repo's make (GNU make 4 printed "Entering directory"); make state is now dropped, and the credential test's `leak-` assertions pass on Linux CI for the first time. (2) `run-step.sh` under dash (Ubuntu `sh`): `set -m` and `kill -- -PGID` fail without a tty, the group kill reached nothing (orphan alive, PPid 1): re-execs under bash. (3) bunExec test raced the orphan's reap: shared liveness helper (gone or zombie). Plus a friction query tiebreaker (`id desc`). CI on master green from `e65cebb`|
|Merge train gates on CI|**done, dotfiles #39**|`ci_wait`: one `gh pr view --json headRefOid,statusCheckRollup` per poll, trusted only on the pushed sha, pass needs ≥ 1 non-skipping check and `RD_CI_GRACE` (30 s) elapsed, failure dies with names + link, `RD_CI_TIMEOUT` 1200 s, `--no-ci`. Live: "CI passed for w6/… at <sha>" on #28, #29, #30|
|Load-aware test timeouts|**done, #28**|`make check` passes `bun test --timeout` = 5000 ms × load1/cores, floor 5 s, cap 30 s. Limit: computed once at start, so a load spike mid-run still hits 5 s (seen by three workers)|
|Sonnet angles (P2 gate)|**answered**, default unchanged|Below|
|Research three-way|in progress: #31 (harness + arms) in review round 4; live window not started|`docs/research/2026-10-28-research-three-way.md` on the branch holds the pre-registered rule|
|`research` port, `/research` switched, research-gateway `/mcp` deleted|pending|—|

Also merged: #29 route override (`~/.config/agw/routes.json` → `AGW_ROUTES`, validated by `validateOverrides` in launch.sh and
at boot, exit 78 on a bad file), #30 `web.search|fetch|docs|package` capabilities (SSRF guard with pinned addresses, HTMLRewriter
text extraction, Tavily/Sonar pricing).

## Sonnet angles vs Haiku angles (review, 20 paired cases, team key)

Deploy `1625a3b`, same code both arms; arm B = `review.angle` → IU Sonnet 5.5 EU (id probed 200 on the team key) via
`routes.json`, rate from the vendor page (2/10/0.10/2.50 per M). Fingerprints A `c244dcb6`, B `41ce61cd`.
`agw eval compare review --a c244dcb6… --b 41ce61cd…`:

|Metric|Haiku|Sonnet|Δ (95 % CI)|Verdict|
|-|-|-|-|-|
|recall (n=15)|0.017|0.130|+0.113 (0.017..0.25)|Sonnet|
|located|0.868|0.960|+0.091 (0.022..0.185)|Sonnet|
|precision (n=5)|0.10|0.50|+0.40 (0.1..0.7)|Sonnet|
|pass|0.35|0.30|−0.05 (−0.25..0.15)|tie|
|decided|0.80|0.85|+0.05|tie|
|cost per review (n=17 priced)|$0.057|$0.542|+$0.485 (0.30..0.68)|Haiku|
|wall|264 s|281 s|+16 s (CI incl. 0)|tie|
|tool calls|17.6|36.1|+18.6|—|

**Answer:** Sonnet angles recover more recorded blockers (recall ×8, still only 13 %) and locate better, at 9.4× the cost and
no wall-time change; pass/outcome agreement do not move. Default left on Haiku: making every review ~10× dearer is a spend
call under the IU constraint (N8), the owner's. Recommendation: Sonnet angles for `--depth deep` only (opt-in, depth gating
already exists), Haiku for light/standard. Total arm cost: Haiku $1.18 (20), Sonnet $11.60 (20).

## IU spend so far, by key

|Key|Spend|What|
|-|-|-|
|athena-team|$12.78 (54 runs, purpose eval)|Haiku baseline $1.18, Sonnet arm $11.60; window opened 22:5x UTC 2026-10-28|
|personal|< $0.05|worker live smokes of `web.*`, one `llm classify` probe|

Host state: deployed `1625a3b` on the team key (`~/.config/agw/iu.env` present), no `routes.json`. Switch back after the
research window: `rm ~/.config/agw/iu.env`, `launchctl kickstart -k gui/$(id -u)/com.jkrumm.agent-workflows-host`.

## Left behind (so far)

- CONTEXT7_API_KEY resolves through research-gateway's 1Password item, which P6 archives: move it to a platform item first.
- Load-aware timeout is sampled once per `make check`; spikes mid-run still flake 5 s tests.
- 13 unpriced calls per 20 reviews in both arms (3 cases): the long-prompt tier, known.

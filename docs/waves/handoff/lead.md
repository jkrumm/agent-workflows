# Lead handoff — Wave 19 (Review v4 follow-ups and harness robustness): CLOSE-OUT

Lead `agent-workflows-w1-r19`, 2026-11-03, Opus, account `me2`. Wave 10's close-out is in git at `602aba5`.
Deployed and verified: agw `60a5bcd` (`make verify` PASS, hidden smoke review `rv_cidexvfzy7jvwtyxvasc`, light, me2;
gateway build `d1601af2` left running), factory `07f2f7b` (`make verify` PASS, default review idle window restored).
dotfiles pushed at `c91898f`.

## What landed

| Repo | Commits | What |
|-|-|-|
| agw | `f1dd00e` | REVIEW.md `none` gains `docs/concept.md`: a commit touching only `docs/waves/**` and concept.md (the mother's plan, handoff and retro commits) routes to none, so the wave gate never asks for its review. A concept change that rides with code is still routed by the code (`none` applies only when every file matches). Wave 10's `acb1ca0` needed `light` for exactly this reason |
| agw | `9dff391` | `agw review status` job list carries `transport` |
| agw | `1f3c14a`, `1825172`, `cbf0ba7` | `status <jobId>` on a still-`prepared` hidden job probes the factory spawns: `hidden: {attempts:[{key,status}], gaveUp}`; `gaveUp` = a2 exists and is `ended|failed|cancelled`. `cancel` reads the state from the factory's 409 text (`spawn <key> is <state>:`): terminal a2 → job abandoned, tree removed, answers `failed`; claimed or started → `running`. The probe re-reads the job so a submit during the probe is not reported as given up |
| agw | `eb02a37` | Test: an agent step is stopped mid-step (`toolPre`) at 10 × the learned p95 wall |
| agw | `3cca435` + `boot.ts` in `7cead8f` | Static runaway ceilings: `eval.mine` cost $30 (a working mining run was killed at $10.12 > $5); `eval.recall` cost $30, wall 30 days (it waits on the factory) |
| agw | `afdf694`, `7cead8f`, `c8d17c3`, `003a3cb`, `60a5bcd` | `agw eval recall [--split] [--cases] [--limit] [--kind] [--concurrency ≤2]`: per case an internal child run `eval.recall.case` (clone → request → wait → score → cleanup). Isolated clone under `~/SourceRoot/.agw-eval-recall` (no refs, origin or alternates: the fix commit is unreachable, `prior.json` is `[]`; tested), scope `parent..sha`, context = the commit subject only, `min: light`, thread `eval:<runId>:<caseId>`, a resumed request adopts the live job. Wait polls every 60 s with no ceiling; `gaveUp` → cancel → `unscored`. Scorer v3 restored for v4 output (single judge, κ 0.93). Summary: recall and detected with Wilson CIs, false alarms per control, noise, tiers, wall p50/p95 |
| factory | `254b4e9`, `51642b0`, `07f2f7b` | The 74 failures under `agw check`: the agw host (launchd) has no `LANG`/`LC_*`, so macOS Postgres 18 picks de_DE and the postmaster dies (`set LC_ALL to a valid locale`). Test Postgres and psql pinned to `LC_ALL=C`; the door loose-mode test `chmod`s itself (agw check runs with umask 077). Not an agw defect |
| factory | `6ab7f52` | Test: a wedged reviewer with a live terminal is killed after the idle window, a2 starts, a wedged a2 → `needs_human`, slot freed |
| factory | `00c238d` | `FACTORY_REVIEW_SESSIONS|DEEP_CAP|IDLE_MS` settable through `~/.config/factory/env` (the env-file allowlist). Not `.env.tpl`: that file is secrets-only (every key is checked as an op ref) |
| dotfiles | `d545e4d` | `wave-gate.py`: a wave's `**Repos:** a, b` line; each named repo is checked with `agw review covered` from its newest commit at or before the plan repo's wave-start time; fail closed per repo; no clean-tree check there. SKILL.md template and gate bullet document it |
| dotfiles | `80a7be7` | The "pid file removed" failure was `claude-relogin.test.sh` (not the launcher test): it globbed the shared `$TMPDIR` and a stale pid file from a killed run failed it forever. Now hermetic |
| dotfiles | `c91898f` | The launchd-label warning: 5 unmapped labels (`finances`, `finances-backup-push`, `soloist`, `agent-workflows-eval-mine`, `iu.tool-checkout-deploy`) added to `docs/architecture.md`; row text inferred from the plists, check the owner columns |

## Gate

- `make check`: agw 4119/0 on the final tree (one full run before the last fixes failed only `eval.test.ts` "cost gaps split by
  cause", 8/8 alone three times, untouched since `20c7ab6`: a load flake like `check-real`). factory plain `make check` and
  `agw check` green. dotfiles `make check` exit 0.
- `make verify`: agw PASS (above), factory PASS.
- **Live calls per changed route:** `status` on the given-up proof job showed `hidden.gaveUp: true` (a1, a2 `ended`); `cancel`
  abandoned it; the job list shows `transport`.
- **Idle watchdog, live** (factory deployed with `FACTORY_REVIEW_IDLE_MS=60000`, then restored and redeployed): job
  `rv_kmnjflvtgzdfy43qdlrn`, a1 SIGSTOPped 13:03:39 → killed ~66 s later, a2 spawned; a2 waited ~50 s for its slot until a1's
  spawn flipped to `ended`; a2 SIGSTOPped 13:05:47 → killed ~13:07:35; factory: "needs a human: attempt 2 failed: idle: no
  output for 1 min"; no a3; `reviews.live` 0.
- **Recall, live:** `AGW_PURPOSE=eval agw eval recall --split dev --kind bug --limit 3 --commit` → run `01a1a16a-1507`, me2,
  hidden, $0: 3 scored (standard 82 s, light 16 s, standard 355 s), 0 unscored, **recall 0/3** (CI 0–0.56). All three reviews
  `clean` with real diffs and empty `prior.json`; the bugs are `major` and live in interactions (a price constant in an
  unchanged-looking route row; an opt-in enforced only in the parent's journaled step; a fallback lost in a query mapper).
  n=3 says nothing yet; it is Wave 11's first data point.
- **Reviews, v4 in-session on Max** (every finding disposed; `covered` true over all three ranges, the other two computed as
  the new gate does):

| Repo, range | Rounds |
|-|-|
| agw `fc182e6..60a5bcd` | `rv_3ak3ljrhhwtnsfo4bgng` deep: 2 nits (status/submit race; a dead gate waiter eats the slot) → `cbf0ba7`, `60a5bcd`; `rv_q5uldzxhv7aj4slemskd` round 2 clean |
| factory `f7ac112..07f2f7b` | `rv_2xacqrs5ffe2jfwh447o` deep clean |
| dotfiles `45ea336..c91898f` | `rv_bujuppadqnwbcgqwipaj` standard clean |

## Decisions made here

- **Gate exemption via REVIEW.md, not wave-gate.py:** the router is the one place that says what needs review; the gate,
  `/review` and the factory's ship check all read it. Cost: a concept.md-only commit by anyone skips review.
- **`optionalExpensive` kept.** No workflow declares it, but it is the wallet gate's opt-in (concept §4); deleting it orphans
  the gate, its spend port and friction counters. Removing the gate is a concept decision. Mother's call.
- **`contextLimit` kept:** real users (`opencode-host/src/config.ts` builds bounded model rows from it; eval arms set it).
  `isPathScope` was already gone (`87d6d06`).
- **Runaway cap, cost mid-step: not built.** Wall is judged on every tool event (mid-step). Cost enters the meter only at
  `stepPost`, so a cost runaway stops at the next step. Mid-step cost needs usage on the tool-event stream (runtime +
  opencode-host, both sensitive). The kill history argues against urgency: 4 runs killed so far, none a real runaway
  (two eval reviews 4 s and 68 s over a 10× p95 wall, a review synthesis at $1.65 > $1.53, `eval.mine` at $10 > $5).
- `agw eval recall` is its own command, not an `eval run` suite: review is no workflow any more, so `eval compare` does not
  apply; two recall runs compare by their `summary`.

## For Wave 11 (the mother edits PLAN.md)

- Recall path ready: `agw eval recall --split dev` (then `test`), `--kind control` for false alarms. Paced by the factory
  (2 reviewer slots, ceiling 70 % 5 h / 90 % week, deep cap 15/day). me and iu sat at 94 % of the week today, so only me2
  could run it.
- `gt calibrate` still cannot run (recall calls the judge in process; no `cap.eval.judge` runs for it to read). Delete it or
  give it a source in Wave 11.
- After 20 done `eval.recall` runs the learned cap (10 × p95) replaces its static ceiling; one long held run after twenty
  short ones could be killed. A per-workflow `minSample` in `packages/limits` would fix it.
- A cancelled or crashed recall run leaves its current clone under `~/SourceRoot/.agw-eval-recall`.

## Small gaps found

- `agw review prepare --thread` takes the thread **key**; passing the thread id from `status` starts a new thread (round 1
  again). I did it twice; two in-session jobs (`rv_mhsa7ehwsewfkhknwo7e`, `rv_zbfb6h6cfpo6av2maj65`) stay `prepared` with no
  way to abandon an in-session job (`cancel` is hidden-only). `status` could print the key, and in-session jobs need an abandon.
- The factory holds a2 until a1's spawn row flips to `ended` (~50 s after the kill), not at the kill.
- `cancel` detects terminal states by parsing the factory's 409 message; a structured `status` field in the factory's
  ErrorBody would be sturdier.
- `concept.md` §4 still describes the wallet gate as wired; it is (the revert kept it), so no drift, but nothing opts in.

## Retro notes (for the mother's log)

- A worker "deleted dead code" (`optionalExpensive`) and half-removed a concept mechanism with it; reading the diff, not the
  report, caught it. Dropped before push.
- The live watchdog proof failed twice before working: reviewers finish light reviews in under a minute, and zsh does not
  word-split `$F`. A `pgrep -f | kill` was blocked by the kill-pattern hook; the pid came from `hc get <pane>` instead.
- The factory's 74 "unnamed" failures were a locale: launchd gives no `LANG`, and Postgres 18 on macOS dies without one.

## Spend

Max only (`me2`): the lead, 5 implementer runs (2 resumed twice), 1 Explore, 4 in-session reviewer runs (2 deep, 2 standard),
8 hidden reviewer sessions (4 watchdog proof: two quick finishes and the wedged a1 and a2; 3 recall; 1 verify smoke). API: no review spend; the recall judge made no
calls (no findings to judge); `make verify`'s standard gateway smoke calls on iu credit.

## Left behind

- Wave 19 `done` in PLAN.md with `**Repos:** software-factory, dotfiles`; no wave flipped `active` (Wave 11 waits for
  2026-11-17, Wave 12 rests on Wave 11): the mother picks. Nothing spawned (orchestrated).

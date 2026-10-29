# Mother handoff

The whole memory of the mother. A fresh mother reads AGENTS.md, `docs/concept.md` §0 and §11,
`docs/waves/PLAN.md` and this file, then continues from **Next action**.

## State
- Waves 1–5 done (retros in concept.md). Active wave: 6 (Research, P3a), CI-green first.
- Lead's close-out channel: `docs/waves/handoff/lead.md` (the mother owns PLAN.md and the retro log;
  the lead writes per-step verdicts, Left behind, gate evidence and retro notes there, then idles).
- dotfiles is free: P0 done (owner, 2026-10-27).
- dotfiles `make doctor` / architecture-check is red outside this fleet (com.iu.athena-postgres,
  com.iu.teamchat-*, collie pin, tailscale drift). Not ours; gates are judged on our rows only.
  `com.jkrumm.vps-pg-backup` is ours: P0b maps it in dotfiles `docs/architecture.md`. Relayed to the lead.

## Lead
- `agent-workflows-w1` (pane w40:p1B), Opus/high, spawned 2026-10-29 ~01:35: the second Wave 6 lead
  (first rotated at 60%; state in `handoff/lead.md` at `2ddc777`).
  Rotation policy: a fresh lead per wave unless the last one closed under ~30% context.
- The mother is agent `agent-workflows-mother` (pane w40:p1).

## Decisions taken
- 2026-10-29: Sonnet review angles for `--deep` only, Haiku default (recall 0.017 → 0.13 at 9.4× cost;
  IU constrained). Revisit when the IU budget relaxes.

## Open decisions
- none

## Overnight
- `dotfiles/scripts/fleet-keepalive.sh agent-workflows-mother <repo> 300` runs detached (pid file and
  log in `~/.local/state/fleet-keepalive/`). It nudges the mother when idle, waits out usage-limit
  banners, respawns her if the pane vanishes. A real stop: write `docs/waves/handoff/STOP` (first line =
  reason) and commit; the keepalive then exits. Restart it after a reboot with the nohup line in its header.

## Obstacles noted
- 2026-10-27: agent-gateway MCP timed out at the mother's session start; the lead checks the `/review`
  door and falls back to `/code-review high` on Max if it stays down, noting it in Left behind.
- 2026-10-27: `rd wave` numbers tabs from labelled "wave N" tabs only, not agent names; the mother was
  named `-w1` and blocked the first spawn. Fixed by renaming the mother. dotfiles fix (count taken
  agent names too) waits until the P0 wave frees dotfiles.
- 2026-10-28: Max room is tight (iu and me at ~98% weekly; me resets 10-29 06:00, iu 10-28 16:00);
  `rd` pauses rather than spilling. A pause is not a stop.
- 2026-10-28: Wave 3 deploy waits on owner 1Password request `20261028T005518-15306` (creates
  `op://mini/agent-workflows/{API_SECRET,ARGO_URL,OTEL_EXPORTER_OTLP_ENDPOINT}`); MacBook unreachable
  overnight. Queued via ask-human; the lead retries. Not a stop.
- For the owner's report (not ours to fix): agent-gateway `dispatch` credential-isolation gap
  (`dispatch-worktree.test.ts` fails on the mini, system `credential.helper osxkeychain`); a sweep
  worker pushed a branch to the IU GitLab repo prometheus-epx (deleted, no MR; rule added to briefs);
  modelpick main checkout has an unpushed local commit `6d7c624` still calling `agw`.
- Wave 4 first step (added to PLAN): direct capability calls over HTTP are billed but not
  recorded (N6) — route them through a one-step run or record their usage.
- 2026-10-28 ~04:05: IU/DeepSeek (Requesty) 503 Insufficient Balance; owner request
  `20261028T040759-9702` queued by the prometheus fleet. Blocks Wave 4's side-by-side numbers if it
  persists — a spend item for the owner (stop reason 2 only if the fleet has nothing else to do).
- 2026-10-28: a lead's `/code-review` fork checked out a branch in the shared main checkout (detached
  HEAD where the mother commits); restored, lesson in briefs. `git status` before every mother commit.
- 2026-10-28 ~09:00 owner direction: DeepSeek behind IU is out of balance (other IU models answer).
  No gateway `/review` in the fleet; interim tests/evals on the Athena team key
  (`op://Private/athena-teamchat/key`, careerpartner; not in the mini cache yet, never in this repo);
  route fallback to GPT-6.1 Terra medium on balance failures; ported review and the `/review` skill
  degrade to "review in-session with /code-review". Relayed to the lead; in PLAN (budget line, Wave 4).
- 2026-10-28 ~09:30: deploy chain done and live-verified (owner answered the re-asked dialog).
  usage-tracker session (`usage-tracker-9f`) fixed the `iu_key` contract; accepted, in PLAN Wave 4;
  tell it when deployed. Owner said a message hit the wrong prometheus-scripts chat; the lead says it
  sent none (owner dialog only) — not from this fleet as far as the record shows.
- 2026-10-28: athena-mother's pane is gone; the team-key usage window (~$3.8) was not announced to
  it. Report to the owner. usage-tracker-9f's socket is gone; the `iu_key` deploy notice was not
  delivered (Argo must accept `iu_key` on its side).
- For the owner: team-key spend Wave 5 ≈ $4.64 (notice in `handoff/lead.md` at `f562b05`); a lead's
  host-wide `pkill -f "bun test --isolate"` ~21:25 may have killed another fleet's test run.
- Gate lesson: the merge train read only the mini's `make check`; CI was red for a wave. Wave 6 fixes it.

## Next action
- Watch the lead (`wave-watch.sh --agents agent-workflows-w1 --heartbeat 9`, bounded 10 min), read
  `handoff/lead.md` on idle, write Wave 6's Left behind and retro, flip Wave 7 active, rotate the lead.

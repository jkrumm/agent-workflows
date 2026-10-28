# Mother handoff

The whole memory of the mother. A fresh mother reads AGENTS.md, `docs/concept.md` §0 and §11,
`docs/waves/PLAN.md` and this file, then continues from **Next action**.

## State
- Waves 1–2 done (retros in concept.md). Active wave: 3 (CLI, agent host, deploy, P1b) — the first deploy.
- Lead's close-out channel: `docs/waves/handoff/lead.md` (the mother owns PLAN.md and the retro log;
  the lead writes per-step verdicts, Left behind, gate evidence and retro notes there, then idles).
- dotfiles is free: P0 done (owner, 2026-10-27).
- dotfiles `make doctor` / architecture-check is red outside this fleet (com.iu.athena-postgres,
  com.iu.teamchat-*, collie pin, tailscale drift). Not ours; gates are judged on our rows only.
  `com.jkrumm.vps-pg-backup` is ours: P0b maps it in dotfiles `docs/architecture.md`. Relayed to the lead.

## Lead
- `agent-workflows-w1` (pane w40:pN), Opus/high, spawned 2026-10-28 ~02:15: the second Wave 3 lead
  (the first rotated at 60% mid-wave; state in `handoff/lead.md` at `2196529`).
  Rotation policy: a fresh lead per wave unless the last one closed under ~30% context.
- The mother is agent `agent-workflows-mother` (pane w40:p1).

## Open decisions
- none

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
- Wave 4 first step to add at Wave 3 close: direct capability calls over HTTP are billed but not
  recorded (N6) — route them through a one-step run or record their usage.

## Next action
- Watch the lead (`wave-watch.sh --agents agent-workflows-w1 --heartbeat 9`, bounded 10 min), read
  `handoff/lead.md` on idle, write Wave 3's Left behind and retro, flip Wave 4 active, rotate the lead.

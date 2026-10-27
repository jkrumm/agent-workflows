# Mother handoff

The whole memory of the mother. A fresh mother reads AGENTS.md, `docs/concept.md` §0 and §11,
`docs/waves/PLAN.md` and this file, then continues from **Next action**.

## State
- Wave 1 done 2026-10-27 (retro in concept.md). Active wave: 2 (Core runtime, P1a).
- Lead's close-out channel: `docs/waves/handoff/lead.md` (the mother owns PLAN.md and the retro log;
  the lead writes per-step verdicts, Left behind, gate evidence and retro notes there, then idles).
- dotfiles is free: P0 done (owner, 2026-10-27).
- dotfiles `make doctor` / architecture-check is red outside this fleet (com.iu.athena-postgres,
  com.iu.teamchat-*, collie pin, tailscale drift). Not ours; gates are judged on our rows only.
  `com.jkrumm.vps-pg-backup` is ours: P0b maps it in dotfiles `docs/architecture.md`. Relayed to the lead.

## Lead
- Wave 1 lead closed at 43% context; rotated at the wave boundary (Wave 2 is the heaviest).
- `agent-workflows-w1` (pane w40:p8, tab "wave 1"), Opus/high, fresh, spawned 2026-10-27 for Wave 2.
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

## Next action
- Watch the lead (`wave-watch.sh --agents agent-workflows-w1 --heartbeat 9`, bounded 10 min), read
  `handoff/lead.md` on idle, write Wave 2's Left behind and retro, flip Wave 3 active, rotate the lead.

# Mother handoff

The whole memory of the mother. A fresh mother reads AGENTS.md, `docs/concept.md` §0 and §11,
`docs/waves/PLAN.md` and this file, then continues from **Next action**.

## State
- Active wave: 1 (Foundations). Lead spawned 2026-10-27; its agent name is in **Lead** below.
- Lead's close-out channel: `docs/waves/handoff/lead.md` (the mother owns PLAN.md and the retro log;
  the lead writes per-step verdicts, Left behind, gate evidence and retro notes there, then idles).
- dotfiles is free: P0 done (owner, 2026-10-27).
- dotfiles `make doctor` / architecture-check is red outside this fleet (com.iu.athena-postgres,
  com.iu.teamchat-*, collie pin, tailscale drift). Not ours; gates are judged on our rows only.
  `com.jkrumm.vps-pg-backup` is ours: P0b maps it in dotfiles `docs/architecture.md`. Relayed to the lead.

## Lead
- `agent-workflows-w1` (pane w40:p3, tab "wave 1"), Opus/high, spawned 2026-10-27 for Wave 1.
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
- Watch the lead (`wave-watch.sh --agents <lead> --heartbeat 20`), read `handoff/lead.md` on idle,
  write Wave 1's Left behind and retro, flip Wave 2 active, brief the lead for Wave 2.

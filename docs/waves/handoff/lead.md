# Lead handoff — Wave 10 (Claude Code and Hermes slimmed; P5): IN PROGRESS

Lead: `agent-workflows-w1`. Wave 9 close-out is in git at `06f0af1`. Briefs: `~/.local/state/agent-workflows/briefs/w10/`
on the mini (not in git).

## Plan of the wave (from a caller inventory, 2026-10-29)

Batch 1 (spawned): agent-workflows `w10/overview` (agents snapshot, `overview` workflow, Max quota store, Argo push),
`w10/narrative` (`narrative` + `prose-polish` with an IU writer route for callers without a Claude session),
`w10/routes-cmd` (`agw routes`); dotfiles `w10/dotfiles-slim` (global CLAUDE.md, skills, MCP registration); agent-gateway
`w10/mcp-server-deleted`; hermes-agent `w10/hermes-skills-agw` (research, hyperdx, dispatch skills on the CLIs).

Batch 2 (after batch 1 is live): dotfiles statusline/fetch_usage/devhost-health/agent-overview pane on `agw quota` and
`agw agents`; hermes-agent scripts (narratives, overview, prose, quota-nudge) on `agw`; modelpick on `agw routes`;
agent-gateway's Argo overview push removed in the same live step as the host's push starts.

Wave 11 by scope (not moved here): research-gateway/audio-gateway services and their probes, Caddy rows, Kuma monitors,
HyperDX alerts; argo's audio routes; usage-tracker collectors; agent-gateway's HTTP job handlers.

## Done inline

- warden: GitHub repo archived (its agent-gateway client goes with it).
- weatherorb: stale `mcp__research-gateway__job_status` permission removed (untracked local settings).

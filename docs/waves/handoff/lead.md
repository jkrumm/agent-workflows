# Lead handoff — Wave 11 (Retire and hand over; P6): IN PROGRESS

Lead `agent-workflows-w1`, started 2026-10-29 ~21:00. Briefs and the final-backup script:
`~/.local/state/agent-workflows/briefs/w11/` on the mini (not in git). Wave 10 close-out: this file at `c30f318`.

## Found on the way (not in the Wave 10 list)

- agw's host reached OpenCode only through agent-gateway: `~/.local/bin/opencode` and `opencode-safe` linked into the
  agent-gateway checkout, the pinned build lived in `~/.local/share/agent-gateway/opencode-bin`, react-doctor in its
  install. Moved into this repo (#67, `make install-opencode`, `scripts/pins.sh`, `make verify` checks the pins).
- MacWhisper on the MacBook transcribes through the VPS audio-gateway (`customOpenAIWhisperProviderBaseURL`). Mother
  approved the move to agw's audio door: a path-restricted Caddy clean-door host (tag:mac → devhost :443 already allowed,
  no ACL change), own `macwhisper` door token (issued, audio process restarted, probe authenticates).
- usage-tracker's agent-gateway collectors read agent-gateway's own OpenCode store: mother says remove them right after
  agent-gateway stops, this wave.

## Merged and live

|Change|PR|Live proof|
|-|-|-|
|homelab Kuma monitors (Agent Gateway push, Audio Gateway HTTP)|homelab #17|apply pending (`sync.py --dry-run` then `--delete-orphans`, after the stop)|
|brain research-gateway scripts deleted, renderer on agw research output|brain #2|checkout at `735a9c0`|
|Hermes: dispatch skill deleted, drift audit in-turn, ops allowlists, docs|hermes-agent #12|pulled, `make setup` dropped the skill link, cron job `8fe7be4985d9` re-registered (skills: obsidian), allowlist patch re-applied to `~/.hermes/hermes-agent` (takes effect at the next gateway restart)|
|argo `/ai` audio routes and dashboard voice deleted|argo #207|RollHook deployed `0097838` (api + dashboard); `/ai/v1/audio/*` 404, `/ai/v1/models` 401|
|vps audio-gateway app, alerts/dashboards files, argo env|vps #14|VPS checkout pull + container stop + HyperDX deletes pending (stop step)|
|modelpick agent-gateway and warden rows|modelpick #3|`make db-seed`: services agent-workflows 16, no agent-gateway/warden|
|agent-workflows owns the OpenCode build and react-doctor|#67 (`/code-review high`: 7 findings, 6 fixed, promote-after-gate declined as follow-up)|`make install-opencode`, deploy `843f283`, `make verify` PASS; host OpenCode server runs from `~/.local/share/agent-workflows/opencode-bin/2.0.32`|

## Open

- agent-workflows `w11-drop-legacy-paths`, dotfiles `w11-retire-gateways` (+ the audio.mini door), usage-tracker
  `w11-drop-gateway-collectors`: workers done, review next.
- Then: stop + final backups (`final-backup.sh`), LaunchAgents removed, VPS container down, DNS record, HyperDX
  deletes, Kuma apply, MacWhisper repoint, `agw-legacy`/`research` links deleted, repos archived (agent-gateway PR #35
  closed first), architecture map and `make doctor`, `docs/factory-input.md`.

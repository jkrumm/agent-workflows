# Lead handoff — Wave 11 (Retire and hand over; P6): CLOSE-OUT

Two leads in tab `agent-workflows-w1`: the first 2026-10-29 ~21:00 → ~22:40 (rotation at `4d0ccc8`), the second
~22:45 → ~00:15. Briefs, the final-backup script, the HyperDX helper and train logs live in
`~/.local/state/agent-workflows/briefs/w11/` and `…/w12/` on the mini (not in git). Wave 10 close-out: this file at `c30f318`.

## Live state

agent-workflows release `098b7e6` (host + audio), `make verify` PASS (smoke `01a189e0-6821-…`, cap `01a189e0-7178-…`,
audio `01a189e0-789a-…`). **research-gateway, audio-gateway (mini and VPS) and agent-gateway are stopped, backed up
and archived.** Their data stays in place (data rule): `~/.local/share/agent-gateway`, `~/.research-gateway`,
`~/SourceRoot/audio-gateway/{data,out}`, VPS `/var/lib/audio-gateway`. The six retired plists and the
research-gateway-deploy jobrun state are in `~/.local/state/agent-workflows/retired-plists/` (moved, not deleted).
Main checkout clean after this commit.

## Final backups (HomeLab `/mnt/hdd/backups/<name>-final/`, `sha256sum -c SHA256SUMS` OK on every file)

|Name|Files|
|-|-|
|research-gateway|data + logs 3.7 M, repo bundle 1.6 M|
|audio-gateway (mini)|data, data.bak-local, out, logs 431 M, repo bundle 684 K|
|audio-gateway-vps|`/var/lib/audio-gateway` 65 M|
|agent-gateway|data 1.4 G (opencode-bin and react-doctor excluded; `gzip -t` OK, `jobs.db` inside), state + logs + Kuma push URL 171 M, repo bundle 3.9 M|

## Merged and live (whole wave)

|Change|PR|Review|Live proof|
|-|-|-|-|
|homelab Kuma monitors removed|homelab #17|lead diff read (config deletion)|dry run listed exactly the 3 orphans; `--delete-orphans` deleted ids 244, 245, 192; re-run: 0 orphans|
|brain research-gateway scripts deleted; renderer on agw output|brain #2|lead diff read|checkout `735a9c0`|
|Hermes: dispatch skill gone, in-turn drift audit, ops allowlists, docs|hermes-agent #12|lead diff read r1|`make setup` dropped the skill link; cron `8fe7be4985d9` re-registered; allowlist patch in `~/.hermes/hermes-agent` (effective at next Hermes gateway restart, not restarted on purpose)|
|argo `/ai` audio routes, dashboard voice|argo #207|lead read|`/ai/v1/audio/*` 404; no caller since the 20:35 UTC proofs|
|argo dispatch count optional|argo #208|lead diff read|RollHook `5149cdc`|
|vps audio-gateway app, alerts/dashboard files, argo env|vps #14|lead r1|container removed, checkout `f683d48`, `.env` gone, HyperDX: 10 alerts + 2 dashboards deleted (200 each, re-list empty), Cloudflare A record deleted (no answer from 1.1.1.1), local images removed; RollHook authorizes by container label, so removing the container deregistered it|
|modelpick agent-gateway + warden rows|modelpick #3|lead r1|`make db-seed`: no rows|
|agw owns OpenCode build + react-doctor|#67|`/code-review high`: 7 findings, 6 fixed; declined promote-after-gate (follow-up)|deploy `843f283`, verify PASS|
|agw legacy read paths deleted; eval floors from recorded legacy self-agreement; `summary.dispatch` dropped|#68|`/code-review high`: 10 findings, fixed/declined as recorded at `4d0ccc8`|deploy `412165c`, verify PASS|
|dotfiles: gateways out of the machine config, docs rewritten; `audio.mini` path-restricted door, landing probe inside the restriction, registry refusals + tests, devhost probe for the audio process, setup hardening|dotfiles #48|`/code-review high` r1 (7 findings, all fixed); lead diff read r2; `caddy-registry-test` 10/10|merged `e97d01e` (train ran every check target except `architecture-check`, red only on the six gateway labels until the stops; one load flake in `claude-account.test.ts`, 237/0 on rerun). Applied: `caddy-tailnet` (stale `exclude agent-gateway` + its comment removed from `~/.config/caddy-tailnet.ports`), OpenCode service env, devhost check `services up (9)`. Door: 401 on `/v1/audio/speech`, 404 on `/api/runs`, `/health`, `/`; landing `/_up/audio` 401. MacBook `verbose_json` transcription through the door with the `macwhisper` token OK|
|usage-tracker agent-gateway/audio-gateway collectors removed|usage-tracker #15|lead diff read|merged `066eff8` after the agent-gateway stop, checkout pulled (15-min jobrun picks it up)|
|audio door env key renamed `AGW_DOOR_TOKENS` → `AGW_DOOR_CALLERS_FILE` (doctor flagged it as a plaintext credential; it only holds the path)|#69|Review: lead diff read only; reason: 4-line rename of an env key, no logic; train + CI green (one opencode-host abort-test load flake, 81/0 ×2 on rerun)|deploy `098b7e6`, verify PASS, rendered plist carries the new key|

## Stops (each proven)

1. research-gateway (+ deploy, lightpanda): booted out; no listener on 7780/7781; its orphaned solver Chrome (ppid 1,
   `--user-data-dir=~/.research-gateway/solver-chrome`, one PID) stopped; plists moved.
2. audio-gateway (mini, :7719): booted out, no listener, plist moved. Last traffic 2026-10-26.
3. agent-gateway + agent-gateway-opencode: last job 11:40 UTC (iris triage; iris moved to agw at 13:43 UTC, `8d06b1a`);
   booted out, three orphaned `opencode serve` 2.0.32 PIDs from its bin dir stopped, no listener on 7705, plists moved.
4. VPS audio-gateway: callers checked in Traefik (MacBook = MacWhisper, moved; mini burst at 14:37 UTC with no
   configured source; HomeLab = the Kuma probe, deleted); backup, then `docker rm -f`.

## `@verifier` sweep (after deploy `098b7e6`): 16/16 PASS

No gateway LaunchAgent, plist, listener (7705/7719/7780/7781) or process (the ten `mcp.ts` stdio children aside); VPS
container gone, `/var/lib/audio-gateway` kept; mini data in place; all 8 backup files `sha256sum -c` OK; three repos
archived; `agw-legacy`/`research` links gone; host and audio at `origin/master`, `make verify` PASS; `agw overview`
has no `dispatch` key; Hermes gateway up, no enabled cron job references a gateway; Caddy has no gateway upstream;
architecture-check red only on `com.iu.*`; usage-tracker's first run on `066eff8` rc 0. Flags handled: an active Hermes
skill reference (`heartbeat-monitoring/references/sideclaw-launchagent-case-study.md`, agent-gateway's old name,
told readers to query `:7705`) moved to `~/.hermes/skills/.retired-gateways-2026-10-29/` and its pointer dropped
from `SKILL.md`.

## Left behind

- **MacWhisper:** base URL set to the `audio.mini` door (`ask-human`, done). The owner reported "unauthorized": the
  app still held the old key. Token put on the MacBook clipboard again, owner told to paste it into the custom
  provider's API key field. Proof pending: a second `"caller":"macwhisper"` line in `agent-workflows-audio.out.log`
  (the first is the lead's test).
- Hermes cron "Morning briefing" (disabled since 10-26): its prompt still describes the `· N dispatch` count and an
  `audio-gateway` example line; update the prompt before re-enabling it.
- Hermes gateway not restarted: the narrowed cron allowlist is live in the tree, effective at the next restart.
- Ten `bun run …/agent-gateway/server/mcp.ts` stdio children of other live Claude sessions: not killed (not ours to
  stop; they end with their sessions; their user-scope registration is removed by dotfiles `_setup-opencode`).
- PID with a Homebrew OpenCode 2.0.25 from `/tmp/ocv2` (15 days, ppid 1): not a gateway process, left alone.
- Registry images (`ghcr.io/jkrumm/audio-gateway`, the RollHook registry copy) not deleted.
- vps docs/comment rewording listed in vps #14's body (weatherorb/image-gateway comments, `docs/observability.md`).
- Follow-ups: promote-after-gate for OpenCode upgrades (#67); the opencode-host "abort interrupts once" test races
  under load.
- `make doctor` rows not ours: `com.iu.*` map rows, collie pin, tailscale drift; disk-sweep/drift-check jobs failing;
  swap at 52 % from other projects' load.

## Spend

IU: brain worker one `agw research` probe; `make verify` ×4 (< $0.001 total). Max: two leads, 11 workers, 3
`/code-review high`, one `@verifier`.

## Retro notes (for the mother's retro log)

- Verify before building found the two biggest items the inventory missed: the platform itself depended on the
  retiring gateway (OpenCode build, react-doctor), and an owner device (MacWhisper) was a live caller. A retirement
  inventory must include "what does the replacement depend on" and the old service's access logs (client IPs).
- The access log beat the code sweep twice: Traefik named the MacBook (MacWhisper) and showed the app's real path
  (`/v1/v1/audio/…`), which settled the base-URL question the docs got wrong; agent-gateway's own job table showed
  iris's last call and dated it before iris's switch.
- Observers go first: Kuma monitors and HyperDX alerts deleted before the stops, so no stop paged.
- Retired services leave state outside their own dirs: a jobrun state file graded `unloaded` forever, a
  `caddy-tailnet.ports` exclude, an orphaned solver Chrome, orphaned OpenCode servers. The stop checklist names them.
- `make doctor` flagged an env key by name (`…TOKENS`) on our own audio plist since Wave 8; nobody read that row
  because the map rows around it were red for other reasons. Read every row, not the summary.
- Load 80–120 from other projects made each merge train cost 10–15 minutes and produced two test flakes in files the
  change did not touch; re-running the single file before retrying the train kept it cheap.
- Workers stop at owned-file boundaries and list the rest: a cheap r1 "now owned: …" round closes it without a re-brief.

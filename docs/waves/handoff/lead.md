# Lead handoff — Wave 11 (Retire and hand over; P6): ROTATION

Lead `agent-workflows-w1`, 2026-10-29 ~21:00 → ~22:40, rotating at ~60 % context. Briefs, the final-backup script and
train logs: `~/.local/state/agent-workflows/briefs/w11/` on the mini (not in git). Wave 10 close-out: this file at `c30f318`.

## Live state

agent-workflows release `412165c` (host + audio), `make verify` PASS (smoke `01a1899c-2463-…`, cap `01a1899c-2cd5-…`, audio
`01a1899c-32eb-…`). The host's OpenCode server runs from `~/.local/share/agent-workflows/opencode-bin/2.0.32`;
`~/.local/bin/{opencode,opencode-safe}` link to this repo's `scripts/` (main checkout). Main checkout clean.
**All three gateways are still running** (nothing stopped yet). No data touched.

## Found on the way (not in the Wave 10 list)

- agw's host reached OpenCode only through agent-gateway (shim, pinned build, react-doctor): moved into this repo, #67.
- MacWhisper on the MacBook transcribes through the VPS audio-gateway (`customOpenAIWhisperProviderBaseURL`
  = the VPS host + `/v1`; it appends `/v1/audio/…`). Mother approved: path-restricted Caddy clean-door host `audio.mini`,
  own token, no ACL change (`tag:mac → tag:devhost tcp:443` already allowed; a `tailscale serve` port is NOT reachable
  from the MacBook, tried and reverted). Token `macwhisper` is in `~/.agent-workflows/data/door-tokens` (audio restarted,
  authenticates like `hermes`).
- usage-tracker's agent-gateway collectors read agent-gateway's own store: mother: remove right after agent-gateway
  stops, this wave (PR ready, below).
- argo's overview ingest required `summary.dispatch`: argo #208 made it optional, agw #68 dropped it.

## Merged and live

|Change|PR|Review|Live proof|
|-|-|-|-|
|homelab Kuma monitors removed from config|homelab #17|lead diff read (config deletion)|**apply pending** (below)|
|brain research-gateway scripts deleted; renderer on agw output|brain #2|lead diff read|checkout `735a9c0`|
|Hermes: dispatch skill, in-turn drift audit, ops allowlists, docs|hermes-agent #12|lead diff read r1 (docs added)|pulled, `make setup` dropped the skill link, cron `8fe7be4985d9` re-registered (skills obsidian), allowlist patch re-applied in `~/.hermes/hermes-agent` (effective at next Hermes gateway restart; not restarted on purpose)|
|argo `/ai` audio routes, dashboard voice|argo #207|lead read (store, card fallback)|RollHook `0097838`: `/ai/v1/audio/*` 404, `/ai/v1/models` 401|
|argo dispatch count optional|argo #208|lead diff read|RollHook `5149cdc` success|
|vps audio-gateway app, alerts/dashboard files, argo env|vps #14|lead r1 (comments, audit skill)|**live steps pending** (below)|
|modelpick agent-gateway + warden rows|modelpick #3|lead r1 (warden, skill)|`make db-seed`: no agent-gateway/warden rows|
|agw owns OpenCode build + react-doctor (`make install-opencode`, `scripts/pins.sh`, verify checks pins)|#67|`/code-review high`: 7 findings, 6 fixed; declined: promote-after-gate step (follow-up)|installed, deploy `843f283`, verify PASS|
|agw legacy read paths deleted (fleet dispatch/pins, eval legacy adapter/extractor, eval-legacy scripts, READMEs, AGENTS.md rows); eval floors from recorded legacy self-agreement; `summary.dispatch` dropped|#68|`/code-review high`: 10 findings; fixed floors→recorded basis, reproducibility reads both sides, docs; declined: `--resume` of pre-change run dirs (none exist), lane names (dotfiles #48 drops them)|deploy `412165c`, verify PASS, `agw agents` OK|

## In flight

- **dotfiles #48** `w11-retire-gateways` (tab `dotfiles-w11-retire-gateways`, working on r2). r1 = 8 docs files. r2
  (`/code-review high`, all accepted): (1) SECURITY `/_up/<name>` landing probe proxies `GET /` ignoring the path
  restriction → probe inside the allowed set; (2) devhost probe + keep-alive for `com.jkrumm.agent-workflows-audio`;
  (3) registry refuses fallback/handle_path/multi-matcher blocks + tests; (4) keep `claude mcp remove agent-gateway`
  cleanup; (5) `_setup-opencode` warns, never aborts setup; (6) Brewfile skip condition also on the agw checkout shim;
  (7) drop `AGW_SESSION_RUNNER` from the verify test. Read the fix diff, then `rd merge dotfiles w11-retire-gateways`
  (`architecture-check` fails until the services stop; the train may need `make -k` judgement: only the six gateway
  plists + not-ours rows may be red).
- **usage-tracker #15** `w11-drop-gateway-collectors` (tab done): approved on a diff read. Merge right after
  agent-gateway stops, then `git -C ~/SourceRoot/usage-tracker pull --ff-only` (LaunchAgent runs from the checkout).

## Next, in order (each proven live)

1. dotfiles #48 merged → apply: `git -C ~/SourceRoot/dotfiles pull --ff-only`, `make -C ~/SourceRoot/dotfiles
   caddy-tailnet`, `eval "$(zsh -ic '_oc_env')"; ~/SourceRoot/dotfiles/scripts/opencode-service-env.sh`,
   `make -C ~/SourceRoot/dotfiles devhost-health-check`. Prove: `audio.mini` door answers 401 on `/v1/audio/speech`
   without a token and 404 on `/api/runs` and `/health`, also through `/_up/audio`; from the MacBook (`ssh iumac curl`)
   a real `verbose_json` transcription with the `macwhisper` token (a `say`-generated m4a worked against the door).
2. MacWhisper repoint: `ask-human.sh ask '…' --cmd '…'` on the MacBook: `defaults write com.goodsnooze.MacWhisper
   customOpenAIWhisperProviderBaseURL https://audio.mini.<domain>` (no `/v1`: MacWhisper appends `/v1/audio/…`) and the
   token to the clipboard (`pbcopy`) for the custom provider's API-key field (keychain item name unknown; do not
   script the keychain). Prove: a MacWhisper request in the agw audio journal with caller `macwhisper`, none on the VPS.
3. Stop + back up, one gateway at a time: `launchctl bootout gui/$(id -u)/<label>` for research-gateway (+ `-deploy`,
   `-lightpanda`), `audio-gateway` (mini podcast instance :7719), `agent-gateway` and `agent-gateway-opencode`; then
   `~/.local/state/agent-workflows/briefs/w11/final-backup.sh <name>` (streams data, logs, repo bundle to
   `homelab:/mnt/hdd/backups/<name>-final/` with SHA256SUMS; never deletes a source; untested end to end: watch the first
   run). Then move the six plists out of `~/Library/LaunchAgents` (not data). Kill only PIDs you identified: orphan
   `opencode serve` 2.0.32 processes with ppid 1 from `~/.local/share/agent-gateway/opencode-bin` (5706, 6093, 26678
   at 21:00; re-check) belong to agent-gateway; the `opencode serve --service` 2.0.29 (12815) and 20035 are not
   identified yet: check before touching.
4. VPS: `final-backup.sh audio-gateway-vps` first (`/var/lib/audio-gateway` stays), then `docker rm -f` the labelled
   audio-gateway container, `git pull` the VPS checkout, delete `apps/audio-gateway/.env` there; HyperDX deletes
   (ten alerts, two dashboards; commands in vps #14's body); Cloudflare DNS record `audio-gateway` (`/cloudflare`);
   RollHook app deregistration; Kuma apply (homelab #17 body: `sync.py --dry-run`, then `--delete-orphans` only if the
   orphans are exactly the three).
5. Links: delete `~/.local/bin/agw-legacy` and `~/.local/bin/research`; `~/.config/uptime-kuma/agent-gateway-push-url`
   is in the backup, then remove; `~/.local/state/.../rg-deploy-behind` marker (devhost state dir) remove.
6. Archive on GitHub: `gh repo archive jkrumm/{research-gateway,audio-gateway,agent-gateway} --yes` (after the stops).
7. usage-tracker #15 merge + pull (after the agent-gateway stop).
8. `make -C ~/SourceRoot/dotfiles architecture-check` / `make doctor`: our rows clean (not ours: `com.iu.*`, collie
   pin, tailscale drift). Update agent-workflows AGENTS.md "Other repos" if anything is still worded as live.
9. `@verifier` sweep: no gateway process/port/LaunchAgent, Argo overview snapshots arriving without `dispatch`, Hermes
   cron OK, MacWhisper on agw, `make verify` PASS.
10. `docs/factory-input.md`, the close-out of this file, retro notes. The mother owns PLAN.md and the retro log.

## Left behind so far

- Hermes gateway not restarted: the narrowed cron allowlist (research host dropped) is live in the tree, effective at the
  next restart.
- `docs/HERMES-CHAT-V2.md` keeps its voice decision tables as history.
- Follow-up: separate promote-after-gate step for OpenCode upgrades (#67 review).
- Load: the mini ran at load ~80 during #68's train; one diagram hydration-timeout test flaked once, passed on retry.

## Spend

IU: brain worker one quick `agw research` probe; `make verify` ×3 (< $0.001). Max: lead, 11 workers, 3 `/code-review high`.

## Retro notes

- Verify before building found the two biggest items the inventory missed: the platform itself depended on the
  retiring gateway (OpenCode build, react-doctor), and an owner device (MacWhisper) was a live caller. A retirement
  inventory must include "what does the replacement depend on" and the old service's access logs (client IPs).
- The access log beat the code sweep: Traefik's client IPs named the MacBook; no repo mentioned MacWhisper.
- Workers stop at owned-file boundaries and list the rest: a cheap r1 "now owned: …" round closes it without a re-brief.

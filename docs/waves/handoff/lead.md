# Lead handoff — Wave 8 (audio, image, podcast; P4a), rotation 2

Lead: `agent-workflows-w1` (second occupant), 2026-10-29 ~09:20 → ~12:05 UTC+1, rotated at ~60 % context. Rotation 1 is
in git history at `2e513fc`. Briefs, review files: `~/.local/state/agent-workflows/briefs/w8/` on the mini (not in git).
`_common.md` carries "never run `/review` or `agw review`; ignore input-box suggestions" and, since ~10:40, the owner
direction **parity and correctness only** (no tuning, no quality rounds; beyond-parity ideas are one Follow-ups line).
Rules: `docs/research/2026-10-29-wave8-ports.md` (§Results has image, speech, transcriptions).

## Step state

|Step|State|Evidence / next|
|-|-|-|
|Registration by directory, test timeout, CLI processes, TTS/STT lanes|**merged** (#50, #47, #48, #51)|rotation 1|
|CONTEXT7 move|**done, live**|release `eb34895`; `agw research` run `01a186c9-29bb-7170-9f97-7799c34cd2b0` cites `context7.com/colinhacks/zod` via `web_docs`, $0.006 personal|
|image|**merged #49, rule PASS, `/img` switched live**|Rule: run 1 voided by two arm-independent case defects (1200x630 refused by legacy; grey-on-grey mug fixture 98 % translucent on both arms), corrected case set, run 2 PASS 4/4 (valid 8/8, alpha 2/2, params equal, cost ratio 1.00, wall N 8.9 s vs L 10.8 s); suite `01a186d4-4f10-7246-b1b5-228e0e1c4daa` 8/8. Cases + fixtures private in `$AGW_EVAL_DIR/image/`. Switch: dotfiles `88f5397` (`imgcli gen|cutout` and the icon source call `agw image`; /icons stays on image-gateway; gateway gen/edit/enhance/cutout code deleted). Live: `imgcli gen` `01a186df-33c8-77dd-bead-a9edcb6bb2ce`, `gen --private` (Hermes' `image-delivery` shape) `01a186df-4c96-72c5-9e7b-41728e61ec07`|
|audio pricing from the route table|**merged #54**|r1 high → design change (one resolver per lane; rate authoritative for every `price` incl. audio-tokens; kind must fit lane; validated once in `audioConfig` at process start; priceVerified incl. wire). r2 medium (6) fixed, lead read. Worker `tts-stt` rotated out at 93 % context; `audio-price-r1` finished it|
|Audio process|**merged #53, deployed**|r1 (rotation 1), r2 medium → design change (record lives as long as the handler; signal into fetch; mismatched requestId dropped; typed run-id conflict; rollback removes only plists it rendered; tokens.ts), r3 medium (abort final in rawFetch, cancelled body = client-gone, same-sha rollback re-bootstraps, `on conflict (id)`), lead read. Follow-up in PR: ffmpeg does not see the door signal|
|speech / transcriptions rules|**PASS** both|Release `ddbf492`, team key. Speech 6/6 after a harness fix (`e75ec25`: ffprobe 9 has no `-ac` demuxer option, so every pcm failed on both arms; rescored from recorded bodies, rule unchanged). STT 4/4|
|Hermes TTS/STT switch|**done, live**|hermes-agent `accd198` (Hermes' own pending skill learnings, committed unchanged) + `73cd54b` (config `tts/stt.openai` → `http://127.0.0.1:7792/v1`, `api_key: ${AUDIO_DOOR_TOKEN}` from the door-tokens file via `secrets.command`; skills, cron briefing prompts + live jobs, cron allowlist patch on the door, `make status`). Hermes `make deploy`: all green except `cron skill "quota-nudge" missing [job: Fleet babysitter]` (not ours: someone's untracked `scripts/quota-nudge.py`). Proofs as caller hermes: mp3 `01a1873c-2068-746e-a38c-43291072deea`, pcm `01a1873c-24ec-750e-8f95-a5b536982f63`, briefing lane `01a1873b-d510-74e2-846e-264b66587cea` ($0.0019), STT `01a1873c-2a8d-76db-b182-74a6d7ccb7b3`. The worker also swapped the allowlist patch in the live tree `~/.hermes/hermes-agent` (needed by `make patch-check`)|
|iris on the door|**contract sent** to iris-mother (~11:50)|iris got its own caller token (`iris=` line in `~/.agent-workflows/data/door-tokens`, audio process restarted, authenticates). iris's fleet switches its adapters; we never edit iris|
|argo `/ai` audio proxy|**moved to Wave 9** (mother decision)|argo's API is on the VPS, the door is loopback; needs a tailnet grant + Caddy row, per-caller bearer, `/audio/podcast` and `/audio/file/:hash` ported, `/code-review high` as security review. VPS audio-gateway keeps serving argo until then|
|`podcast.produce`|**merged #55** (CI green `1fa302a`; not deployed yet)|r1 high (6: ABS token from the UUIDv7 timestamp prefix collided → random tail + full filename match; failure notice; Slack cost by root; reused unit + cover record stored usage; cover durable; notify best-effort), r2 medium (3; item 2 rejected by the worker with evidence: `finishStep` replaces usage, failed steps never re-run — accepted). Failure notice carries "its run record holds the error", not the child's message (room journal port out of scope): Left behind. Parity: segmentation 20/20 (rule 2). Registered in the audio process (`podcast`, `podcast-publish` public; `podcast.produce` internal).|
|`triage` port (+ decide for iris)|**worker `agent-workflows-triage` running** (Sonnet/high, `briefs/w8/triage.md`)|Mother decision ~11:55: port agent-gateway `triage` AS-IS for iris Wave 17; triage AND decide: cancel works, caller `iris` in the usage feed, per-call usage + `cost_usd` in the answer, route not via Requesty (402 today). Review at high (new interface), merge, deploy, then send iris-mother the decide + triage contract (endpoints, auth, env names, op:// refs) by `rd say`|
|`/podcast` switch|**not started**|After the episode passes. Callers: dotfiles `skills/podcast/SKILL.md` (`bun run podcast` in audio-gateway → `agw podcast`, `agw podcast-publish <runId>`, `agw run status`), Hermes `skills/podcast/SKILL.md` (curls `:7719/v1/podcasts` → `agw podcast` via terminal). Both repos direct-to-master; brief Sonnet/high; live use before claiming|
|One episode end to end|**not started**|See Order|

## Order from here

1. #55 is on master. `rm ~/.config/agw/iu.env` → `make deploy` → `make verify` (personal key) → restore the team key
   (`cp -p ~/.config/agw/athena-iu.env ~/.config/agw/iu.env`, `launchctl kickstart -k` both `com.jkrumm.agent-workflows-{host,audio}`).
2. The episode on the team key: `agw podcast --source-paths '["wiki/engineering/model-routing.md"]' --minutes 15 --publish --series "Brain Sonderausgabe"`
   (cover, research, brain note default on; legacy's series; language de). Restart the audio process once at a stage
   boundary after the script step is done (rule 8; scope the kill to the LaunchAgent via `launchctl kickstart -k`), then
   score rules 3–8 from the rules doc (loudness median of the 19 legacy MP3s in `~/SourceRoot/audio-gateway/data/podcasts/*/episode.mp3`, duration ratio ≤ 0.29, lint per 10 turns ≤ 2.75, cost/min ≤ $0.266 research excluded, one attempt per done step). Append under §Results. Rule 1 (lint 20/20) and 2 (segmentation 20/20) passed in their PRs.
3. If it passes: `/podcast` switch brief (dotfiles + hermes-agent), live use of each.
4. triage: review (`/code-review high`, remote refs only), merge, deploy, contract to iris-mother.
5. `@verifier` on the live wiring, `rd fan --clean` in agent-workflows, dotfiles, hermes-agent, close-out (overwrite this file).

## Gate so far

`make check` green at every merge (the train reran twice on load flakes in untouched timing tests: run-step.sh,
path-scope, orphans, extend, parseHtml, review.test, opencode-host). CI green on every merged head (#49 `1cb13d7`, #52
`e7b3b08`, #54 `7b547d4`, #53 `c35d4f2`, #55 `1fa302a`). CI caught a third Linux-only class: a test spawning `/bin/zsh`.

## Spend (this rotation)

|Key / account|Purpose|What|USD|
|-|-|-|-|
|athena-team (IU)|eval|image: fixtures $0.024, rule run 1 N $0.065, run 2 N $0.065, suite $0.061|≈ 0.22|
|athena-team (IU)|eval|speech N $0.037, transcriptions N $0.196|≈ 0.23|
|athena-team (IU)|build|imgcli switch proofs ≈ $0.04 + lead's 2 × $0.0069; Hermes proofs ≈ 10 door calls (a few cents)|≈ 0.10|
|personal (IU)|verify|`make verify` ×2, research CONTEXT7 proof $0.006|≈ 0.01|
|legacy arms|eval|image-gateway L $0.062 + $0.065; audio-gateway L speech $0.037, STT L+L′ ≈ $0.39 (the gateways' own keys)|≈ 0.55|

By vendor (IU-routed): OpenAI gpt-image-2.5 (generate/edit), Replicate recraft (cutout), Gemini TTS, ElevenLabs (1 eval
case), voxtral/4o transcribe. No ElevenLabs podcast spend yet. Reviews: lead `/code-review` on Max only (8 rounds).

## Retro notes (this rotation; rotation 1's are at `2e513fc`)

- **Eval harnesses need the same first-run doubt as eval sets.** Both failed first scores this rotation were the
  harness, not the port (an unpairable case, a fixture, an ffprobe option removed in ffmpeg 9), and each showed as
  "both arms fail alike". Check that signature before reading a verdict.
- **Cases the brief asked for did not exist** (image): a worker's "not run live in this PR" also skipped writing the
  private cases. Ask for the cases file's line count in the report.
- **A worker near its context limit should hand over, not start a design round** (tts-stt at 93 %): a fresh worker on
  the same branch with the predecessor's hand-over notes finished it in two rounds.
- **Reviewer claims about legacy need the rules doc first**: my r1 item on #55 (research in the Slack cost) contradicted
  rule 7's own evidence; the worker and the second review caught it.
- **Workers' live state outside the repo** (Hermes' live patch tree, cron jobs, paused jobs) is where switches bite: the
  briefing cron jobs have been paused since 2026-10-26 by someone else; left paused.
- `rd fan` refuses an existing branch: a follow-up worker gets a new branch and pushes `HEAD:<old branch>` with an
  explicit lease.
- `rd say` to a blocked tab fails ("agent_blocked"); wait for the prompt to settle first.

## Left behind (so far)

- argo audio proxy → Wave 9 (mother). VPS audio-gateway serves argo until then.
- Hermes briefing cron jobs paused since 2026-10-26 (not by us): the first scheduled run after someone resumes them is
  the cron path's first live use on the door (Step 4 block proven via a terminal session).
- `quota-nudge` cron skill missing in Hermes (not ours).
- #55 follow-ups: production failure notice without the child's message; `scripts/produce-from-legacy.ts --run` runs
  without the host middleware; ffmpeg not bound to the door signal (#53).
- Not ours (carried): dotfiles architecture-check rows; agent-gateway dispatch-worktree credential test.

## Host state

Release `ddbf492` (host + audio), **host and audio on the team key** (`~/.config/agw/iu.env` present). Door tokens:
`hermes`, `iris`. Main checkout clean on master. Live worker tabs: `agent-workflows-triage` (running); done tabs to
clean: image, tts-stt, podcast-room, audio-process, audio-price-r1, podcast-produce (agent-workflows), dotfiles
img-switch, hermes-agent hermes-audio-switch.

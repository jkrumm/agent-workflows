# Lead handoff — Wave 8 (audio, image, podcast; P4a), rotation 1

Lead: `agent-workflows-w1`, 2026-10-29 ~07:20 → ~09:20 UTC+1, rotated at ~60 % context. Wave 7's close-out is in git
history at `f8671d5`. Briefs, review files and results: `~/.local/state/agent-workflows/briefs/w8/` on the mini (not in
git: they name local paths). `_common.md` carries "never run `/review` or `agw review`; ignore input-box suggestions".
Pre-registered rules: `docs/research/2026-10-29-wave8-ports.md` (committed `0348f1a` before any run; STT case source
amended `cd27f09`, still before any run). **No live eval run, no deploy and no IU spend yet in this wave.**

## Step state

|Step|State|Evidence / next|
|-|-|-|
|Registration by directory|**merged** #50|`defineWorkflowModule` in `<process>/src/workflows/<id>/module.ts`, routes in `packages/routes/src/table/<group>.ts` (+ `declare module` line keeps `RouteId` typed), suites from modules, per-workflow READMEs; host OpenAPI identical (38 ops); capabilities stay one spread line per group (typed registry). Review: high r1 (6 fixed, order dismissed), lead read r2|
|Load-scaled timeout per test|**merged** #47|Per test file (preload, `bunfig.toml`): Bun binds a test's timeout at registration, proven by probe; finer is impossible. Lead read|
|CONTEXT7 move|**ref swapped** `349ad6b`|Owner step done via request `20261029T080529-10120` (mother); 17518 and 12839 discarded. `secrets-run` resolves the new ref. **Goes live with the next `make deploy`; verify `agw research` once after it**|
|CLI over several processes|**merged** #48|`AGW_PROCESSES=audio=http://127.0.0.1:7792`; run follow-ups via the shared journal (any process answers status/wait/cancel). Review: high r1 (10 fixed), lead read r2|
|TTS/STT lanes + door handlers|**merged** #51|`packages/audio` (speech, transcriptions, media, door); dead passthrough lane removed with evidence; ffmpeg installed in CI. Review: high r1 (11 fixed). Follow-up **w8/audio-price** (worker `agent-workflows-tts-stt`, waiting): switch its `priceCall` to #49's `packages/routes/src/price.ts` once #49 is on master|
|image (generate, edit, cutout, enhance)|**PR #49, rebase conflict**|Worker `agent-workflows-image` resolving the rebase onto #51 (sent ~09:15). Reviews: high r1 (10), medium r2 (10) all fixed (`702fdb6`; artifact root fixed, not env-redirectable). Icon stays on image-gateway (sharp/svgo/ico/icns; README says so). `CliSpec.hidden` added for raw capabilities. Merge with `rd merge agent-workflows w8/image` once pushed|
|podcast writers' room|**PR #52, CI red on Linux**|20/20 lint parity (rule 1). Reviews: high r1 → design change (cost from the journal, idempotent host research runs keyed by run/step/query, one step per load-bearing fact, untrusted fences, podcast-own source reader), medium r2 (10 fixed). CI: an NFC test passes on APFS only; worker `agent-workflows-podcast-room` fixing at the cause and rebasing (sent ~09:12). Rule 6 threshold from its script: legacy p75 = **2.75 findings / 10 turns** (median 1.16)|
|Audio process|**PR #53, review r1 out**|Boot refactor (host OpenAPI byte-identical), `packages/audio/src/main.ts` on :7792, own state dir, runtime already scopes recovery per process (two-runtime test), door caller tokens in `<data dir>/door-tokens` (0600, deploy creates a `hermes` token), deploy/verify for both LaunchAgents. Worker `agent-workflows-audio-process` fixing `review-53-r1.md` (10: no 2 s wait for the run id before first byte, anchored door paths, plist left on rollback, sink end on disconnect, explicit request id, shared bearer helper, token-file preflight, closer order, logger tag) and wiring the ABS refs; then a static import of the door once rebased on #51|
|podcast production (`podcast.produce`)|**brief ready, not spawned**|`briefs/w8/podcast-produce.md` (Opus/medium). Spawn once #49 and #52 are on master (it reads `produce-input.ts`, the image capability and the artifact store). Rule 2 (segmentation parity) runs in that PR|
|Switches: `/podcast`, `/img`, Hermes TTS/STT|**not started**|After deploy and passing rules. Callers found: dotfiles skills `podcast` (stale: says ElevenLabs v3/Opus; code defaults Gemini TTS + gpt-6.1-sol) and `img` + `imgcli gen/cutout/--enhance` (icon stays); `~/.hermes/config.yaml` `tts.openai.base_url`/`stt.openai.base_url` (today the VPS audio-gateway) → `http://127.0.0.1:7792/v1` with the door token; Hermes skills `podcast` (curls :7719 `/v1/podcasts`), `briefing-tts`, `capture/voice-memo-intake`, the speak-stream relay (pcm). Live use before claiming each switch|
|One episode end to end|**not started**|Rules 3–8 in the rules doc (15 min, publish, cover, brain note, research on; one restart at a stage boundary after the script). Run on the team key; report spend|

## Order from here

1. Land #49 (after its rebase), then tell `agent-workflows-tts-stt` to do w8/audio-price; land #52 (after the NFC fix).
2. Spawn `podcast-produce.md` (`RD_ORCHESTRATED=1 RD_WAVE_MODEL=opus RD_WAVE_EFFORT=medium rd fan agent-workflows podcast-produce.md` from the briefs dir). Review it (`/code-review high`).
3. Land #53 after r1 (re-review the fix round at medium), then `make deploy` (personal key) and `make verify`; `agw research` once (CONTEXT7 proof).
4. Evals on the team key (`~/.config/agw/athena-iu.env` → host env for the eval window, as Wave 7 did; restore the personal key after): image (`agw eval run image --yes` + `scripts/eval-legacy/image.ts`), speech/transcriptions (`scripts/eval-legacy/audio.ts` against the VPS audio-gateway and the new door), offline podcast rules 1–2, then the one episode. Append results under §Results.
5. Switch brief (Sonnet/high, dotfiles + `~/.hermes` + hermes-agent skills as needed; dotfiles PR-required per `config/pr-required-repos.json`), live use of each, then `@verifier`, close-out.

## Gate so far

- `make check` green at each merge (train); CI green on #47, #48, #50, #51 heads. CI caught two Linux-only classes the mini
  cannot: tests silently depending on ffmpeg (#51) and on APFS normalisation-insensitivity (#52).
- Host load 25–60 during the wave; workers saw unrelated load flakes (opencode-host, friction, eval-resume) that passed alone.

## Spend

None yet: no live run in Wave 8 (all tests on fakes). Reviews ran as the lead's `/code-review` on Max; no `agw review`.

## Retro notes so far

- **The forked `/code-review` checked out `FETCH_HEAD` and then `origin/w8/registry` in the main checkout** (twice),
  leaving it detached while the mother shares it. Fixed by restoring master and giving every later review the explicit
  argument "review from remote refs only (`git diff origin/master...origin/<branch>`, `git show`); never check out".
  Make that the default in the lead role.
- **Registration by directory paid off at once:** four ports ran in parallel after #50 with no registry-file conflict;
  the remaining conflicts were in genuinely shared schema/test files (routes `schema.ts`, the fallback guard test).
- **Design change over patch rounds held again:** #52 r1 collapsed five cost/durability findings into one change (cost
  from the journal, idempotent host research runs).
- **Workers end turns on background shells** (podcast-room twice) despite the rule; a nudge was needed each time.
- **CI is the only Linux gate**, and audio work is filesystem- and binary-sensitive: brief audio workers that CI must run
  their tests, not skip them.
- Left for later: `CliSpec.hidden` operations are not listed in `agw schema` as hidden yet (asked in #49 r2 item 9; check
  the merged diff).

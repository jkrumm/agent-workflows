# Lead handoff — Wave 8 (audio, image, podcast; P4a): CLOSE-OUT

Leads: `agent-workflows-w1`, three occupants (rotation 1 at `2e513fc`, rotation 2 at `f25d98b`, rotation 3 closed the
wave 2026-10-29 ~15:20 UTC+1). Briefs and review notes: `~/.local/state/agent-workflows/briefs/w8/` on the mini (not in
git); `_common.md` carries "never `/review` or `agw review`", the parity-only direction and, since ~14:00, **no EU route
preference** (owner, standing). Rules and results: `docs/research/2026-10-29-wave8-ports.md`.

**Final state.** agent-workflows release `927dc85` on host + audio (team key in `~/.config/agw/iu.env`; deploys verified
on the personal key), `make verify` PASS. agent-gateway `fe14b53` deployed. dotfiles `28d9389`, hermes-agent `cd0a849`
on master. Main checkout clean on master.

## Per-step verdict

|Step|Verdict|Evidence|
|-|-|-|
|Registration by directory; load-scaled test timeout|**done**|#50, #47 (rotation 1)|
|CONTEXT7_API_KEY move|**done, live**|release `eb34895`; research run `01a186c9-29bb-…` cites context7 via `web_docs`|
|Audio process + OpenAI-compatible TTS/STT door|**done, live**|#53, #48, #51, #54 (pricing from the route table); speech 6/6, STT 4/4 rules PASS (release `ddbf492`); verifier: door 200 `audio/mpeg` as caller hermes (`01a187fd-b9d9-…`, `door.speech` done), 401 without token|
|`image` ported, `/img` switched|**done, live**|#49, rule run 2 PASS 4/4; dotfiles `88f5397`; live `imgcli gen` `01a186df-33c8-…`, `--private` `01a186df-4c96-…`. Icon build stays on image-gateway by design|
|`podcast` ported (room + `podcast.produce`)|**done, live**|#52, #55; rules 1 (lint 20/20) and 2 (segmentation 20/20) in their PRs. Episode 1 `01a1876d-0dc1-…` (release `53496a1`) FAILED rule 3 only: no brain note (the audio process read `BRAIN_DIR`, never set); 4–8 PASS incl. durability (audio process restarted 25 s after `script`, completed steps 1 attempt, 11 in-flight steps re-ran once). Fix #57 (`AGW_BRAIN_DIR` + default; Slack notice on `ARGO_URL`, `PODCAST_NOTIFY_CHANNEL=media`, which episode 1 also skipped). Episode-2 rule pre-registered (`f5843ff`) before the run; episode 2 `01a187ad-eed1-…` PASS 3–7 (−17.2 LUFS, ratio 0.05, lint 2.31/10, $0.107/min, brain note `4db60eb` on vault origin, Slack `sent: true`); `cf9b236`|
|`/podcast` switched|**done, live**|dotfiles `28d9389` (skill on `agw podcast` / `run wait` / `podcast-publish`; live by its documented command: `01a187c4-35c2-…` published, brain note pushed, $0.642). Hermes `cd0a849` (curl to :7719 → `agw` via terminal; live through Hermes itself: `01a187ca-a832-…` purpose prod, published, 3:38, $0.66, every field Hermes reported matches the run JSON). The lead caught both skills reading fields at the top level; the real shape is `output.*`, and the top-level `cost` is the parent run only|
|Hermes TTS/STT switched|**done, live**|hermes-agent `accd198` + `73cd54b`; proofs mp3 `01a1873c-2068-…`, pcm `01a1873c-24ec-…`, briefing lane `01a1873b-d510-…`, STT `01a1873c-2a8d-…`|
|Door serves iris; contract to iris-mother|**done**|iris caller token (door-tokens `iris=`), contract sent ~11:50 (rotation 2). argo moved to Wave 9 (mother)|
|`triage` ported, `decide` callable by iris|**done, live**|#56. triage on Haiku 5.5 (Bedrock); decide moved `pplx-decider-v1-27b` (Requesty hop, header-probed) → `decision-1-eu` (header "GDPR Sink Sweden Decisions API"). Cancel tested (fake slow provider, HTTP + `agw run cancel`); caller via `x-agw-purpose: iris`; `usage` in legacy names (`costUsd`). Live as iris: triage `01a18796-702f-…` $0.0002, decide `01a18796-7af5-…`. Contract sent to iris-mother (rd say, ~13:20). iris live since: 7 `cap.triage` + 11 `cap.decide` runs with purpose `iris`|
|Review OCR off by default (owner directive)|**done, live**|#58: `ocrSwitchOn` true only for `AGW_REVIEW_OCR=1`; `runOcr` re-checks the live env (r1: a stale journal or a resumed child could still run it). Live: review `01a187f9-23fd-…` ($0.045) plan `"ocr": "skipped: AGW_REVIEW_OCR=0"` at 105 changed lines, zero `review.ocr` runs after the deploy|
|agent-gateway review never on Max (a)|**done, live**|`53d7bcd`: review keys `fallback: null`, a `max` override refused (`NEVER_MAX_TOOLS`); the scope-mode `claudeSafeRoute` path (a checkout with its own opencode config → Sonnet on Max) is now refused up front. `/api/routing`: all 7 review keys `iu`, fallback null. agw review confirmed Max-free (every wire IU, `OPENCODE_DISABLE_CLAUDE_CODE=1`, no `claude -p`)|
|agent-gateway review refuses (b)|**done, live**|`fe14b53`, after iris switched (`e2b9ac3`) and with no agent-gateway review job after 07:29 today. `POST /api/jobs {tool: review}` → 400 "review moved to agent-workflows: run `agw review …`", job count 43 → 43; `agw-legacy review` prints the same|

## Reviews

All on Max (`/code-review high`, the lead): no gateway `/review`, no `agw review` by the fleet. Rotation 3: #56 r1 (no
correctness bugs; destination bound and surrogate-safe cut fixed; flat output, decide move, purpose attribution
accepted), #58 r1 (live-env check in `runOcr`, fixed in r2). #57, agent-gateway (a) and (b), and the two `/podcast`
switches: lead diff read only (≤ 40-line config/routing/skill changes, no new interface; field paths checked against a
real run). Rotations 1–2: 8 rounds (#49 ×2, #52 ×2, #53 ×3, #54 ×2, #55 ×2, #48, #50, #51).

## Gate

`make check` green at every merge (train). CI green on every merged head: #56 `7fcaf67` (attempt 3: two untouched-test
flakes, below), #57 `c657fdd`, #58 `04f88f6`; master head `927dc85` green. Docs-only `ddbf695` red on the same flake.

## Live proof (`@verifier`, release `927dc85`): 10/10 PASS

Health + sha = origin/master; triage `01a187fd-8a33-…` (span pair in ClickStack, Argo synced); decide `01a187fd-9259-…`
(`microsoft-decision-1`); iris attribution rows; audio door (hermes token 200, no token 401); three podcast runs done,
published, brain notes on vault origin, Slack sent; OCR skipped; callers switched (both podcast skills, Hermes TTS/STT
base_url, `imgcli` on `agw image`); agent-gateway review routes IU with no fallback; Argo sync + spans for the triage run.

## Spend

|Key / account|Purpose|What|USD|
|-|-|-|-|
|athena-team (IU)|eval|episodes 1 + 2 (rule)|3.65|
|athena-team (IU)|build / prod|`/podcast` proofs: dotfiles $0.642, Hermes $0.656|1.30|
|athena-team (IU)|build / verify|triage worker 2 live calls, my iris probes + 2 decision header probes, review proof $0.045, verifier 3 calls|≈ 0.05|
|athena-team (IU)|eval / build|rotation 2: image, speech, STT rules, switch proofs|≈ 0.55|
|personal (IU)|verify|`make verify` ×7 over the wave, CONTEXT7 proof|≈ 0.02|
|legacy arms|eval|rotation 2: image-gateway, audio-gateway (their own keys)|≈ 0.55|

Episodes by model (4 runs, $4.95): GPT-6.1 Sol (writers' room) $3.78, Gemini 3.8 Flash TTS $0.54, Gemini 3.8 Flash
(Vertex) $0.35, DeepSeek v4.1 Flash $0.23, gpt-image-2.5 (cover) $0.05. ElevenLabs: none (legacy's podcast synth is
Gemini too; the dotfiles skill's "ElevenLabs v3" was stale). Wave total ≈ $6.1 team key, ≈ $0.02 personal.

## Left behind

- **Review OCR: owner-gated re-enable.** Off unless `AGW_REVIEW_OCR=1` (#58); agent-gateway's `.env` keeps
  `AGENT_GATEWAY_REVIEW_OCR=0`.
- **Judge calibration shift:** `decide` moved to `decision-1-eu`; it is also the judge for the research, otel and brain
  scorers and the eval `agwJudge`, so their verdicts and baselines shift. No re-tuning (parity only).
- **Requesty hops still live (Wave 9 route sweep, with no EU preference):** `review.router`, `review.adversary`,
  `review.ocr` and `cheap.classify` on `deepseek-v4.1-flash`; the EU-pinned ids get re-pointed in the same sweep.
- **Caller identity on the host** is `x-agw-purpose` only (iris = purpose `iris`, outside the prod follow-up/drift
  samples); a per-caller bearer → caller column is a host change not built.
- **agent-gateway:** the eval harness's legacy review arm is now refused at submit (never run; P6 deletes it); its
  refusal message lacks the `<tool> refused:` prefix the other refusals carry.
- **CI flakes in untouched tests** (both cost a rerun): `runtime/test/review.test.ts` lease grace (947 < 950 ms, a
  Postgres-vs-`Date.now()` clock comparison with 50 ms slack) and `runtime/test/middleware.test.ts` "a throwing toolPre"
  (`s.sleep(30)` as synchronisation, red on CI twice).
- **Hermes podcast behaviour:** it does not reply right after submit and runs its own `agw run wait` loop; result correct.
- **Host log:** periodic "opencode session lookup failed; pruning skipped this tick" (`OpenCodeUnreachable` /
  `OpenCodeHttpError`) and telemetry `eventCountLimit` drops; no run failed from them.
- **Fan tabs `rd close` refuses** (fan, not wave tabs): `dotfiles-podcast-switch`, `hermes-agent-podcast-switch`,
  `agent-gateway-review-nomax` (fresh), `agent-workflows-audio-price-r1` (pushed as `w8/audio-price`); `rd reap` takes them.
- From rotation 2: argo audio proxy → Wave 9; Hermes briefing cron jobs paused since 2026-10-26 (not by us); Hermes
  `quota-nudge` cron skill missing (not ours); #55 follow-ups (failure notice without the child's message,
  `produce-from-legacy.ts --run` without the host middleware, ffmpeg not bound to the door signal).
- `podcast/show-bible.md` names `PODCAST_SHOW_BIBLE` / `PODCAST_VOICE_PATH`, which nothing reads.
- Not ours (carried): dotfiles architecture-check rows; agent-gateway dispatch-worktree / credential-helper test (red on
  any host with `credential.helper osxkeychain`).

## Retro notes

Rotation 3:
- **A pre-registered rule caught a config gap no test could:** both env misses (`BRAIN_DIR`, notify) were silent
  best-effort skips that every unit test passed. Rule 3 named "brain note pushed", so the episode failed loudly, and the
  second-episode rule was written before the rerun. Best-effort steps need a live criterion.
- **Port the env by name:** the produce child kept legacy env names (`BRAIN_DIR`, `ARGO_BASE_URL`) the platform never
  sets. A port brief should require a sweep of the legacy launch env against the new process env.
- **`/code-review` forked into the main checkout again** (checked out `origin/w8/triage` detached, under the mother). A
  detached worktree under `.claude/worktrees/` plus an explicit "never check out" in the args worked for both later
  reviews. Make that worktree the lead role's default for `/code-review`.
- **A doc or brief that describes a JSON shape must be checked against a real run:** both `/podcast` skills read fields at
  the top level; one `jq` against a done run fixed it before any live use.
- **Owner directives mid-wave landed cleanly as one small change each** (OCR off, review off Max, the refusal), each
  with a live probe as its proof. A header probe settled "is it Requesty?" in one call.
- **`rd say` to a busy agent queues**; the mother saw updates late. Status for the mother belongs in short,
  self-contained messages.

Rotation 2 (from `f25d98b`): eval harnesses need the same first-run doubt as eval sets ("both arms fail alike" is a
harness signature); ask for the cases file's line count; a worker near its context limit hands over instead of starting a
design round; reviewer claims about legacy need the rules doc first; workers' live state outside the repo is where
switches bite; `rd fan` refuses an existing branch (new branch, push `HEAD:<old>` with a lease); `rd say` to a blocked
tab fails.

Rotation 1 (from `2e513fc`): the forked `/code-review` checked out refs in the main checkout (twice); registration by
directory paid off at once (four parallel ports, no registry conflicts); design change over patch rounds held (#52);
workers end turns on background shells; CI is the only Linux gate, so audio workers must run their tests there.

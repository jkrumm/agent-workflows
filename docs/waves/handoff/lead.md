# Lead handoff — Wave 15 (Coverage and debt): CLOSE-OUT

Lead `agent-workflows-w1-r15`, spawned by mother `agent-workflows-w1-r4`, 2026-11-03 03:29 → 07:45 CET. Wave 8's
close-out is in git at `0826cf4`.

**Live:** release `b2701de`, `make verify` PASS (also PASS at `0a43be6`, `789985c`, `740cddb`). Gateway build unchanged
(`054f2af17eb336d2`), not restarted.

## Delivered

| Item | PR | What |
|-|-|-|
| Daily mining job | #126 | `agw eval mine review --auto`: N = min(90 % of the gateway's eval credit / credit per candidate, IU headroom / (1.25 × IU per record), 150 per run); IU eval spend on the personal key since 2026-11-03T00:00Z under $20 − $0.75 margin; past runs with unpriced or missing usage rows are left out of the per-candidate history; the run record carries `output.auto` (state, target, bug cases before/after, credit, IU total, planned). `scripts/eval-mine-daily.sh` under LaunchAgent `com.jkrumm.agent-workflows-eval-mine` (04:30 daily, `make eval-mine-job`, runs the `current` release's script): per-UTC-day idempotency key (a second trigger adopts the run), bounded wait, one log line per night in `~/Library/Logs/agent-workflows-eval-mine.log`, removes itself at `target-reached`. **Installed.** |
| Labeller c's re-asks | #126 | Gemini got `json_object` and failed the schema 3 of 3 times (one re-ask every call); now strict `json_schema` for `gemini-3.8-flash` only (an anchored regex, the routes guard forbids the literal). Live: 1 Gemini call per c ask (was 2). |
| Compaction overflow | #128 | OpenCode 2.0.32 caps the summary at min(limit.output, 32k, window − request); `compaction.buffer` 40k (server-wide) gives bounded rows the full 32k; a compaction failure restarts once on the route's fallback only when every tool call of the turn was read-only (`read`, `glob`, `grep`, `skill`, from 2.0.32's source), otherwise fails with its usage kept; an unrecognised compaction error warns once. All `CONTEXT_LIMITS` rows stay served (arms). |
| Eval suites, text | #129 | overview (6), narrative (6), prose-polish (8), retrospective (5): committed synthetic cases, deterministic versioned scorers, eval-only `fixture` inputs refused unless purpose is `eval`. Registry: a module that built nothing on a host may still declare its suite. |
| Eval suites, media | #130 | image-icon (6), podcast (5), speech-roundtrip (6; a new audio eval workflow: TTS then STT, WER scorer). An eval podcast posts no Slack notice and files no brain note. |
| Audio suites in the host's eval | #131 | `RuntimeOptions.foreign`: the host starts and scores audio workflows but never claims, leases, recovers or drives them; shared shells (`satisfies`, test that served = shell + run/concurrency); a never-claimed case errors after 10 min; version skew is a case error; a broken or missing audio tree logs and never aborts host boot. |
| Test fakes | #132 | `@agent-workflows/testing` (private, devDependency only): one fake gateway (the two merged), transports, image server, agent host, fake OpenCode server/bin, platform, Postgres support. The `./testing` exports of capabilities, audio and runtime are gone. Same totals before and after (4153 pass, 55 skip). |
| Dead code | #128 | `IU_ANTHROPIC_BASE` was already gone (681e942); no provably unused Claude leftovers (the Opus row stays for arms). |
| Docs | #127 | concept.md v3.15 (eight drifted notes brought to the code, past version notes untouched) plus a retro line; routes/otel/brain READMEs. |
| Small Wave 8 items | #127, #126 | `overview.classify` prompt rewritten to the factory's facts; labeller c (above); flaky ocr env test: a mkdtemp path spelled `test-key`, secrets now random per run. |

Reviews: `agw review` on every PR, `/code-review high` (Max) on #128 and #131. Blocking findings fixed before merge:
#126 per-payer denominators, unpriced rows read as $0 (twice); #128 a compaction restart re-running writes; #129 a
hand-passed fixture landing in the `agw agents` cache, a weak path-leak check; #130 NaN recursion in the WER scorer;
#131 a silently dropped suite; #132 the fake gateway's 404 before recording. Merged by the train on a local `make
check` and green CI each.

## Proofs (live)

- Mining job under launchd (`launchctl kickstart`, 05:18): `bug cases 46/200 (dev 10, test 36); labelled 6, accepted
  +3; credit available 0.325, run cost 0.448; IU eval 2.747 of 20; state labelled` — run `01a19f9e-d1d3`, purpose
  eval; usage rows: credit `me` $0.326 (Sonnet), IU $0.122 (Terra 6, Gemini 1).
- Suites (purpose eval, production seats):

| Suite | Cases | Pass | Cost | Note |
|-|-|-|-|-|
| overview | 6 | 6 | $0.003 | |
| narrative | 6 | 5 | $0.101 | one narrative describes a removed mechanism as current (a real miss) |
| retrospective | 5 | 3 | $0.061 | the 2 misses are gateway refusals (no eval credit), not answers |
| image-icon | 6 | 6 | $0.054 | |
| speech-roundtrip | 6 | 6 | $0.006 | WER 0; run by the audio process through the host's eval (#131 end to end) |
| prose-polish | 8 | not run | est. $0.31 | eval credit |
| podcast | 5 | not run | ≈ $0.9 a run (history) | eval credit |

## Spend (this lead)

Eval: suites $0.23; mining proof $0.45 (credit $0.33, IU $0.12); worker's Gemini probe $0.05 IU. IU eval total on the
line: $2.87 of $20. Reviews (production): ≈ $1.6 credit.

## Left behind

- **First step of the next wave, once eval credit allows** (`evalAvailableUsd` on `/health`, `me` accrues ≈ $3.2/day
  and the 04:30 job takes 90 % of it): `agw eval run prose-polish --yes`; `agw eval run retrospective --ids <the two
  refused> --yes` (any eval run after 05:30 CET today shows them: the case runs failed with `eval reserve`);
  `agw eval run podcast --ids <one> --yes`. Calibrate the podcast duration band (0.6–1.5 of `minutes`, a guess) on
  that run and bump the scorer version with it.
- `agw eval run` scores a failed case run (here a 403 credit refusal) as zeros instead of an error: misleading pass
  rates. Should be a case error.
- Mining: ≈ 6 candidates a night at today's leftovers; ≈ 50–70 on a full day of accrual (≈ 10–17 cases). 154 bug
  cases to go; `me2` (+$100) is the lever.
- Compaction: a compaction fallback is labelled `routeFallback: unknown` like a refusal (the gateway's
  `routeFallbackOf` in `packages/gateway/src/proxy.ts` must accept `compaction`; then one line in `waitOnFallback`).
  Follow-up turns (`waitTurn`) get no fallback. Unbounded Claude rows are covered only by the read-only restart; no
  live compaction failure was reproduced (tests and the real binary's request size only).
- Labeller c's records are not split by wire format (`LABELER_C_VERSION` unchanged); the Gemini json_schema regex wants
  a route flag instead.
- Host boot imports the audio tree's `module.ts` graph to read suites (failures log, never abort).
- `fakeWeb`, audio's test helpers and single-package fakes stay in their packages (typed on unexported ports).

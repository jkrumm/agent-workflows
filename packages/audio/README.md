# @agent-workflows/audio

The TTS and STT lanes of audio-gateway, ported as a library, and the two OpenAI-compatible door handlers Hermes
reaches them through (concept §8, §10). The audio process mounts the handlers and wires the usage port to its run
record; the podcast's production stage calls the synth functions in-process. No HTTP server, no boot, no workflow
here. Behaviour is legacy's (audio-gateway `568c281`); the decisions that differ are listed below with their reason.

## The door

```ts
import { audioConfig, createSpeechHandler, createTranscriptionsHandler } from '@agent-workflows/audio'

const deps = { config: audioConfig(process.env), usage: { record: (event) => runs.book(event) } }
const speech = createSpeechHandler(deps) // POST …/audio/speech
const transcriptions = createTranscriptionsHandler(deps) // POST …/audio/transcriptions
```

Each handler is `(req: Request) => Promise<Response>`, OpenAI-compatible request and response exactly as legacy:
status codes, `{ error: { message, type } }` bodies (`invalid_request_error` 400/413, `proxy_error` 500/502,
`upstream_error` for an empty-bodied upstream 5xx), `X-Audio-Title` (URI-encoded), `content-type` per format. Auth,
routing by path, `/health` and `/models` are the process's.

`AudioDeps`:

| Field | Meaning |
|-|-|
| `config` | `audioConfig(env)`: transports from `IU_API_KEY` and `IU_BASE_URL` (`…/anthropic`; OpenAI, Gemini and Replicate bases derived from the same root), tuning knobs under legacy's env names |
| `usage` | the usage port: `record(event)`, may be async or throw; never awaited, failures logged |
| `clock?` | `{ now, sleep }`; tests pass an instant one |
| `fetch?` | the upstream transport |
| `media?` | the ffmpeg/ffprobe boundary (`MediaPort`); default spawns the host binaries |
| `env?` | where `AGW_ROUTES` overrides are read, once per handler or scope; default `process.env` |
| `log?` | `{ info, warn, error }(message, fields)`; default JSON lines on the console |
| `requestId?(req)` | the id stamped on every event of one request; default a UUID |
| `caller?(req)` | the caller when `x-audio-source` is absent (e.g. a mapped bearer token); default `unknown` |

### Usage port

`record` gets two kinds of event, both carrying `requestId`, `caller`, `routeId`, `model`, `status`, `latencyMs`,
`units` (`tokens` / `characters` / `audio-seconds`), `quantity`, `costUsd`, `costSource`
(`rate` / `provider` / `not-billed` / `unknown`), `priceVerified` and `errorText`:

- `kind: 'call'`: once per billed upstream call, failed attempts included, right after the call (endpoint `speech`,
  `speech-prep`, `speech-summary` or `transcriptions`; plus tokens, audio seconds, characters, bytes).
- `kind: 'request'`: once per door request when its response is decided; for a pcm stream, when the body ended or
  aborted. Costs are the sum of the request's calls; `unpricedCalls` counts calls without a price (the summary is then
  `unknown`, never an undercount). Also mode, lane, chunks, language, voice, title, audio seconds, bytes, retries.

The first audio byte never waits on the port: events are fire-and-forget, and a streamed chunk's event is recorded
when that chunk ends.

## Lanes

- **Gemini** (wire `iu-gemini`): the chat model is one raw `generateContent` call (deterministic cleanup, allowlisted
  inline tags kept, a caller `delivery` or string `style` from the shared vocabulary, anything else a 400); prep
  models (`TTS_GEMINI_PREP_MODELS`, default the routes flagged `prep`) run the prep LLM first (per-chunk `delivery`,
  tag band, title). `response_format: pcm` streams `streamGenerateContent?alt=sse`: sample-aligned passthrough, the
  400 ms join, billed from duration × 25 tokens/s. The contract: a failure before the first byte is a normal HTTP
  error, one after it errors the body (a transfer error, never a clean EOF). Request shapes and traps: modelpick
  `docs/gemini-tts.md`.
- **Replicate / ElevenLabs** (wire `iu-replicate`): create, poll, fetch the `replicate.delivery` MP3 (no other host);
  prep only for prep models or `summarize`; whole-file requests with long text on a prep-off model get the spoken
  summary (`TTS_AUTO_SUMMARIZE_MIN_CHARS`); `previous_text`/`next_text` only where the route allows continuity.
- **Transcriptions** (wire `iu-openai`, `/audio/transcriptions`): an upload over the byte or duration limit is compressed to 16 kHz mono mp3
  and, if still too big or too long, sliced at silence-snapped cuts (`-t` always passed) and transcribed
  `STT_CHUNK_CONCURRENCY` wide; a part that hits a 404/5xx retries alone on its route's `fallback` (voxtral →
  `audio.stt.openai` → `audio.stt.openai-legacy`, i.e. the OpenAI transcribe model, then Whisper). verbose_json/srt/vtt
  are synthesized for json-only models and every joined transcript; Whisper's own rich formats pass through raw. An echoed `STT_PROMPT` is stripped.

## For the podcast's production stage

```ts
const scope = createAudioScope(deps, { requestId: runId, caller: 'podcast' })
await synthMultiSpeaker(scope, { routeId: 'audio.tts.gemini-flash', voices, parts }) // { pcm, sampleRate }
await synthReplicateChunk(scope, { routeId: 'audio.tts.elevenlabs-v3', text, voice, languageCode, stability, style, similarityBoost, previousText?, nextText?, speed? })
```

Each call is priced and recorded on `scope` like a door call; `ReplicateSynthError` marks an ElevenLabs failure.
`DELIVERY_STYLES`, `SPEECH_TAGS`, `endsOnQuestion`, `synthConcurrent` and `concatPcm` are exported for the stage.

## Routes and prices

The routes are a group of the route table, `packages/routes/src/table/audio.ts`: one per model the door accepts, plus
the prep (`audio.tts.prep`, effort `low`) and summary (`audio.tts.summary`) LLMs, with wire (`iu-gemini`,
`iu-replicate`, `iu-openai`), model and price: a token `rate` (Gemini TTS, prep, summary), or a `price` from
`packages/routes/src/price.ts` (ElevenLabs per 1k characters, STT per minute as `second` units with `per: 60`, the 4o
transcribe models as `audio-tokens`). `AGW_ROUTES` overrides any of it. `src/routes.ts` adds, keyed by route id and
naming no model or price, what only the lanes read (lane, prep, continuity, STT fallback chain, envelope synthesis,
`context_bias`) and `priceVerified`, the one stamp the table has no field for. `priceCall` (`src/usage.ts`) feeds each
call's measure to the table's pricing. STT route ids name the provider, not the model (`audio.stt.openai`, ...): the
routes guard matches model ids as tokens.

## Decisions (differences from legacy, with the reason)

- **Model choice is the route table's.** A requested model is honoured only when a route serves it on the lane's wire;
  anything else lands on the default route. Legacy also accepted any `/gemini.*tts/` id and any Replicate `owner/name`
  id. Evidence that the table covers what callers send: audio-gateway's VPS usage ledger, 2026-09-29 to 2026-10-29,
  holds exactly the TTS models `gemini-3.8-flash-lite-tts`, `gemini-3.8-flash-tts`, `elevenlabs/flash-v2.5`,
  `elevenlabs/v3`, and the STT models voxtral-mini, gpt-transcribe, gpt-4o-transcribe and whisper, all routes here;
  the one other id, `gemini-3.1-flash-tts-preview` (shut down 2026-11-17), came only from `verify` callers and now
  lands on the default. Argo sends no model. The door never reaches an unpriced model.
- **`TTS_MODEL`, `STT_MODEL`, `TTS_PREP_MODEL`, `TTS_SUMMARY_MODEL` and `TTS_PREP_EFFORT` are gone, not carried over.**
  The default TTS and STT models (`AUDIO_DEFAULT_ROUTES`), the prep and summary models and the prep effort are route
  entries; changing one is a route override.
- **No passthrough lane.** Legacy's IU `/audio/speech` proxy was reachable only when `TTS_MODEL` named a non-Gemini,
  non-Replicate model; no caller does, so the lane and its code are gone.
- **Billed means recorded, failure or not.** A failed upstream call is `not-billed` at 0. A call the provider billed is
  recorded with its quantity even when we fail after it: an ElevenLabs prediction that succeeded is billed by its
  characters when the delivery fetch or decode fails; a 2xx STT reply we cannot read is recorded (priced from the
  duration we measured, else `unknown`) and answered 502, never retried on the fallback; a 2xx Gemini reply without
  audio records its `usageMetadata`; a streamed chunk cut off after audio arrived is billed for what it delivered, and
  each streamed call carries its prompt tokens. A probed duration of 0 is a failed probe, never a free call.
- **A client that leaves a pcm stream aborts the upstream read**, so Gemini stops generating.
- **The ElevenLabs delivery fetch** refuses redirects (the `replicate.delivery` allowlist cannot be left), has a 2-minute
  hang guard and a 50 MiB cap; the prediction id is URL-encoded.
- **The prep LLM's own `usage.cost` wins** over the rate when IU sends one (the platform rule in `packages/routes`).
- **A sliced part without a duration in its reply is priced from its cut length**, where legacy left it unpriced.
- **No spans.** Legacy's OTel spans become the run record the process books from the usage port.

## Token effect / cache effect

Prep and summary are single chat completions with a fixed system prompt and the input as the user turn: the system
prompt is a stable prefix, so a provider-side prompt cache can hit across requests; nothing here sends cache control.
TTS and STT calls are not token-cached. Streamed Gemini usage is wrong upstream (1 token), so streamed audio is billed
from its duration.

## Eval

The speech and transcriptions suites were run against both arms and scored per
`docs/research/2026-10-29-wave8-ports.md` §speech and §transcriptions; the comparison script is deleted with
audio-gateway (Wave 11). N's cost is read from the run record named by
the response header `agw-run-id`, so the process must send it on both door routes.

## Process

The audio pipeline runs in a platform process of its own beside the host (concept §8): `src/main.ts`, LaunchAgent
`com.jkrumm.agent-workflows-audio`, `127.0.0.1:7792` (`AGW_AUDIO_PORT`), started by `scripts/launch.sh audio` from the
same release as the host (deploy and rollback: `packages/host/README.md` §Deploy).

It boots through the host's `bootProcess` (`packages/host/src/boot.ts`), the code the host itself boots with, from a
`ProcessDefinition` (`src/process/index.ts`): the same journal and platform middleware (run record, fingerprint,
telemetry as `service.name` `agw-audio`, the Argo outbox), the runaway cap and the wallet gate, the same bearer
(`AGW_API_SECRET`) on the API, the same OpenAPI with `x-cli`, `/health` with the version. What differs:

| | host | audio |
|-|-|-|
| Workflows | `packages/host/src/workflows/*/module.ts` | `src/workflows/*/module.ts` (`discoverWorkflowModules`) plus the two door workflows; module deps add `journal` (read pool, schema) and `audio` (the door's config, media port and env, which `podcast.produce` synthesizes on) |
| Capabilities over HTTP | yes (`agw llm title …`) | no: the CLI refuses a command two processes declare; workflows still call every capability in-process |
| State dir (tool gate, OpenCode) | `~/.local/state/agent-workflows` | `~/.local/state/agent-workflows-audio` (`AGW_AUDIO_STATE_DIR`): two tool gates never share one `gate.json` |
| OpenCode agent host | lazy | lazy: none of its workflows has an agent step, so `opencode` is never spawned |
| Jobs | retrospective, eval and drift, friction | none |

`agw` reaches it through `AGW_PROCESSES=audio=http://127.0.0.1:7792` in `~/.config/agw/env` (written by `make deploy`;
`packages/cli/README.md` §Platform processes).

### `agw audio ping`

`src/workflows/ping/`: one code step, no model, no cost. `make verify` runs it to prove the process records a run end to
end through `agw`.

### Two processes, one journal

Recovery, leases, post-hook redelivery and drift sampling only ever touch runs of the workflows a runtime was given
(`Journal.claimable`, `postHooksPending`, `driftCandidates` filter by them), so no runtime change was needed.
`packages/runtime/test/processes.test.ts` proves it with two runtimes on one schema and disjoint workflow sets: with
one process down, its running run (mid-step), its pending run and its run with an undelivered post hook are left
exactly as they were by the other one's recovery passes (no claim, no drive, no hook), and the restarted process
finishes all three. The Argo outbox claims its rows (`for update skip locked`, a claim token), so processes flushing one
journal post each row once (middleware `outbox.test.ts`, two flushers racing). The friction job and the retrospective
run in the host only.

### Env

`.env.tpl` is shared by both processes (each fail-closed on all of it). The audio process reads `IU_API_KEY` and
`IU_BASE_URL` (the lanes derive the OpenAI, Gemini and Replicate bases from it), `STT_PROMPT` (a plain value, as
audio-gateway set it) and `ABS_URL` / `ABS_API_KEY` (Audiobookshelf, the podcast's publish stage).

## The door on the process

`POST /v1/audio/speech` and `POST /v1/audio/transcriptions`, and the same paths without `/v1` (OpenAI clients with
either base form). Exactly these: audio-gateway matched any suffix, but the door is served ahead of the API, so an
unanchored match would take over a workflow path such as `/workflows/audio/speech`. The handlers are
`createSpeechHandler(deps)` and `createTranscriptionsHandler(deps)` of `src/door/`; the process builds one per request
(`src/process/door.ts`) with the request's usage port, id and caller passed in explicitly. `GET /v1/models` is not served:
Hermes' stock OpenAI TTS and STT clients never call it.

### Caller auth

The process binds 127.0.0.1, so a caller is a process on this machine. It presents `Authorization: Bearer <token>`
from the caller-token file `~/.agent-workflows/data/door-tokens` (`AGW_DOOR_TOKENS`): `name=token` lines, a regular
file of the user at mode 0600, names `[a-z][a-z0-9-]*`, tokens at least 32 characters and distinct. `make deploy`
creates it with one `hermes` token if it is missing and never touches an existing one. The platform's API secret is
accepted too, as the caller `agw` (`make verify`, the eval harness): it already grants the whole API. A missing,
wider-mode or malformed file refuses the start, naming the file and the line, never a token. Every known bearer is
compared hashed and in constant time (`bearerCaller`, the host's own `auth.ts`). `make deploy` checks the file
with the same parser before it stops anything, so a bad file refuses the deploy instead of rolling it back. Rotation: edit the file, restart the LaunchAgent.

Decision: a local token file, not a 1Password item. A new ref before its item exists breaks every reseal of the
headless cache, and a token that only grants a loopback port on this machine gains nothing from a vault.

Without a valid bearer: 401 `{"error":{"message":"unauthorized","type":"invalid_request_error"}}`, audio-gateway's
answer, with `WWW-Authenticate: Bearer`. While the runtime is not open: 503 `proxy_error`.

### One run per request

Every door request is a run of its own, `door.speech` or `door.transcriptions` (concept N6, the pattern of the host's
`capability-runs.ts`), purpose from `x-agw-purpose` (default `prod`), `traceparent` honoured, `Idempotency-Key` ignored
(it would fold two real requests into one record). Its input is the authenticated caller (the token's name), the
`x-audio-source` label when sent, the path and the request id; its output the status, route, served and requested
model, cost (only when every call is priced) and the call count. The step's usage is one `addUsage` per billed
upstream call, failed attempts at 0, so the run record carries the cost like any run.

The run observes, it never gates:

- Its id is chosen by the door before the handler runs (a UUIDv7, `StartOptions.runId`) and is also the request id
  every usage event carries; `agw-run-id` goes out with the response at once, the 500 path included. The run is
  started in the background: no response, and no first byte, waits on the journal.
- The handler's events land in an in-memory sink under that id; an event under any other id is dropped (logged),
  never put on this run. The record lasts as long as the handler's work: until its promise settled and its body
  ended, failed or was cancelled, then up to 2 s more for a `request` summary not yet in (a pcm stream records it as
  its body ends). At the latest one hour after the request arrived it ends anyway. The output's `ended` says why:
  `done`, `client-gone` (the client had gone away) or `bound`.
- The client going away does not end the record: it aborts the handler's upstream calls (every handler gets a
  `fetch` bound to `request.signal`), and a call billed on the way out is still recorded.
- A handler that cannot even be built is answered like one that threw: 500 `proxy_error`, with `agw-run-id`, and
  its record closes at once.
- A start that fails (a bad purpose header, the journal down) is logged as `door request not recorded` with the run
  id; the request is answered as if nothing happened, and its `agw-run-id` then names no run (a lookup is a
  not-found; the log line says why).
- A request cut by a restart: the next process resumes its run, finds no sink and fails it as lost; it never hangs.

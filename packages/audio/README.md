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
| `routes?` | the route table; default the pending audio routes |
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

- **Gemini** (`iu-gemini-tts`): the chat model is one raw `generateContent` call (deterministic cleanup, allowlisted
  inline tags kept, a caller `delivery` or string `style` from the shared vocabulary, anything else a 400); prep
  models (`TTS_GEMINI_PREP_MODELS`, default the routes flagged `prep`) run the prep LLM first (per-chunk `delivery`,
  tag band, title). `response_format: pcm` streams `streamGenerateContent?alt=sse`: sample-aligned passthrough, the
  400 ms join, billed from duration × 25 tokens/s. The contract: a failure before the first byte is a normal HTTP
  error, one after it errors the body (a transfer error, never a clean EOF). Request shapes and traps: modelpick
  `docs/gemini-tts.md`.
- **Replicate / ElevenLabs** (`iu-replicate-tts`): create, poll, fetch the `replicate.delivery` MP3 (no other host);
  prep only for prep models or `summarize`; whole-file requests with long text on a prep-off model get the spoken
  summary (`TTS_AUTO_SUMMARIZE_MIN_CHARS`); `previous_text`/`next_text` only where the route allows continuity.
- **Transcriptions** (`iu-openai-stt`): an upload over the byte or duration limit is compressed to 16 kHz mono mp3
  and, if still too big or too long, sliced at silence-snapped cuts (`-t` always passed) and transcribed
  `STT_CHUNK_CONCURRENCY` wide; a part that hits a 404/5xx retries alone on its route's `fallback` (voxtral →
  gpt-transcribe → whisper). verbose_json/srt/vtt are synthesized for json-only models and every joined transcript;
  whisper's own rich formats pass through raw. An echoed `STT_PROMPT` is stripped.

## For the podcast's production stage

```ts
const scope = createAudioScope(deps, { requestId: runId, caller: 'podcast' })
await synthMultiSpeaker(scope, { routeId: 'audio.tts.gemini-flash', voices, parts }) // { pcm, sampleRate }
await synthReplicateChunk(scope, { routeId: 'audio.tts.elevenlabs-v3', text, voice, languageCode, stability, style, similarityBoost, previousText?, nextText?, speed? })
```

Each call is priced and recorded on `scope` like a door call; `ReplicateSynthError` marks an ElevenLabs failure.
`DELIVERY_STYLES`, `SPEECH_TAGS`, `endsOnQuestion`, `synthConcurrent` and `concatPcm` are exported for the stage.

## Routes and prices

`src/routes.pending.ts` is the only file here that names a model id: one route per model the door accepts, plus the
prep (`audio.tts.prep`, effort `low`) and summary (`audio.tts.summary`) LLMs. It moves into `packages/routes` once the
registry split lands. Prices are legacy's `RATES` with their verified/assumed stamps; the non-token shapes (per 1k
characters, per minute) live behind one function, `priceCall`, so the general price shape is a one-place swap.

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

`scripts/eval-legacy/audio.ts` runs the speech and transcriptions suites against both arms and scores them per
`docs/research/2026-10-29-wave8-ports.md` §speech and §transcriptions. N's cost is read from the run record named by
the response header `agw-run-id`, so the process must send it on both door routes.

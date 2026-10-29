# podcast.produce

The writers' room's locked script to a published episode: synth, master, cover, publish, brain note, the Slack notice.
An **internal** child of `podcast` (`ctx.workflow('produce', …)` in `../podcast/index.ts`, step 11): registered with the
runtime, never an HTTP route or a CLI command. Its input contract is `../podcast/produce-input.ts`. Legacy (frozen):
`~/SourceRoot/audio-gateway` — `src/podcasts.ts` from `runPodcastPipeline` step 4 on, `publishEpisode`,
`runPublishStage`, the Slack notice; `src/podcast-synth.ts`, `src/podcast-mux.ts`, `src/cover.ts`,
`src/audiobookshelf.ts`, `src/brain-note.ts`.

The module (`module.ts`) also registers **`podcast-publish`** (`agw podcast-publish <runId>`), legacy's
`POST /v1/podcasts/:id/publish`.

## Steps

Step ids are literals (concept §3; `packages/runtime/test/step-id-literal.test.ts` refuses even an indexed template).
The synth fan-out is therefore `ctx.workflow('synth', …)`: one internal `podcast.produce.unit` child run per unit
(`unit.ts`, its one step `synth`), the concept's fan-out. The children run in-process together; a limiter per process
holds their TTS requests to `TTS_CONCURRENCY`, as legacy's `synthConcurrent` did.

| Step | Kind | Failure | What |
|-|-|-|-|
| `plan` | code | fatal | turns (`turnsForSynthesis`: host voice, dense-turn pacing, delivery style per turn), units (`unitsForMultiSpeaker` ≤ `PODCAST_MULTISPEAKER_MAX_CHARS`, never across a segment; one per turn on the ElevenLabs lane), the segmentation lint, the track number, the date, the Audiobookshelf file name. Fixed for the run |
| `synth` | workflow | fatal | one `podcast.produce.unit` child per unit: one TTS request on a priced audio scope (`synthMultiSpeaker`, or `synthReplicateChunk` per turn), legacy's retry-once rules, the PCM stored in the artifact store before the child's step ends. A failed child fails the run |
| `cover` | code | best-effort | `image.generate` in-process, 1024², medium quality; runs beside the synth fan-out. Null without the capability, when not requested, or on failure |
| `master` | code | fatal | per-host loudness to −20 LUFS (a multi-speaker unit levels as one `AB` group), gapped concat (380 ms, 160 ms before a ≤ 6-word interjection), one chapter per segment, `loudnorm I=-16:TP=-1.5:LRA=11`, ID3v2.3 with the cover, 44.1 kHz mono MP3 |
| `publish` | effect | best-effort | Audiobookshelf upload → scan → poll → patch. Never fails the run: `publish {requested, ok, error}`, `abs` null on failure |
| `notify` | effect | best-effort | the Slack line via Argo, only with `PODCAST_NOTIFY_CHANNEL` set |
| `brain-note` | effect | best-effort | `Areas/Podcasts/<date> <title>.md` and the regenerated `Podcasts.md`, `git add`/`commit`/`push` in `AGW_BRAIN_DIR` under the brain-sync lock |
| `cost` | code | fatal | this run's spend (its steps and its unit children's) as the journal recorded it |

Output: `{ mp3Path, coverPath, durationSeconds, turns, chapters [{title, startMs}], abs, publish, brainNote,
segmentation, cost {usd, unpriced, complete} }`. The room reads `durationSeconds` and `chapters`. Legacy's names where it
had them (`abs.libraryItemId`, `publish.ok/error`, `brainNote.committed/pushed`, `profile.segmentation`).

## Durability

- **Audio lives in the artifact store, the journal holds paths and hashes.** `<state dir>/artifacts/podcast/<episode
  id>/` (`packages/host/src/artifacts.ts`; the episode id is the `podcast` run id): `units/<n>-<request hash>.pcm` plus
  a `.json` sidecar per unit, `cover.png`, `episode.mp3`. A file is written to a temp name and renamed; a unit's sidecar
  is written after its PCM, so a sidecar means whole audio.
- **A restart mid-synth resumes at the first unfinished unit.** Done unit children replay from the journal (no
  request, no bill). The child that was in flight runs its step again; if its audio reached the store before the
  process died (sidecar present, sha256 equal, same request hash: the lane and its route, the speaker pair, the unit's
  turns), it is reused, not synthesized again, and the step records `reused: true`.
- **A reused file keeps its cost.** The sidecar records what the call reported (`usage`) and which step was billed for
  it (`producedBy`, the step key). A reuse by a later attempt of that same step records that usage (the dead attempt
  never did); a reuse by another run (a second production of the episode) records none, since that run paid nothing.
- **The cover is persisted the same way** (`cover.png` + `cover.json`, the prompt's request hash): a resumed cover step
  reuses it and never calls `image.generate` twice.
- **`master` reads every unit back against its journaled sha256**; a changed or missing file fails the step by name
  rather than mastering wrong audio. Retention is the store's (30 days): `podcast-publish` on an older episode fails at
  the read.
- **Cost** is the step records' (`steps.cost`): every unit's step opens its own audio scope whose call events become
  that step's usage (`stepUsage`), the cover's usage lands on the cover step. The output's `cost` is this run's steps
  and its unit children's; the room sums every run under its root (`root_id`) into `produceUsd`. The events go to the journal only, not to the door's usage port: the journal is what
  projects to Argo, so a second sink would count them twice.

## Effects and their keys

Each effect runs under the runtime's key `<runId>:<stepId>` (`ctx.effect`); a resumed effect waits out the body grace,
then runs again, and every effect checks its target before acting:

- **publish:** the file name carries the episode token `[<8 hex of the episode id's random tail>]` (legacy
  `episodeFilename` took the first 8 of a UUIDv4; a run id is a UUIDv7, whose first 8 hex repeat for about a minute).
  Before uploading, `publishToAudiobookshelf` polls once for an episode with this whole file name (whitespace and
  Unicode form normalised, as ABS's sanitizer may change them); found, it skips upload, scan and wait
  and only patches (idempotent). An upload ABS already holds under the same name replaces its own file, as in legacy,
  never a second episode.
- **brain-note:** the commit carries `Effect-Key: <runId>:brain-note` as its second paragraph. After writing the two
  files, an unchanged, tracked note means already committed: no second commit, only the push runs again (push is
  idempotent). No push remote or a held brain-sync lock is logged and returned (`pushed: false`), never fatal.
- **notify:** Slack has no read side; a kill between the send and the journal write can send the line twice. Accepted:
  it is a notice.

## podcast-publish

`agw podcast-publish <runId>` takes the `podcast` run id (or its `podcast.produce` child's) and repeats only the
upload from the journaled `plan`, `master` and `cover` outputs, then files the brain note again with the Audiobookshelf
link (legacy re-filed it only after a successful upload). Its own `publish` and `brain-note` effects have their own
keys. **Why its own command:** `agw podcast publish` cannot exist, because `podcast` is a command and the host refuses a
command that is the prefix of another (`app.ts` `assertCommands`). The `podcast` run's output is not rewritten; the
publish run's output is the current state.

## Configuration

One module, `config.ts`, legacy's names and defaults:

| Variable | Default | |
|-|-|-|
| `PODCAST_TTS_MODEL` | `audio.tts.gemini-flash` | a route id, or the model of one, in the audio route table; a Gemini route runs the multi-speaker lane, an ElevenLabs (`owner/name`) route the per-turn lane |
| `PODCAST_HOST_STYLE_A`, `_B` | `warm, conversational` | multi-speaker lane baseline style |
| `PODCAST_MULTISPEAKER_MAX_CHARS` | 3000 | |
| `PODCAST_STABILITY` | 0.5 | ElevenLabs lane; `TTS_ELEVENLABS_STYLE` / `_SIMILARITY` and `TTS_CONCURRENCY` come from the audio config |
| `PODCAST_DENSE_TURN_THRESHOLD`, `_SLOWDOWN` | 0.12, 0.06 | |
| `PODCAST_MP3_BITRATE`, `PODCAST_GAP_MS`, `PODCAST_SHORT_GAP_MS` | 64, 380, 160 | |
| `PODCAST_AUTHOR`, `PODCAST_SERIES_DESCRIPTION` | `Hermes`, legacy's text | |
| `ABS_URL`, `ABS_API_KEY`, `ABS_LIBRARY` | —, —, `Podcasts` | either unset: publish returns `{ok: false, error: "not configured"}` |
| `AGW_BRAIN_DIR` | `~/SourceRoot/brain` | the vault checkout the note is committed in; the same variable and default as the room and the `brain.*` capabilities |
| `PODCAST_NOTIFY_CHANNEL`, `ARGO_URL`, `ARGO_API_SECRET` | — | any unset: no Slack notice |

Voices and speeds are the room's (`PODCAST_VOICES`, `PODCAST_SPEEDS`, in `ProduceInput.hosts`).

## Route

No route of its own. The synth route is the audio table's (`packages/routes/src/table/audio.ts`, seat: the Gemini 3.8
multi-speaker TTS, legacy's `PODCAST_TTS_MODEL` default); the cover is `image.generate`'s routes
(`packages/routes/src/table/image.ts`).

## Parity and tools

- `scripts/eval-legacy/podcast-units.ts`: rule 2 of `docs/research/2026-10-29-wave8-ports.md` §podcast, the ported
  `turnsForSynthesis` + `unitsForMultiSpeaker` against legacy's on the 20 recorded scripts (also at 1500 and 6000
  characters). 20/20 exact on 2026-10-29.
- `scripts/produce-from-legacy.ts <job id>`: the `ProduceInput` of a recorded legacy job (`legacy-input.ts`); dry run by
  default, `--run` produces it on an in-process runtime, `--publish` / `--brain-note` opt into those effects.

## Tests

`produce.test.ts` runs the workflow (and its unit children) on a real runtime (Postgres), the TTS lane over the fake IU, real ffmpeg, a fake
Audiobookshelf (`testing.ts`) and temp git vaults: the full pass, resume after a kill mid-synth (TTS calls counted per
unit), the store-level reuse, publish idempotence on resume, a failing and an unconfigured Audiobookshelf, and
`podcast-publish`. The stage ports have their own (`synth`, `mux`, `abs`, `brain-note`, `notify`).

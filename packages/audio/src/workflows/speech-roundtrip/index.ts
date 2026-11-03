import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HostWorkflow } from '@agent-workflows/host'
import { defineWorkflow, type StepScope, type Usage, WorkflowError } from '@agent-workflows/runtime'
import { artifactDir } from '../../../../host/src/artifacts.ts'
import { createSpeechHandler } from '../../door/speech.ts'
import { createTranscriptionsHandler } from '../../door/transcriptions.ts'
import { ffmpegMedia, type MediaPort } from '../../media/audio.ts'
import { audioRoutes } from '../../routes.ts'
import type { AudioDeps } from '../../scope.ts'
import { stepUsage } from '../../step-usage.ts'
import type { UsagePort } from '../../usage.ts'
import {
  SpeechRoundtripInput,
  type SpeechRoundtripInputValue,
  SpeechRoundtripOutput,
  type SpeechRoundtripOutputValue,
} from './schema.ts'
import { speechRoundtripScorer } from './scorer.ts'

export const SPEECH_ROUNDTRIP_VERSION = '2026-11-03.1'
const CALLER = 'speech-roundtrip'
const AUDIO_FILE = 'speech.mp3'

type Leg = SpeechRoundtripOutputValue['tts']
type Spoken = { path: string; audioBytes: number; leg: Leg }
type Heard = { text: string; leg: Leg }

/** The step's usage port that also keeps what the legs report: calls, calls without a price, the price. */
function tally(addUsage: (usage: Usage) => void) {
  const port = stepUsage(addUsage)
  const totals = { calls: 0, unpricedCalls: 0, costUsd: 0 }
  const usage: UsagePort = {
    record(event) {
      if (event.kind === 'call') {
        totals.calls++
        if (event.costUsd === null) totals.unpricedCalls++
        else totals.costUsd += event.costUsd
      }
      return port.record(event)
    },
  }
  return { usage, totals }
}

/** `deps.fetch` (or the global) with the step's signal added: a cancelled run stops its upstream calls. */
const boundFetch =
  (deps: Pick<AudioDeps, 'fetch'>, signal: AbortSignal): NonNullable<AudioDeps['fetch']> =>
  (url, init) =>
    (deps.fetch ?? fetch)(url, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal })

/** The door handler's error body ({error: {message}}) or the status line, for a failed leg. */
async function failure(leg: string, route: string, response: Response): Promise<WorkflowError> {
  const body = await response.text().catch(() => '')
  let message = body.slice(0, 300)
  try {
    message = (JSON.parse(body) as { error?: { message?: string } }).error?.message ?? message
  } catch {
    // not JSON: the text stands
  }
  return new WorkflowError('step_failed', `${leg} on ${route}: ${response.status} ${message}`)
}

const leg = (route: string, model: string, totals: ReturnType<typeof tally>['totals'], latencyMs: number): Leg => ({
  route,
  model,
  calls: totals.calls,
  unpricedCalls: totals.unpricedCalls,
  costUsd: totals.unpricedCalls > 0 ? null : Number(totals.costUsd.toFixed(8)),
  latencyMs,
})

const armed = (scope: StepScope) => (scope.arm?.routes ? { routes: scope.arm.routes } : {})

/**
 * `speech-roundtrip`: eval only. A known sentence is spoken on a TTS route and the audio transcribed on an STT route;
 * the output is the transcript, the audio's length and what each leg called and cost, which its scorer compares with the
 * sentence. Both legs go through the door's own handlers in-process (the lanes, prep, fallback chain and pricing are the
 * door's), each on its own journaled step with its calls on that step's usage, so a resumed run never pays a leg twice.
 * The routes are inputs, so an arm (`agw eval run --args`) swaps either; an arm's route patch applies as for any route.
 * Internal: no HTTP route, no CLI command, and not on the door.
 */
export function createSpeechRoundtrip(deps: { audio: Omit<AudioDeps, 'usage'>; artifactRoot?: string }): HostWorkflow {
  const media: MediaPort =
    deps.audio.media ??
    ffmpegMedia({
      mp3BitrateKbps: deps.audio.config.ttsBitrateKbps,
      opusBitrateKbps: deps.audio.config.ttsOpusBitrateKbps,
    })

  const workflow = defineWorkflow({
    id: 'speech-roundtrip',
    version: SPEECH_ROUNDTRIP_VERSION,
    input: SpeechRoundtripInput,
    output: SpeechRoundtripOutput,
    scorer: speechRoundtripScorer,
    async run(ctx, input: SpeechRoundtripInputValue): Promise<SpeechRoundtripOutputValue> {
      const dir = join(artifactDir('speech-roundtrip', ctx.runId, deps.artifactRoot ? { root: deps.artifactRoot } : {}))

      const spoken: Spoken = await ctx.step('tts', async (scope) => {
        const { usage, totals } = tally(scope.addUsage)
        const model = audioRoutes(scope.arm?.routes)[input.ttsRoute].model
        const handler = createSpeechHandler({
          ...deps.audio,
          media,
          usage,
          fetch: boundFetch(deps.audio, scope.signal),
          ...armed(scope),
        })
        const started = Date.now()
        const response = await handler(
          new Request('http://audio.invalid/v1/audio/speech', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-audio-source': CALLER },
            body: JSON.stringify({
              model,
              input: input.text,
              response_format: 'mp3',
              language: input.language,
              ...(input.voice ? { voice: input.voice } : {}),
            }),
          }),
        )
        if (!response.ok) throw await failure('tts', input.ttsRoute, response)
        const bytes = new Uint8Array(await response.arrayBuffer())
        const path = join(dir, AUDIO_FILE)
        writeFileSync(path, bytes, { mode: 0o600 })
        return { path, audioBytes: bytes.byteLength, leg: leg(input.ttsRoute, model, totals, Date.now() - started) }
      })

      // Its own step: a probe that throws after the paid synthesis must not lose it (the TTS step above is journaled).
      const audioSeconds = await ctx.step('duration', async () =>
        Number((await media.duration(await Bun.file(spoken.path).bytes())).toFixed(3)),
      )

      const heard: Heard = await ctx.step('stt', async (scope) => {
        const { usage, totals } = tally(scope.addUsage)
        const model = audioRoutes(scope.arm?.routes)[input.sttRoute].model
        const handler = createTranscriptionsHandler({
          ...deps.audio,
          media,
          usage,
          fetch: boundFetch(deps.audio, scope.signal),
          ...armed(scope),
        })
        const form = new FormData()
        form.set('file', new File([await Bun.file(spoken.path).arrayBuffer()], AUDIO_FILE, { type: 'audio/mpeg' }))
        form.set('model', model)
        form.set('language', input.language)
        form.set('response_format', 'json')
        const started = Date.now()
        const response = await handler(
          new Request('http://audio.invalid/v1/audio/transcriptions', {
            method: 'POST',
            headers: { 'x-audio-source': CALLER },
            body: form,
          }),
        )
        if (!response.ok) throw await failure('stt', input.sttRoute, response)
        const { text } = (await response.json()) as { text?: unknown }
        if (typeof text !== 'string')
          throw new WorkflowError('step_failed', `stt on ${input.sttRoute}: no text in the reply`)
        return { text, leg: leg(input.sttRoute, model, totals, Date.now() - started) }
      })

      const costs = [spoken.leg.costUsd, heard.leg.costUsd]
      return {
        text: heard.text,
        audioSeconds,
        audioBytes: spoken.audioBytes,
        tts: spoken.leg,
        stt: heard.leg,
        costUsd: costs.includes(null) ? null : Number(costs.reduce<number>((sum, c) => sum + (c ?? 0), 0).toFixed(8)),
      }
    },
  })
  return {
    workflow,
    summary:
      'Eval only: speak a known sentence on a TTS route, transcribe the audio on an STT route; the scorer compares the transcript with the sentence',
    internal: true,
  }
}

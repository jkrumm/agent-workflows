import { z } from 'zod'
import { AUDIO_DEFAULT_ROUTES, AUDIO_LANES, type AudioRouteId } from '../../routes.ts'

const routeIds = (lanes: readonly string[]) =>
  Object.entries(AUDIO_LANES)
    .filter(([, spec]) => lanes.includes(spec.lane))
    .map(([id]) => id) as [AudioRouteId, ...AudioRouteId[]]

/** The TTS and STT routes of the table (the prep and summary LLMs are not speech routes). */
export const TTS_ROUTES = routeIds(['gemini', 'replicate'])
export const STT_ROUTES = routeIds(['stt'])

export const SpeechRoundtripInput = z
  .object({
    text: z.string().trim().min(1).max(600).describe('The sentence to speak and hear back'),
    language: z.enum(['de', 'en']).describe('The language of the sentence; also the STT language hint'),
    ttsRoute: z.enum(TTS_ROUTES).default(AUDIO_DEFAULT_ROUTES.tts).describe('The TTS route that speaks it'),
    sttRoute: z.enum(STT_ROUTES).default(AUDIO_DEFAULT_ROUTES.stt).describe('The STT route that transcribes it'),
    voice: z.string().min(1).optional().describe("The TTS voice; absent: the lane's default"),
  })
  .strict()
export type SpeechRoundtripInputValue = z.output<typeof SpeechRoundtripInput>

/** One leg of the trip as the usage port saw it: the route that served, its calls (retries included) and their price. */
const Leg = z.object({
  route: z.string(),
  model: z.string(),
  calls: z.int().nonnegative(),
  unpricedCalls: z.int().nonnegative(),
  costUsd: z.number().nonnegative().nullable(),
  latencyMs: z.int().nonnegative(),
})

export const SpeechRoundtripOutput = z.object({
  text: z.string().describe('The transcript of the spoken sentence'),
  audioSeconds: z
    .number()
    .nonnegative()
    .describe('Length of the synthesized audio (ffprobe); 0 when it could not be told'),
  audioBytes: z.int().nonnegative(),
  tts: Leg,
  stt: Leg,
  costUsd: z.number().nonnegative().nullable().describe('Both legs; null when a call had no price'),
})
export type SpeechRoundtripOutputValue = z.output<typeof SpeechRoundtripOutput>

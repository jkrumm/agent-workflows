import { type Rate, type RouteId, resolveRoute, type Wire } from '@agent-workflows/routes'

// The audio routes. Model, wire, effort and token rates live in the route table (`packages/routes/src/table/audio.ts`)
// and honour `AGW_ROUTES` overrides; this file adds what only the audio lanes read, keyed by route id, and names no
// model. The non-token prices (per 1k characters, per minute, the STT audio-token split) stay here until the general
// price shape lands in `packages/routes` with the image port; `priceCall` in `usage.ts` is the one place reading them.
// Rates and stamps: audio-gateway `src/usage.ts` (`RATES`) at 568c281.

export type AudioLane = 'gemini' | 'replicate' | 'stt' | 'llm'

export interface PriceStamp {
  /** True only for a rate confirmed against an invoice or the billing provider's statement. */
  verified: boolean
  note: string
}

export type AudioPrice =
  | {
      unit: 'tokens'
      inputPerM: number
      outputPerM: number
      /** Prompt-cache hits, a subset of input. */
      cachedInputPerM?: number
      /** Audio input tokens (STT), billed instead of `inputPerM` for that share. */
      audioInputPerM?: number
      stamp: PriceStamp
    }
  | { unit: 'characters'; per1k: number; stamp: PriceStamp }
  | { unit: 'audio-seconds'; perMinute: number; stamp: PriceStamp }

interface LaneSpec {
  lane: AudioLane
  /** TTS: the prep LLM runs for this model by default (legacy `TTS_GEMINI_PREP_MODELS` / `TTS_REPLICATE_PREP_MODELS`). */
  prep?: boolean
  /** ElevenLabs: the model accepts `previous_text` / `next_text`. */
  continuity?: boolean
  /** STT: the route a 404/5xx moves to (legacy `fallbackFor`); absent = terminal. */
  sttFallback?: RouteId
  /** STT: the model answers only json/text, so verbose_json/srt/vtt are synthesized here. */
  synthesizeEnvelope?: boolean
  /** STT: the model takes `context_bias` (Voxtral) instead of honouring `prompt`. */
  contextBias?: boolean
  /** A price the route table's token `rate` cannot express; wins over the rate. */
  price?: AudioPrice
}

const ELEVENLABS = 'per character at the vendor list rate; IU meters per prediction (legacy usage.ts, 2026-09-10)'
const minutes = (perMinute: number, note: string): AudioPrice => ({
  unit: 'audio-seconds',
  perMinute,
  stamp: { verified: false, note },
})

export const AUDIO_LANES = {
  'audio.tts.gemini-flash-lite': { lane: 'gemini' },
  'audio.tts.gemini-flash': { lane: 'gemini', prep: true },
  'audio.tts.elevenlabs-flash': {
    lane: 'replicate',
    continuity: true,
    price: { unit: 'characters', per1k: 0.05, stamp: { verified: false, note: ELEVENLABS } },
  },
  'audio.tts.elevenlabs-turbo': {
    lane: 'replicate',
    continuity: true,
    price: { unit: 'characters', per1k: 0.05, stamp: { verified: false, note: 'assumed identical to flash-v2.5' } },
  },
  // v3 rejects previous_text/next_text since 2026-10-24.
  'audio.tts.elevenlabs-v3': {
    lane: 'replicate',
    prep: true,
    continuity: false,
    price: {
      unit: 'characters',
      per1k: 0.1,
      stamp: { verified: false, note: 'elevenlabs.io/pricing/api, 2026-09-02' },
    },
  },
  'audio.tts.prep': { lane: 'llm' },
  'audio.tts.summary': { lane: 'llm' },
  // Fallback chain: everything -> `audio.stt.openai` -> `audio.stt.openai-legacy` (terminal).
  'audio.stt.voxtral-mini': {
    lane: 'stt',
    sttFallback: 'audio.stt.openai',
    synthesizeEnvelope: true,
    contextBias: true,
    price: minutes(0.0035, 'docs.mistral.ai pricing, 2026-10-25'),
  },
  'audio.stt.voxtral-small': {
    lane: 'stt',
    sttFallback: 'audio.stt.openai',
    synthesizeEnvelope: true,
    contextBias: true,
    price: minutes(0.004, 'docs.mistral.ai pricing, 2026-10-25'),
  },
  'audio.stt.openai': {
    lane: 'stt',
    sttFallback: 'audio.stt.openai-legacy',
    synthesizeEnvelope: true,
    price: minutes(0.0045, 'OpenAI list price, 2026-10-15, duration-billed'),
  },
  'audio.stt.openai-4o': {
    lane: 'stt',
    sttFallback: 'audio.stt.openai',
    synthesizeEnvelope: true,
    price: {
      unit: 'tokens',
      inputPerM: 2.5,
      audioInputPerM: 6,
      outputPerM: 10,
      stamp: { verified: false, note: 'OpenAI list price' },
    },
  },
  'audio.stt.openai-4o-mini': {
    lane: 'stt',
    sttFallback: 'audio.stt.openai',
    synthesizeEnvelope: true,
    price: {
      unit: 'tokens',
      inputPerM: 1.25,
      audioInputPerM: 1.25,
      outputPerM: 5,
      stamp: { verified: true, note: 'platform.openai.com/docs/pricing, verified 2026-07-24' },
    },
  },
  // Whisper answers verbose_json/srt/vtt natively (real segment timing): passed through.
  'audio.stt.openai-legacy': { lane: 'stt', price: minutes(0.006, 'OpenAI list price') },
} as const satisfies Partial<Record<RouteId, LaneSpec>>

export type AudioRouteId = keyof typeof AUDIO_LANES

/** A resolved audio route: the table entry (overrides applied) plus its lane. */
export interface AudioRoute extends LaneSpec {
  id: AudioRouteId
  wire: Wire
  model: string
  effort?: string
  rate?: Rate
}

type Env = Record<string, string | undefined>

/** Every audio route resolved once, overrides applied (`resolveRoute` fails on a bad `AGW_ROUTES`). */
export function audioRoutes(env: Env = process.env): Readonly<Record<AudioRouteId, AudioRoute>> {
  const out = {} as Record<AudioRouteId, AudioRoute>
  for (const [id, lane] of Object.entries(AUDIO_LANES) as [AudioRouteId, LaneSpec][]) {
    const { wire, model, effort, rate } = resolveRoute(id, env)
    out[id] = { ...lane, id, wire, model, ...(effort && { effort }), ...(rate && { rate }) }
  }
  return Object.freeze(out)
}

/** The door's defaults when a request names no model, or one no route serves. Changing one is a route override. */
export const AUDIO_DEFAULT_ROUTES = {
  tts: 'audio.tts.gemini-flash-lite',
  stt: 'audio.stt.voxtral-mini',
  prep: 'audio.tts.prep',
  summary: 'audio.tts.summary',
} as const satisfies Record<string, AudioRouteId>

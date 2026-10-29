import { type Price, type Rate, type RouteId, resolveRoute, type Wire } from '@agent-workflows/routes'

// The audio routes. Model, wire, effort and token rates live in the route table (`packages/routes/src/table/audio.ts`)
// and honour `AGW_ROUTES` overrides; this file adds what only the audio lanes read, keyed by route id, and names no
// model and no price: every price (token `rate`, or `price` per 1k characters, per minute, audio-token split) is the
// table's, read by `priceCall` in `usage.ts`. The one price fact the table has no field for, an invoice-verified stamp,
// is `priceVerified` here (audio-gateway `src/usage.ts` RATES at 568c281: only `audio.stt.openai-4o-mini`).

export type AudioLane = 'gemini' | 'replicate' | 'stt' | 'llm'

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
  /** The route's price is invoice-verified (default: a list price or an inference). */
  priceVerified?: true
}

export const AUDIO_LANES = {
  'audio.tts.gemini-flash-lite': { lane: 'gemini' },
  'audio.tts.gemini-flash': { lane: 'gemini', prep: true },
  'audio.tts.elevenlabs-flash': {
    lane: 'replicate',
    continuity: true,
  },
  'audio.tts.elevenlabs-turbo': {
    lane: 'replicate',
    continuity: true,
  },
  // v3 rejects previous_text/next_text since 2026-10-24.
  'audio.tts.elevenlabs-v3': {
    lane: 'replicate',
    prep: true,
    continuity: false,
  },
  'audio.tts.prep': { lane: 'llm' },
  'audio.tts.summary': { lane: 'llm' },
  // Fallback chain: everything -> `audio.stt.openai` -> `audio.stt.openai-legacy` (terminal).
  'audio.stt.voxtral-mini': {
    lane: 'stt',
    sttFallback: 'audio.stt.openai',
    synthesizeEnvelope: true,
    contextBias: true,
  },
  'audio.stt.voxtral-small': {
    lane: 'stt',
    sttFallback: 'audio.stt.openai',
    synthesizeEnvelope: true,
    contextBias: true,
  },
  'audio.stt.openai': {
    lane: 'stt',
    sttFallback: 'audio.stt.openai-legacy',
    synthesizeEnvelope: true,
  },
  'audio.stt.openai-4o': {
    lane: 'stt',
    sttFallback: 'audio.stt.openai',
    synthesizeEnvelope: true,
  },
  'audio.stt.openai-4o-mini': {
    lane: 'stt',
    priceVerified: true,
    sttFallback: 'audio.stt.openai',
    synthesizeEnvelope: true,
  },
  // Whisper answers verbose_json/srt/vtt natively (real segment timing): passed through.
  'audio.stt.openai-legacy': { lane: 'stt' },
} as const satisfies Partial<Record<RouteId, LaneSpec>>

export type AudioRouteId = keyof typeof AUDIO_LANES

/** A resolved audio route: the table entry (overrides applied) plus its lane. */
export interface AudioRoute extends LaneSpec {
  id: AudioRouteId
  wire: Wire
  model: string
  effort?: string
  rate?: Rate
  price?: Price
}

type Env = Record<string, string | undefined>

/** Every audio route resolved once, overrides applied (`resolveRoute` fails on a bad `AGW_ROUTES`). */
export function audioRoutes(env: Env = process.env): Readonly<Record<AudioRouteId, AudioRoute>> {
  const out = {} as Record<AudioRouteId, AudioRoute>
  for (const [id, lane] of Object.entries(AUDIO_LANES) as [AudioRouteId, LaneSpec][]) {
    const { wire, model, effort, rate, price } = resolveRoute(id, env)
    out[id] = { ...lane, id, wire, model, ...(effort && { effort }), ...(rate && { rate }), ...(price && { price }) }
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

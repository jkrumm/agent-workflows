// PENDING REGISTRATION: these entries move into `packages/routes` once the registry split (`w8/registry`) lands and
// the lead says so; until then this file is the only place in this package that names a model id, so the move is one
// file plus the import below each consumer already goes through (`audioRoute`). The prices are non-token shapes the
// route `rate` cannot express yet (per 1k characters, per minute of audio); `priceCall` in `usage.ts` is the one
// function that reads them, so swapping in the general non-token price shape (`w8/image`) is one place.
//
// Rates and their stamps are copied from audio-gateway `src/usage.ts` (`RATES`) at 568c281. Nothing is
// invoice-verified except where `verified: true`; the notes keep legacy's source line.

export type AudioWire =
  /** Gemini native `generateContent` / `streamGenerateContent` with an AUDIO modality. */
  | 'iu-gemini-tts'
  /** ElevenLabs on IU's Replicate route: create prediction, poll, fetch the delivery MP3. */
  | 'iu-replicate-tts'
  /** IU's OpenAI `/audio/speech`, proxied unchanged (the passthrough lane). */
  | 'iu-openai-speech'
  /** IU's OpenAI `/audio/transcriptions`. */
  | 'iu-openai-stt'
  /** IU chat completions (the prep and summary LLMs). */
  | 'iu-openai'

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

export interface AudioRoute {
  wire: AudioWire
  model: string
  effort?: 'low' | 'medium' | 'high'
  price?: AudioPrice
  /** TTS: the prep LLM runs for this model by default (legacy `TTS_GEMINI_PREP_MODELS` / `TTS_REPLICATE_PREP_MODELS`). */
  prep?: boolean
  /** ElevenLabs: the model accepts `previous_text` / `next_text`. */
  continuity?: boolean
  /** STT: the route a 404/5xx moves to (legacy `fallbackFor`); absent = terminal. */
  fallback?: string
  /** STT: the model answers only json/text, so verbose_json/srt/vtt are synthesized here. */
  synthesizeEnvelope?: boolean
  /** STT: the model takes `context_bias` (Voxtral) instead of honouring `prompt`. */
  contextBias?: boolean
}

const GEMINI_TTS_NOTE = 'ai.google.dev pricing, GA 2026-09-22; audio-out introductory through 2026-12-31 (then 12 / 18)'
const ELEVENLABS_NOTE =
  'per character at the vendor list rate; IU meters per prediction (2026-09-10 invoice analysis in legacy usage.ts)'

export const AUDIO_ROUTES = {
  // TTS door models. Output tokens are audio tokens, 25 per second of audio.
  'audio.tts.gemini-flash-lite': {
    wire: 'iu-gemini-tts',
    model: 'gemini-3.8-flash-lite-tts',
    price: { unit: 'tokens', inputPerM: 0.5, outputPerM: 6, stamp: { verified: false, note: GEMINI_TTS_NOTE } },
  },
  'audio.tts.gemini-flash': {
    wire: 'iu-gemini-tts',
    model: 'gemini-3.8-flash-tts',
    prep: true,
    price: { unit: 'tokens', inputPerM: 0.5, outputPerM: 9, stamp: { verified: false, note: GEMINI_TTS_NOTE } },
  },
  'audio.tts.elevenlabs-flash': {
    wire: 'iu-replicate-tts',
    model: 'elevenlabs/flash-v2.5',
    continuity: true,
    price: { unit: 'characters', per1k: 0.05, stamp: { verified: false, note: ELEVENLABS_NOTE } },
  },
  'audio.tts.elevenlabs-turbo': {
    wire: 'iu-replicate-tts',
    model: 'elevenlabs/turbo-v2.5',
    continuity: true,
    price: {
      unit: 'characters',
      per1k: 0.05,
      stamp: { verified: false, note: 'no separate Replicate line item; assumed identical to flash-v2.5' },
    },
  },
  // v3 rejects previous_text/next_text since 2026-10-24.
  'audio.tts.elevenlabs-v3': {
    wire: 'iu-replicate-tts',
    model: 'elevenlabs/v3',
    prep: true,
    continuity: false,
    price: {
      unit: 'characters',
      per1k: 0.1,
      stamp: { verified: false, note: 'elevenlabs.io/pricing/api, read 2026-09-02' },
    },
  },

  // TTS prep and spoken-summary LLMs (chat completions). Prep effort `low`: the call dominates briefing latency.
  'audio.tts.prep': {
    wire: 'iu-openai',
    model: 'gpt-6-luna',
    effort: 'low',
    price: {
      unit: 'tokens',
      inputPerM: 0.1,
      cachedInputPerM: 0.01,
      outputPerM: 0.5,
      stamp: { verified: false, note: 'OpenAI list price, short-context tier, 2026-09-23' },
    },
  },
  'audio.tts.summary': {
    wire: 'iu-openai',
    model: 'gemini-3.5-flash-lite',
    price: {
      unit: 'tokens',
      inputPerM: 0.3,
      outputPerM: 2.5,
      stamp: { verified: false, note: 'ai.google.dev pricing, read 2026-09-02' },
    },
  },

  // STT door models. Fallback chain: everything -> gpt-transcribe -> whisper (terminal).
  'audio.stt.voxtral-mini': {
    wire: 'iu-openai-stt',
    model: 'voxtral-mini-transcribe-3-0',
    fallback: 'audio.stt.gpt-transcribe',
    synthesizeEnvelope: true,
    contextBias: true,
    price: {
      unit: 'audio-seconds',
      perMinute: 0.0035,
      stamp: { verified: false, note: 'docs.mistral.ai pricing, 2026-10-25' },
    },
  },
  'audio.stt.voxtral-small': {
    wire: 'iu-openai-stt',
    model: 'voxtral-small-transcribe-3-0',
    fallback: 'audio.stt.gpt-transcribe',
    synthesizeEnvelope: true,
    contextBias: true,
    price: {
      unit: 'audio-seconds',
      perMinute: 0.004,
      stamp: { verified: false, note: 'docs.mistral.ai pricing, 2026-10-25' },
    },
  },
  'audio.stt.gpt-transcribe': {
    wire: 'iu-openai-stt',
    model: 'gpt-transcribe',
    fallback: 'audio.stt.whisper',
    synthesizeEnvelope: true,
    price: {
      unit: 'audio-seconds',
      perMinute: 0.0045,
      stamp: { verified: false, note: 'OpenAI list price, 2026-10-15, duration-billed' },
    },
  },
  'audio.stt.gpt-4o-transcribe': {
    wire: 'iu-openai-stt',
    model: 'gpt-4o-transcribe',
    fallback: 'audio.stt.gpt-transcribe',
    synthesizeEnvelope: true,
    price: {
      unit: 'tokens',
      inputPerM: 2.5,
      audioInputPerM: 6,
      outputPerM: 10,
      stamp: { verified: false, note: 'OpenAI list price' },
    },
  },
  'audio.stt.gpt-4o-mini-transcribe': {
    wire: 'iu-openai-stt',
    model: 'gpt-4o-mini-transcribe',
    fallback: 'audio.stt.gpt-transcribe',
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
  'audio.stt.whisper': {
    wire: 'iu-openai-stt',
    model: 'whisper',
    price: { unit: 'audio-seconds', perMinute: 0.006, stamp: { verified: false, note: 'OpenAI list price' } },
  },
} as const satisfies Record<string, AudioRoute>

export type AudioRouteId = keyof typeof AUDIO_ROUTES

/** The door's defaults when a request names no model, or one the table does not know. */
export const AUDIO_DEFAULT_ROUTES = {
  tts: 'audio.tts.gemini-flash-lite',
  stt: 'audio.stt.voxtral-mini',
  prep: 'audio.tts.prep',
  summary: 'audio.tts.summary',
} as const satisfies Record<string, AudioRouteId>

import type { RouteEntry } from '../schema.ts'

// The audio door's seats (Wave 8, concept §8/§10): one route per TTS/STT model the door accepts, plus the prep and
// spoken-summary LLMs. Ported from audio-gateway (`src/config.ts` defaults, `src/usage.ts` RATES at 568c281); the
// lane behaviour of each route (prep, continuity, STT fallback chain, envelope synthesis) lives in `packages/audio`,
// keyed by these ids. Evidence that these are the models callers send: audio-gateway's VPS usage ledger, 2026-09-29 to
// 2026-10-29 (packages/audio/README.md §Decisions).
//
// Text-token routes carry a `rate`; ElevenLabs (per 1k characters), STT (per minute: `second` units, `per: 60`) and the
// token-billed STT models (`audio-tokens`) carry a `price` (`../price.ts`). None is invoice-verified except
// gpt-4o-mini-transcribe; each comment keeps legacy's source line (audio-gateway `src/usage.ts` RATES).
//
// Gemini 3.8 TTS: ai.google.dev pricing, GA 2026-09-22, list not invoice-verified. Output tokens are audio tokens,
// 25 per second; audio-out is introductory through 2026-12-31 (then flash-lite 12, flash 18 USD/M).
const PER_1K_CHARS = (usd: number) => ({ kind: 'unit', unit: 'character', usd, per: 1000 }) as const
const PER_MINUTE = (usd: number) => ({ kind: 'unit', unit: 'second', usd, per: 60 }) as const

const routes = {
  // Hermes chat default (the door's default TTS route): one raw call, no prep.
  'audio.tts.gemini-flash-lite': {
    wire: 'iu-gemini',
    model: 'gemini-3.8-flash-lite-tts',
    rate: { inputPerM: 0.5, outputPerM: 6 },
  },
  // Briefings: the prep lane.
  'audio.tts.gemini-flash': {
    wire: 'iu-gemini',
    model: 'gemini-3.8-flash-tts',
    rate: { inputPerM: 0.5, outputPerM: 9 },
  },
  // ElevenLabs on IU's Replicate route, per 1k characters at the vendor list rate (IU meters per prediction; legacy
  // usage.ts, 2026-09-10 invoice analysis). Turbo has no Replicate line item: assumed identical to flash. v3:
  // elevenlabs.io/pricing/api, read 2026-09-02.
  'audio.tts.elevenlabs-flash': { wire: 'iu-replicate', model: 'elevenlabs/flash-v2.5', price: PER_1K_CHARS(0.05) },
  'audio.tts.elevenlabs-turbo': { wire: 'iu-replicate', model: 'elevenlabs/turbo-v2.5', price: PER_1K_CHARS(0.05) },
  'audio.tts.elevenlabs-v3': { wire: 'iu-replicate', model: 'elevenlabs/v3', price: PER_1K_CHARS(0.1) },

  // Prep: OpenAI list price, short-context tier, 2026-09-23. Effort `low`: this call dominates briefing latency.
  'audio.tts.prep': {
    wire: 'iu-openai',
    model: 'gpt-6-luna',
    effort: 'low',
    rate: { inputPerM: 0.1, outputPerM: 0.5, cacheReadPerM: 0.01 },
  },
  // Spoken summary: ai.google.dev pricing, read 2026-09-02. Measured 0.8–1.0 s (legacy config, 2026-08-27).
  'audio.tts.summary': { wire: 'iu-openai', model: 'gemini-3.5-flash-lite', rate: { inputPerM: 0.3, outputPerM: 2.5 } },

  // STT on IU's OpenAI `/audio/transcriptions`. Default since 2026-10-25: voxtral-mini (EU). Per minute of audio:
  // voxtral docs.mistral.ai pricing 2026-10-25; gpt-transcribe OpenAI list 2026-10-15 (duration-billed); whisper OpenAI
  // list. The 4o models bill tokens with an audio split: OpenAI list price; 4o-mini verified 2026-07-24
  // (platform.openai.com/docs/pricing, one rate for audio and text).
  'audio.stt.voxtral-mini': { wire: 'iu-openai', model: 'voxtral-mini-transcribe-3-0', price: PER_MINUTE(0.0035) },
  'audio.stt.voxtral-small': { wire: 'iu-openai', model: 'voxtral-small-transcribe-3-0', price: PER_MINUTE(0.004) },
  'audio.stt.openai': { wire: 'iu-openai', model: 'gpt-transcribe', price: PER_MINUTE(0.0045) },
  'audio.stt.openai-4o': {
    wire: 'iu-openai',
    model: 'gpt-4o-transcribe',
    price: { kind: 'audio-tokens', textInPerM: 2.5, audioInPerM: 6, outputPerM: 10 },
  },
  'audio.stt.openai-4o-mini': {
    wire: 'iu-openai',
    model: 'gpt-4o-mini-transcribe',
    price: { kind: 'audio-tokens', textInPerM: 1.25, audioInPerM: 1.25, outputPerM: 5 },
  },
  'audio.stt.openai-legacy': { wire: 'iu-openai', model: 'whisper', price: PER_MINUTE(0.006) },
} satisfies Record<string, RouteEntry>

export default routes

declare module '../schema.ts' {
  interface RouteTable extends Record<keyof typeof routes, true> {}
}

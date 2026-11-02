import { type AudioLane, audioRoutes } from './routes.ts'

export type Env = Record<string, string | undefined>

/**
 * The local inference gateway: its bearer (the host's API secret, which the gateway accepts as the caller `agw`) and
 * every wire's base, derived from `AGW_GATEWAY_URL` the way `gatewayConfig` of `packages/capabilities` does. That
 * function has no Gemini base and the package is not a dependency of audio, so the rule is repeated here.
 */
export interface AudioTransports {
  token: string
  /** `<origin>/anthropic`: the Messages route (the prep call on an `anthropic` route). */
  anthropicBase: string
  /** `<root>/openai/v1`: chat completions, `/audio/speech`, `/audio/transcriptions`. */
  openaiBase: string
  /** `<root>/gemini/v1beta`: native `generateContent`. */
  geminiBase: string
  /** `<root>/replicate/v1`: ElevenLabs predictions. */
  replicateBase: string
}

/** Tuning knobs; env names and defaults are audio-gateway's (`src/config.ts`), so a deploy env carries over unchanged. */
export interface AudioTuning {
  /** Model ids (or prefixes) that run the Gemini prep LLM. Default: the routes flagged `prep`. */
  ttsGeminiPrepModels: string[]
  /** Model ids (or prefixes) that run the ElevenLabs prep LLM. Default: the routes flagged `prep`. */
  ttsReplicatePrepModels: string[]
  /** `always`: prep every request of a prep model; `long`: only at or above `ttsChunkCharThreshold`; `off`: never. */
  ttsPrep: 'always' | 'long' | 'off'
  /** Whole-file requests on a prep-off ElevenLabs model whose text is at least this long get the spoken summary. 0 = off. */
  ttsAutoSummarizeMinChars: number
  ttsBitrateKbps: number
  ttsOpusBitrateKbps: number
  ttsChunkCharThreshold: number
  ttsChunkTargetWords: number
  ttsChunkMaxWords: number
  ttsChunkMaxBytes: number
  /** Chunks synthesized at once, an integer in [1, 8]. */
  ttsConcurrency: number
  ttsElevenLabsVoice: string
  ttsDefaultLanguage: 'de' | 'en'
  ttsElevenLabsStability: number
  ttsElevenLabsStyle: number
  ttsElevenLabsSimilarity: number
  ttsReplicateChunkTargetWords: number
  ttsReplicateChunkMaxWords: number
  /** Default STT `language` when the client sends none. */
  sttLanguage: string
  /** Default STT `prompt` when the client sends none; also stripped when a chunk echoes it. */
  sttPrompt: string
  /** Default Voxtral `context_bias`. */
  sttContextBias: string
  sttMaxUploadBytes: number
  sttCompressBitrateKbps: number
  sttMaxChunks: number
  /** Output quality collapses past ~240 s on the 4o transcribe model; also Whisper's ~230 s timeout. */
  sttMaxChunkSeconds: number
  sttSilenceNoiseDb: number
  sttSilenceMinSec: number
  sttSilenceWindowSec: number
  /** Parts transcribed at once, an integer in [1, 8]. */
  sttChunkConcurrency: number
}

export interface AudioConfig extends AudioTuning {
  transports: AudioTransports
}

export class AudioConfigError extends Error {}

const prepModels = (lane: AudioLane, env: Env): string[] =>
  Object.values(audioRoutes(env))
    .filter((r) => r.lane === lane && r.prep)
    .map((r) => r.model)

/** Legacy's defaults. The prep model lists default to the routes flagged `prep`, resolved with the same env. */
export const AUDIO_TUNING_DEFAULTS: Readonly<Omit<AudioTuning, 'ttsGeminiPrepModels' | 'ttsReplicatePrepModels'>> =
  Object.freeze({
    ttsPrep: 'always',
    ttsAutoSummarizeMinChars: 120,
    ttsBitrateKbps: 48,
    ttsOpusBitrateKbps: 32,
    ttsChunkCharThreshold: 700,
    ttsChunkTargetWords: 110,
    ttsChunkMaxWords: 150,
    ttsChunkMaxBytes: 1100,
    ttsConcurrency: 4,
    ttsElevenLabsVoice: 'Mark',
    ttsDefaultLanguage: 'de',
    ttsElevenLabsStability: 0.5,
    ttsElevenLabsStyle: 0,
    ttsElevenLabsSimilarity: 0.75,
    ttsReplicateChunkTargetWords: 60,
    ttsReplicateChunkMaxWords: 80,
    sttLanguage: '',
    sttPrompt: '',
    sttContextBias: '',
    sttMaxUploadBytes: 24 * 1024 * 1024,
    sttCompressBitrateKbps: 32,
    sttMaxChunks: 32,
    sttMaxChunkSeconds: 240,
    sttSilenceNoiseDb: -30,
    sttSilenceMinSec: 0.2,
    sttSilenceWindowSec: 90,
    sttChunkConcurrency: 4,
  })

/** Every wire's base on the gateway from `AGW_GATEWAY_URL`: an http(s) origin, required. Messages never echo a value. */
export function gatewayBases(env: Env): Omit<AudioTransports, 'token'> {
  const raw = env.AGW_GATEWAY_URL?.trim()
  if (!raw) throw new AudioConfigError('AGW_GATEWAY_URL is not set')
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new AudioConfigError('AGW_GATEWAY_URL is not a URL')
  }
  // An origin only: a path (an old IU base ending in `/anthropic`) would double every wire's prefix.
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.pathname !== '/' || url.search || url.hash) {
    throw new AudioConfigError('AGW_GATEWAY_URL must be an http(s) origin, without a path')
  }
  const origin = url.origin
  return {
    anthropicBase: `${origin}/anthropic`,
    openaiBase: `${origin}/openai/v1`,
    geminiBase: `${origin}/gemini/v1beta`,
    replicateBase: `${origin}/replicate/v1`,
  }
}

/** The gateway from `AGW_GATEWAY_URL` and `AGW_API_SECRET` only. Messages never echo a value. */
export function audioTransports(env: Env): AudioTransports {
  const bases = gatewayBases(env)
  const token = env.AGW_API_SECRET?.trim()
  if (!token) throw new AudioConfigError('AGW_API_SECRET is not set')
  return { token, ...bases }
}

/** A worker count: an integer in [1, 8]. 0 or a negative would never start a window, a fraction misaligns them. */
const concurrency = (n: number): number => Math.min(8, Math.max(1, Math.floor(n)))

/** The whole config from the environment; unset or blank variables keep the default, a malformed one throws. */
export function audioConfig(env: Env): AudioConfig {
  const d = AUDIO_TUNING_DEFAULTS
  const num = (name: string, fallback: number): number => {
    const raw = env[name]
    if (raw === undefined || raw.trim() === '') return fallback
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) throw new AudioConfigError(`invalid numeric env var ${name}: "${raw}"`)
    return parsed
  }
  const str = (name: string, fallback: string): string => env[name] ?? fallback
  const list = (name: string, fallback: string[]): string[] => {
    const raw = env[name]
    if (raw === undefined) return fallback
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  }
  const oneOf = <T extends string>(name: string, allowed: readonly T[], fallback: T): T => {
    const raw = env[name]
    if (raw === undefined || raw === '') return fallback
    if (!(allowed as readonly string[]).includes(raw)) {
      throw new AudioConfigError(`invalid env var ${name}: "${raw}" (expected ${allowed.join(', ')})`)
    }
    return raw as T
  }
  return {
    transports: audioTransports(env),
    ttsGeminiPrepModels: list('TTS_GEMINI_PREP_MODELS', prepModels('gemini', env)),
    ttsReplicatePrepModels: list('TTS_REPLICATE_PREP_MODELS', prepModels('replicate', env)),
    ttsPrep: oneOf('TTS_PREP', ['always', 'long', 'off'] as const, d.ttsPrep),
    ttsAutoSummarizeMinChars: num('TTS_AUTO_SUMMARIZE_MIN_CHARS', d.ttsAutoSummarizeMinChars),
    ttsBitrateKbps: num('TTS_MP3_BITRATE', d.ttsBitrateKbps),
    ttsOpusBitrateKbps: num('TTS_OPUS_BITRATE', d.ttsOpusBitrateKbps),
    ttsChunkCharThreshold: num('TTS_CHUNK_THRESHOLD', d.ttsChunkCharThreshold),
    ttsChunkTargetWords: num('TTS_CHUNK_TARGET_WORDS', d.ttsChunkTargetWords),
    ttsChunkMaxWords: num('TTS_CHUNK_MAX_WORDS', d.ttsChunkMaxWords),
    ttsChunkMaxBytes: num('TTS_CHUNK_MAX_BYTES', d.ttsChunkMaxBytes),
    ttsConcurrency: concurrency(num('TTS_CONCURRENCY', d.ttsConcurrency)),
    ttsElevenLabsVoice: str('TTS_ELEVENLABS_VOICE', d.ttsElevenLabsVoice),
    ttsDefaultLanguage: oneOf('TTS_DEFAULT_LANGUAGE', ['de', 'en'] as const, d.ttsDefaultLanguage),
    ttsElevenLabsStability: num('TTS_ELEVENLABS_STABILITY', d.ttsElevenLabsStability),
    ttsElevenLabsStyle: num('TTS_ELEVENLABS_STYLE', d.ttsElevenLabsStyle),
    ttsElevenLabsSimilarity: num('TTS_ELEVENLABS_SIMILARITY', d.ttsElevenLabsSimilarity),
    ttsReplicateChunkTargetWords: num('TTS_REPLICATE_CHUNK_TARGET_WORDS', d.ttsReplicateChunkTargetWords),
    ttsReplicateChunkMaxWords: num('TTS_REPLICATE_CHUNK_MAX_WORDS', d.ttsReplicateChunkMaxWords),
    sttLanguage: str('STT_LANGUAGE', d.sttLanguage),
    sttPrompt: str('STT_PROMPT', d.sttPrompt),
    sttContextBias: str('STT_CONTEXT_BIAS', d.sttContextBias),
    sttMaxUploadBytes: num('STT_MAX_UPLOAD_BYTES', d.sttMaxUploadBytes),
    sttCompressBitrateKbps: num('STT_COMPRESS_BITRATE_KBPS', d.sttCompressBitrateKbps),
    sttMaxChunks: num('STT_MAX_CHUNKS', d.sttMaxChunks),
    sttMaxChunkSeconds: num('STT_MAX_CHUNK_SECONDS', d.sttMaxChunkSeconds),
    sttSilenceNoiseDb: num('STT_SILENCE_NOISE_DB', d.sttSilenceNoiseDb),
    sttSilenceMinSec: num('STT_SILENCE_MIN_SEC', d.sttSilenceMinSec),
    sttSilenceWindowSec: num('STT_SILENCE_WINDOW_SEC', d.sttSilenceWindowSec),
    sttChunkConcurrency: concurrency(num('STT_CHUNK_CONCURRENCY', d.sttChunkConcurrency)),
  }
}

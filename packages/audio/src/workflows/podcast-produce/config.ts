import { resolve } from 'node:path'
import { audioRoutes } from '../../routes.ts'
import type { AbsConfig } from './abs.ts'
import { type NotifyConfig, notifyConfigFromEnv } from './notify.ts'

// Production's deployment configuration, read once from the process env with audio-gateway's variable names and
// defaults (`src/config.ts`), so a deploy env carries over unchanged. The ElevenLabs voice settings shared with the
// door (`TTS_ELEVENLABS_STYLE`, `TTS_ELEVENLABS_SIMILARITY`) and the synth concurrency (`TTS_CONCURRENCY`) are the audio
// config's (`packages/audio/src/config.ts`). No model id lives here: the TTS model is a route of the audio table.

export interface ProduceConfig {
  /**
   * The synth route (`PODCAST_TTS_MODEL`: a route id or a model id of the audio table; default the Gemini multi-speaker
   * route). A Gemini route runs the multi-speaker lane; an ElevenLabs (`owner/name`) route the per-turn lane.
   */
  ttsRouteId: string
  /** Constant per-host delivery string of the multi-speaker lane (`PODCAST_HOST_STYLE_A`, `PODCAST_HOST_STYLE_B`). */
  hostStyles: [string, string]
  /** Characters per multi-speaker request (`PODCAST_MULTISPEAKER_MAX_CHARS`, 3000). */
  multiSpeakerMaxChars: number
  /** ElevenLabs v3 stability (`PODCAST_STABILITY`, 0.5): the per-turn lane only. */
  stability: number
  /** Number density above which a turn is slowed (`PODCAST_DENSE_TURN_THRESHOLD`, 0.12). */
  denseTurnThreshold: number
  /** Speed delta for such a turn on the per-turn lane (`PODCAST_DENSE_TURN_SLOWDOWN`, 0.06). */
  denseTurnSlowdown: number
  /** MP3 bitrate in kbps (`PODCAST_MP3_BITRATE`, 64). */
  bitrateKbps: number
  /** Silence between turns (`PODCAST_GAP_MS`, 380) and before a short interjection (`PODCAST_SHORT_GAP_MS`, 160). */
  gapMs: number
  shortGapMs: number
  /** The MP3 artist and the Audiobookshelf author (`PODCAST_AUTHOR`, "Hermes"). */
  author: string
  /** The show's description in Audiobookshelf, written only on a new show (`PODCAST_SERIES_DESCRIPTION`). */
  seriesDescription: string
  /** Audiobookshelf (`ABS_URL`, `ABS_API_KEY`, `ABS_LIBRARY` "Podcasts"); null when url or key is unset. */
  abs: AbsConfig | null
  /** The vault checkout the episode note is committed in (`BRAIN_DIR`, absolute); null = no brain note. */
  brainDir: string | null
  /** The Slack notice via Argo (`PODCAST_NOTIFY_CHANNEL`, `ARGO_BASE_URL`, `ARGO_API_SECRET`); null = none. */
  notify: NotifyConfig | null
}

type Env = Record<string, string | undefined>

export const DEFAULT_TTS_ROUTE = 'audio.tts.gemini-flash'
const DEFAULT_SERIES_DESCRIPTION =
  'Zwei Hosts nehmen Notizen aus dem Brain auseinander: Pläne, Recherchen, Entscheidungen — als Gespräch zum Anhören, mit Kapiteln.'

function num(env: Env, key: string, fallback: number): number {
  const raw = env[key]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value)) throw new Error(`${key} must be a number, got "${raw}"`)
  return value
}

const withHttpsScheme = (url: string): string => (url === '' || /^https?:\/\//.test(url) ? url : `https://${url}`)

/** `PODCAST_TTS_MODEL` as a route id of a TTS lane: a route id as is, a model id through the table. */
export function ttsRouteFor(value: string, env: Env = process.env): string {
  const routes = Object.values(audioRoutes(env)).filter((r) => r.lane === 'gemini' || r.lane === 'replicate')
  const route = routes.find((r) => r.id === value) ?? routes.find((r) => r.model === value)
  if (!route) {
    throw new Error(`PODCAST_TTS_MODEL "${value}" is neither a TTS route id nor the model of one (audio route table)`)
  }
  return route.id
}

export function produceConfigFromEnv(env: Env = process.env): ProduceConfig {
  const absUrl = withHttpsScheme((env.ABS_URL ?? '').trim().replace(/\/+$/, ''))
  const absApiKey = (env.ABS_API_KEY ?? '').trim()
  const brainDir = (env.BRAIN_DIR ?? '').trim().replace(/\/+$/, '')
  return {
    ttsRouteId: ttsRouteFor(env.PODCAST_TTS_MODEL?.trim() || DEFAULT_TTS_ROUTE, env),
    hostStyles: [
      env.PODCAST_HOST_STYLE_A ?? 'warm, conversational',
      env.PODCAST_HOST_STYLE_B ?? 'warm, conversational',
    ],
    multiSpeakerMaxChars: num(env, 'PODCAST_MULTISPEAKER_MAX_CHARS', 3000),
    stability: num(env, 'PODCAST_STABILITY', 0.5),
    denseTurnThreshold: num(env, 'PODCAST_DENSE_TURN_THRESHOLD', 0.12),
    denseTurnSlowdown: num(env, 'PODCAST_DENSE_TURN_SLOWDOWN', 0.06),
    bitrateKbps: num(env, 'PODCAST_MP3_BITRATE', 64),
    gapMs: num(env, 'PODCAST_GAP_MS', 380),
    shortGapMs: num(env, 'PODCAST_SHORT_GAP_MS', 160),
    author: env.PODCAST_AUTHOR ?? 'Hermes',
    seriesDescription: env.PODCAST_SERIES_DESCRIPTION ?? DEFAULT_SERIES_DESCRIPTION,
    abs: absUrl && absApiKey ? { url: absUrl, apiKey: absApiKey, library: env.ABS_LIBRARY ?? 'Podcasts' } : null,
    brainDir: brainDir ? resolve(brainDir) : null,
    notify: notifyConfigFromEnv(env),
  }
}

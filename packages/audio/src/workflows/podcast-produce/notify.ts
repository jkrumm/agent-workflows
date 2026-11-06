import { log, messageOf } from './log.ts'

// The podcast notice: announce a finished (or failed) podcast job as an ntfy message (`POST <NTFY_URL>/updates`).
// Best effort: a failed announcement is reported in the result and never fails the job. The config is injected.

const NTFY_TIMEOUT_MS = 15_000
const NTFY_TOPIC = 'updates'

/** `url` is the ntfy base without trailing slash; `token` is the bearer token of the publish user. */
export interface NotifyConfig {
  url: string
  token: string
}

/** What one notice carries. `title` is plain ASCII (it travels as a header); `click` opens on tap. */
export interface PodcastNotice {
  title: string
  body: string
  tags: string
  click?: string
}

/** The notify config from the environment, or null when the notice is off: `NTFY_URL` or `NTFY_TOKEN` unset. */
export function notifyConfigFromEnv(env: Record<string, string | undefined>): NotifyConfig | null {
  const url = (env.NTFY_URL ?? '').trim().replace(/\/+$/, '')
  const token = env.NTFY_TOKEN ?? ''
  if (!url || !token) return null
  return { url, token }
}

/** The notice for a finished episode — one line, the listener wants the link (the click target), not the JSON. */
export function podcastDoneNotice(params: {
  title: string
  durationSeconds: number
  chapterCount: number
  absUrl: string | null
  /** Summed over every billed call in the job: ElevenLabs characters AND the writers' room LLM tokens (one running total, no split). */
  costUsd: number | null
  publishRequested: boolean
  /** The upload's error when publishing was requested, configured and still failed; null otherwise. */
  publishError: string | null
}): PodcastNotice {
  const minutes = Math.round(params.durationSeconds / 60)
  const state = params.absUrl
    ? 'Anhören in Audiobookshelf.'
    : params.publishError
      ? `Produziert, Veröffentlichung fehlgeschlagen (${params.publishError}) — /publish wiederholt nur den Upload.`
      : params.publishRequested
        ? 'Nicht veröffentlicht: Audiobookshelf ist auf diesem Gateway nicht konfiguriert.'
        : 'Nicht veröffentlicht (nicht angefordert) — die Datei liegt auf dem Gateway.'
  const parts = [
    `${params.title}: ${minutes} min, ${params.chapterCount} Kapitel.`,
    state,
    params.costUsd != null ? `Kosten: ${params.costUsd.toFixed(2)} USD` : '',
  ]
  return {
    title: 'Podcast fertig',
    body: parts.filter(Boolean).join(' '),
    tags: 'headphones',
    ...(params.absUrl ? { click: params.absUrl } : {}),
  }
}

/** The notice for a failed episode: the error message, cut to 500 characters. */
export function podcastFailureNotice(error: unknown): PodcastNotice {
  return { title: 'Podcast fehlgeschlagen', body: messageOf(error).slice(0, 500), tags: 'warning' }
}

/**
 * Publish a job's outcome to ntfy. Never throws: a failed announcement is logged and reported as `{ sent: false, error }`.
 */
export async function notifyPodcastResult(
  config: NotifyConfig,
  notice: PodcastNotice,
  fetchImpl: typeof fetch = fetch,
): Promise<{ sent: boolean; error: string | null }> {
  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${config.token}`,
      Title: notice.title,
      Tags: notice.tags,
    }
    if (notice.click) headers.Click = notice.click
    const res = await fetchImpl(`${config.url}/${NTFY_TOPIC}`, {
      method: 'POST',
      headers,
      body: notice.body,
      signal: AbortSignal.timeout(NTFY_TIMEOUT_MS),
    })
    if (!res.ok) {
      const error = `HTTP ${res.status} ${(await res.text()).slice(0, 200)}`.trim()
      log.warn('podcast notify failed', { status: res.status, error })
      return { sent: false, error }
    }
    return { sent: true, error: null }
  } catch (err) {
    const error = messageOf(err)
    log.warn('podcast notify failed', { error })
    return { sent: false, error }
  }
}

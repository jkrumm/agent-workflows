import { log, messageOf } from './log.ts'

// Ports podcastDoneMessage, resolveNotifyChannel and notifyPodcastResult from audio-gateway/src/podcasts.ts (and the
// PODCAST_NOTIFY_CHANNEL / ARGO_* env derivation of its config.ts): announce a finished (or failed) podcast job in a Slack
// channel via Argo. Best effort: a failed announcement is reported in the result and never fails the job. The config is
// injected; the only module state is the per-process channel-name → id cache.

const ARGO_TIMEOUT_MS = 15_000

/** Slack ids look like `C0AS5GUH5U4`; anything else is a channel name to resolve. */
const SLACK_ID_RE = /^[CGD][A-Z0-9]{8,}$/

/** `channel` is a Slack channel name (`media`, `#media`) or id; `argoBaseUrl` has no trailing slash. */
export interface NotifyConfig {
  channel: string
  argoBaseUrl: string
  argoApiSecret: string
}

/**
 * The notify config from the environment, or null when the announcement is off: `PODCAST_NOTIFY_CHANNEL` unset, or no
 * Argo base (`ARGO_BASE_URL`, else `USAGE_HTTP_URL` minus its `/usage/records` suffix) or `ARGO_API_SECRET`.
 */
export function notifyConfigFromEnv(env: Record<string, string | undefined>): NotifyConfig | null {
  const channel = (env.PODCAST_NOTIFY_CHANNEL ?? '').trim()
  const argoBaseUrl = (env.ARGO_BASE_URL ?? (env.USAGE_HTTP_URL ?? '').replace(/\/usage\/records\/?$/, '')).replace(
    /\/+$/,
    '',
  )
  const argoApiSecret = env.ARGO_API_SECRET ?? ''
  if (!channel || !argoBaseUrl || !argoApiSecret) return null
  return { channel, argoBaseUrl, argoApiSecret }
}

/** The Slack line for a finished episode — the listener wants the link, not the JSON. */
export function podcastDoneMessage(params: {
  title: string
  durationSeconds: number
  chapters: string[]
  absUrl: string | null
  /** Summed over every billed call in the job: ElevenLabs characters AND the writers' room LLM tokens (one running total, no split). */
  costUsd: number | null
  publishRequested: boolean
  /** The upload's error when publishing was requested, configured and still failed; null otherwise. */
  publishError: string | null
  format: string
  lead: 'A' | 'B' | 'balanced'
  humor: string
  /** [host A name, host B name] — `lead` maps onto one of these. */
  hostNames: [string, string]
}): string {
  const minutes = Math.round(params.durationSeconds / 60)
  const leadLabel =
    params.lead === 'A'
      ? `${params.hostNames[0]} führt`
      : params.lead === 'B'
        ? `${params.hostNames[1]} führt`
        : 'ausgeglichen'
  const lines = [
    `Podcast fertig: *${params.title}* (${minutes} min, ${params.chapters.length} Kapitel)`,
    `Format: ${params.format} · ${leadLabel} · ${params.humor}`,
    ...params.chapters.map((c) => `• ${c}`),
    params.absUrl
      ? `Anhören in Audiobookshelf: ${params.absUrl}`
      : params.publishError
        ? `Produziert, Veröffentlichung fehlgeschlagen (${params.publishError}) — /publish wiederholt nur den Upload.`
        : params.publishRequested
          ? 'Nicht veröffentlicht: Audiobookshelf ist auf diesem Gateway nicht konfiguriert.'
          : 'Nicht veröffentlicht (nicht angefordert) — die Datei liegt auf dem Gateway.',
    params.costUsd != null ? `Kosten: ${params.costUsd.toFixed(2)} USD` : '',
  ]
  return lines.filter(Boolean).join('\n')
}

const resolvedChannelIds = new Map<string, string>()

/**
 * Turn `config.channel` into a channel id via Argo's channel list (`GET /slack/channels` → `[{ id, name }]`), once per
 * process and channel name. An id passes through; null when the channel is empty. Throws when Argo is unreachable, answers
 * non-2xx, or knows no such channel.
 */
export async function resolveNotifyChannel(
  config: NotifyConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const wanted = config.channel.trim().replace(/^#/, '')
  if (!wanted) return null
  if (SLACK_ID_RE.test(wanted)) return wanted
  const cached = resolvedChannelIds.get(wanted)
  if (cached) return cached
  if (!config.argoBaseUrl) {
    log.warn('podcast notify: channel is a name but no Argo base URL is configured', { channel: wanted })
    return null
  }
  const res = await fetchImpl(`${config.argoBaseUrl}/slack/channels`, {
    headers: { Authorization: `Bearer ${config.argoApiSecret}` },
    signal: AbortSignal.timeout(ARGO_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`Argo channel list failed: HTTP ${res.status}`)
  const channels = (await res.json()) as Array<{ id?: string; name?: string }>
  const match = channels.find((c) => (c.name ?? '').toLowerCase() === wanted.toLowerCase())
  if (!match?.id) throw new Error(`Argo knows no Slack channel named "${wanted}"`)
  resolvedChannelIds.set(wanted, match.id)
  return match.id
}

/**
 * Announce a job's outcome in the configured Slack channel via Argo. Never throws: a failed announcement is logged and
 * reported as `{ sent: false, error }`; an empty channel is `{ sent: false, error: null }`.
 */
export async function notifyPodcastResult(
  config: NotifyConfig,
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ sent: boolean; error: string | null }> {
  try {
    const channelId = await resolveNotifyChannel(config, fetchImpl)
    if (!channelId) return { sent: false, error: null }
    const res = await fetchImpl(`${config.argoBaseUrl}/slack/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${config.argoApiSecret}` },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(ARGO_TIMEOUT_MS),
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

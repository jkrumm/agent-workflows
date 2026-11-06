import type { Logger } from '@agent-workflows/runtime'
import type { OverviewOutput, OverviewPayload } from './schema.ts'

// The fleet view in Argo (the personal API and dashboard), so it exists somewhere other than this host: after every
// completed `overview` run and every ten minutes from a timer. The body is exactly the `agw agents` payload plus
// `machine`: one producer, no second shape to drift. Never fatal; one log line per outcome.

const PUSH_TIMEOUT_MS = 15_000
export const PUSH_INTERVAL_MS = 10 * 60_000

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/** The bearer must never cross a network in clear text: https, or http on loopback. */
function safeBase(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || (parsed.protocol === 'http:' && LOOPBACK.has(parsed.hostname))
  } catch {
    return false
  }
}

export type ArgoPushStatus = 'ok' | 'disabled' | 'skipped' | 'http-error' | 'network-error' | 'build-error'

export interface ArgoPushOptions {
  /** `ARGO_URL`, the API base (it already ends in `/api`). Unset: pushing is off. */
  url: string | undefined
  /** `ARGO_API_SECRET`, the bearer. Unset: pushing is off. */
  secret: string | undefined
  /** The host's `AGW_MACHINE`. */
  machine: string
  /**
   * The payload to post; with `overview`, the one just completed run stands in for the stored one. `unreadable` is the
   * warning of a failed factory read: the payload is then empty, and posting it would replace Argo's last good fleet.
   */
  build: (overview?: OverviewOutput) => Promise<{ payload: OverviewPayload; unreadable?: string | null }>
  logger: Pick<Logger, 'warn'> & { info?: (message: string, meta?: Record<string, unknown>) => void }
  fetcher?: typeof fetch
}

export interface ArgoPush {
  /** One push; resolves to the outcome, never rejects. `trigger` is only for the log line. */
  push(trigger: 'run' | 'timer', overview?: OverviewOutput): Promise<ArgoPushStatus>
}

type ArgoLogger = ArgoPushOptions['logger']

/**
 * The one transport of every Argo push: the https-or-loopback check, the bearer, no redirects, a timeout, and the
 * disabled reason logged once. `post` never rejects.
 */
function createTransport(options: {
  url: string | undefined
  secret: string | undefined
  logger: ArgoLogger
  fetcher?: typeof fetch
}) {
  const fetcher = options.fetcher ?? fetch
  const base = options.url?.trim().replace(/\/+$/, '')
  const secret = options.secret?.trim()
  let disabledLogged = false

  return {
    /** False when pushing is off (no URL, no secret, or an unsafe URL); the first call says why. */
    enabled(meta: Record<string, unknown> = {}): boolean {
      if (base && secret && safeBase(base)) return true
      if (!disabledLogged) {
        disabledLogged = true
        options.logger.warn('argo push off: ARGO_URL (https) or ARGO_API_SECRET is not set', {
          event: 'argo_push',
          status: 'disabled',
          ...meta,
        })
      }
      return false
    },
    async post(
      path: string,
      body: string,
    ): Promise<
      { kind: 'response'; status: number; ok: boolean; durationMs: number } | { kind: 'error'; error: string }
    > {
      const started = performance.now()
      try {
        const res = await fetcher(`${base}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
          body,
          signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
          // A redirect would re-send the bearer to wherever it points.
          redirect: 'error',
        })
        return { kind: 'response', status: res.status, ok: res.ok, durationMs: Math.round(performance.now() - started) }
      } catch (error) {
        return { kind: 'error', error: String(error) }
      }
    },
  }
}

export function createArgoPush(options: ArgoPushOptions): ArgoPush {
  const { logger } = options
  const transport = createTransport(options)
  const info = (message: string, meta: Record<string, unknown>) => logger.info?.(message, meta)

  return {
    async push(trigger, overview) {
      if (!transport.enabled()) return 'disabled'
      let body: string
      let agents = 0
      try {
        const { payload, unreadable } = await options.build(overview)
        if (unreadable) {
          logger.warn('argo push skipped: the factory could not be read, Argo keeps its last snapshot', {
            event: 'argo_push',
            status: 'skipped',
            trigger,
            warning: unreadable,
          })
          return 'skipped'
        }
        agents = payload.projects.reduce((n, p) => n + p.agents.length, 0)
        body = JSON.stringify({ ...payload, machine: options.machine, generatedAt: payload.generatedAt })
      } catch (error) {
        logger.warn('overview payload could not be built; argo push skipped', {
          event: 'argo_push',
          status: 'build-error',
          trigger,
          error: String(error),
        })
        return 'build-error'
      }

      const result = await transport.post('/agents/overview', body)
      if (result.kind === 'error') {
        logger.warn('argo push failed', { event: 'argo_push', status: 'network-error', trigger, error: result.error })
        return 'network-error'
      }
      const { status, durationMs } = result
      if (!result.ok) {
        logger.warn(`argo push rejected with ${status}`, {
          event: 'argo_push',
          status: 'http-error',
          httpStatus: status,
          trigger,
          durationMs,
        })
        return 'http-error'
      }
      info('argo push ok', { event: 'argo_push', status: 'ok', httpStatus: status, trigger, agents, durationMs })
      return 'ok'
    },
  }
}

export interface ReviewStatsPushOptions {
  url: string | undefined
  secret: string | undefined
  machine: string
  /** The weekly numbers to post: `weeklyReviewStats` over the review service. */
  build: () => Promise<{ weeks: unknown[]; byPrompt: unknown[] }>
  logger: ArgoLogger
  fetcher?: typeof fetch
  now?: () => number
}

const REVIEW_STATS_TARGET = 'review-stats'
const REVIEW_STATS_SOURCE = 'agw review stats --bucket week --by tier'

/**
 * The weekly review numbers in Argo: after every `agw review submit` and every ten minutes. Same transport and
 * off-switch as the overview push; an Argo without the endpoint (404) is one warning per push, never a failure.
 */
export function createReviewStatsPush(options: ReviewStatsPushOptions): Pick<ArgoPush, 'push'> {
  const { logger } = options
  const transport = createTransport(options)
  const now = options.now ?? Date.now
  const tag = { event: 'argo_push', target: REVIEW_STATS_TARGET }

  return {
    async push(trigger) {
      if (!transport.enabled({ target: REVIEW_STATS_TARGET })) return 'disabled'
      let body: string
      try {
        const { weeks, byPrompt } = await options.build()
        body = JSON.stringify({
          machine: options.machine,
          generatedAt: now(),
          source: REVIEW_STATS_SOURCE,
          weeks,
          byPrompt,
        })
      } catch (error) {
        logger.warn('review stats could not be built; argo push skipped', {
          ...tag,
          status: 'build-error',
          trigger,
          error: String(error),
        })
        return 'build-error'
      }

      const result = await transport.post('/agents/review-stats', body)
      if (result.kind === 'error') {
        logger.warn('argo review-stats push failed', { ...tag, status: 'network-error', trigger, error: result.error })
        return 'network-error'
      }
      if (!result.ok) {
        logger.warn(`argo review-stats push rejected with ${result.status}`, {
          ...tag,
          status: 'http-error',
          httpStatus: result.status,
          trigger,
          durationMs: result.durationMs,
        })
        return 'http-error'
      }
      logger.info?.('argo review-stats push ok', {
        ...tag,
        status: 'ok',
        httpStatus: result.status,
        trigger,
        durationMs: result.durationMs,
      })
      return 'ok'
    },
  }
}

/** Calls `tick` every `ms` until the returned stop is called; tests drive ticks by hand. */
export type Ticker = (tick: () => void, ms: number) => () => void

const intervalTicker: Ticker = (tick, ms) => {
  const timer = setInterval(tick, ms)
  return () => clearInterval(timer)
}

/**
 * Pushes every `intervalMs` while the host runs. A tick that finds the last push still in flight is skipped, so a slow
 * Argo never stacks pushes. Stopping clears the timer; an in-flight push finishes on its own.
 */
export function startArgoSchedule(options: { push: Pick<ArgoPush, 'push'>; intervalMs?: number; ticker?: Ticker }): {
  stop(): void
} {
  let pushing = false
  const stop = (options.ticker ?? intervalTicker)(() => {
    if (pushing) return
    pushing = true
    void options.push.push('timer').finally(() => {
      pushing = false
    })
  }, options.intervalMs ?? PUSH_INTERVAL_MS)
  return { stop }
}

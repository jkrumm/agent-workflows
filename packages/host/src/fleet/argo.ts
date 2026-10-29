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

export type ArgoPushStatus = 'ok' | 'disabled' | 'http-error' | 'network-error' | 'build-error'

export interface ArgoPushOptions {
  /** `ARGO_URL`, the API base (it already ends in `/api`). Unset: pushing is off. */
  url: string | undefined
  /** `ARGO_API_SECRET`, the bearer. Unset: pushing is off. */
  secret: string | undefined
  /** The host's `AGW_MACHINE`. */
  machine: string
  /** The payload to post; with `overview`, the one just completed run stands in for the stored one. */
  build: (overview?: OverviewOutput) => Promise<OverviewPayload>
  logger: Pick<Logger, 'warn'> & { info?: (message: string, meta?: Record<string, unknown>) => void }
  fetcher?: typeof fetch
}

export interface ArgoPush {
  /** One push; resolves to the outcome, never rejects. `trigger` is only for the log line. */
  push(trigger: 'run' | 'timer', overview?: OverviewOutput): Promise<ArgoPushStatus>
}

export function createArgoPush(options: ArgoPushOptions): ArgoPush {
  const { logger } = options
  const fetcher = options.fetcher ?? fetch
  const base = options.url?.trim().replace(/\/+$/, '')
  const secret = options.secret?.trim()
  const info = (message: string, meta: Record<string, unknown>) => logger.info?.(message, meta)
  let disabledLogged = false

  return {
    async push(trigger, overview) {
      if (!base || !secret || !safeBase(base)) {
        if (!disabledLogged) {
          disabledLogged = true
          logger.warn('argo push off: ARGO_URL (https) or ARGO_API_SECRET is not set', {
            event: 'argo_push',
            status: 'disabled',
          })
        }
        return 'disabled'
      }
      let body: string
      let agents = 0
      try {
        const payload = await options.build(overview)
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

      const started = performance.now()
      try {
        const res = await fetcher(`${base}/agents/overview`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
          body,
          signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
          // A redirect would re-send the bearer to wherever it points.
          redirect: 'error',
        })
        const durationMs = Math.round(performance.now() - started)
        if (!res.ok) {
          logger.warn(`argo push rejected with ${res.status}`, {
            event: 'argo_push',
            status: 'http-error',
            httpStatus: res.status,
            trigger,
            durationMs,
          })
          return 'http-error'
        }
        info('argo push ok', { event: 'argo_push', status: 'ok', httpStatus: res.status, trigger, agents, durationMs })
        return 'ok'
      } catch (error) {
        logger.warn('argo push failed', { event: 'argo_push', status: 'network-error', trigger, error: String(error) })
        return 'network-error'
      }
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

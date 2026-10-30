import { type ResolvedRoute, type RouteId, resolveRoute } from '@agent-workflows/routes'
import type { Env } from '../transports/config.ts'
import { DEFAULTS, type HttpOptions } from '../transports/http.ts'

/** The image seats of the route table (`packages/routes/src/table/image.ts`). */
export type ImageRouteId = Extract<RouteId, `image.${string}`>

/**
 * The whole-stream ceiling: a hang guard, not a budget. 30 minutes is the agent-limits rule's minimum for a single
 * non-agentic request (a short timeout on a slow answer only turns it into a failure).
 */
export const STREAM_MAX_MS = 30 * 60_000

/** What the image capabilities are built from. Every field defaults to production; tests inject fakes. */
export interface ImageDeps {
  /** Where `IU_API_KEY`, `IU_BASE_URL` and the optional `REPLICATE_BASE_URL` are read, on each call. Default `process.env`. */
  env?: Env
  fetch?: (url: string, init: RequestInit) => Promise<Response>
  /** Retry knobs of the package's helper (`withRetries`); tests set `backoffMs: 0`. */
  retry?: Pick<HttpOptions, 'attempts' | 'backoffMs'>
  /** The route of an image seat. Default: the route table with `AGW_ROUTES` applied, read from `env`. */
  route?: (id: ImageRouteId) => ResolvedRoute
  /** Wait between Replicate polls. Default 1 s. */
  pollMs?: number
  /** A streamed image request is aborted after this long without a byte from the endpoint (a hang guard, never a budget). Default 30 minutes. */
  streamIdleMs?: number
  /** A streamed image request is aborted after this long in all, whatever arrives (a hang guard, never a budget). Default 30 minutes. */
  streamMaxMs?: number
}

export interface ResolvedImageDeps {
  env: () => Env
  fetch: (url: string, init: RequestInit) => Promise<Response>
  retry: Pick<HttpOptions, 'attempts' | 'backoffMs'>
  route: (id: ImageRouteId) => ResolvedRoute
  pollMs: number
  streamIdleMs: number
  streamMaxMs: number
}

export function resolveImageDeps(deps: ImageDeps = {}): ResolvedImageDeps {
  return {
    env: () => deps.env ?? process.env,
    fetch: deps.fetch ?? ((url, init) => fetch(url, init)),
    retry: deps.retry ?? {},
    route: deps.route ?? ((id) => resolveRoute(id, deps.env ?? process.env)),
    pollMs: deps.pollMs ?? 1_000,
    streamIdleMs: deps.streamIdleMs ?? DEFAULTS.hangGuardMs,
    streamMaxMs: deps.streamMaxMs ?? STREAM_MAX_MS,
  }
}

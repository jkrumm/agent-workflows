import { type ResolvedRoute, type RouteId, resolveRoute } from '@agent-workflows/routes'
import type { Env } from '../transports/config.ts'
import type { HttpOptions } from '../transports/http.ts'

/** The image seats of the route table (`packages/routes/src/table/image.ts`). */
export type ImageRouteId = Extract<RouteId, `image.${string}`>

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
}

export interface ResolvedImageDeps {
  env: () => Env
  fetch: (url: string, init: RequestInit) => Promise<Response>
  retry: Pick<HttpOptions, 'attempts' | 'backoffMs'>
  route: (id: ImageRouteId) => ResolvedRoute
  pollMs: number
}

export function resolveImageDeps(deps: ImageDeps = {}): ResolvedImageDeps {
  return {
    env: () => deps.env ?? process.env,
    fetch: deps.fetch ?? ((url, init) => fetch(url, init)),
    retry: deps.retry ?? {},
    route: deps.route ?? ((id) => resolveRoute(id, deps.env ?? process.env)),
    pollMs: deps.pollMs ?? 1_000,
  }
}

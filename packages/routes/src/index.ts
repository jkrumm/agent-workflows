import { createHash } from 'node:crypto'
import { applyPatch, OVERRIDES_ENV, RouteOverrideError, readOverrides } from './overrides.ts'
import { DEFAULT_ROUTES } from './registry.ts'
import type { ResolvedRoute, RouteEntry, RouteId } from './schema.ts'

export { BALANCE_MARKER, isBalanceFailure } from './balance.ts'
export {
  type Price,
  type PriceUsage,
  priceCall,
  priceSchema,
  type Unit,
  UNITS,
  type UnitPrice,
  type UnitsUsed,
} from './price.ts'
export { type Cost, costFromUsage, type ProviderUsage } from './cost.ts'
export { OVERRIDES_ENV, RouteOverrideError } from './overrides.ts'
export { DEFAULT_ROUTES, discoverRoutes } from './registry.ts'
export {
  EFFORTS,
  type Effort,
  type FallbackEntry,
  type Rate,
  type ResolvedRoute,
  type RouteEntry,
  type RouteTable,
  routeSchema,
  WIRES,
  type Wire,
} from './schema.ts'
export type { RouteId }

type Env = Record<string, string | undefined>

export class UnknownRouteError extends Error {
  readonly code = 'unknown_route'
  constructor(readonly routeId: string) {
    super(`unknown route "${routeId}" (known: ${Object.keys(DEFAULT_ROUTES).join(', ')})`)
    this.name = 'UnknownRouteError'
  }
}

export function routeIds(): RouteId[] {
  return Object.keys(DEFAULT_ROUTES) as RouteId[]
}

/** Every override applied to its table entry and validated whole; throws `RouteOverrideError` on the first bad one. */
function patchedEntries(env: Env): Map<string, RouteEntry> {
  const resolved = new Map<string, RouteEntry>()
  for (const [patchId, patch] of Object.entries(readOverrides(env))) {
    const base = isRouteId(patchId) ? DEFAULT_ROUTES[patchId] : undefined
    if (!base) throw new RouteOverrideError(`unknown route "${patchId}" (known: ${routeIds().join(', ')})`)
    resolved.set(patchId, applyPatch(patchId, base, patch))
  }
  return resolved
}

/**
 * Check `AGW_ROUTES` once, whole: it parses as JSON, has the override shape, and every patch (including one for an id
 * that is not in the table) is valid over its table entry. Returns the ids the override touches (all table ids).
 * A failure is a `RouteOverrideError` naming the route id and the problem; it never carries the parser's own message
 * (it quotes the input) or an override value. It can name ids and keys taken from the file, which are not values. Unset or blank means no overrides.
 */
export function validateOverrides(env: Env = process.env): RouteId[] {
  return [...patchedEntries(env).keys()] as RouteId[]
}

/**
 * A copy of the entry for a route id, with `AGW_ROUTES` applied; mutating it changes nothing shared.
 * Throws `UnknownRouteError` for an id that is not in the table (only reachable from untyped callers)
 * and `RouteOverrideError` for a malformed or invalid override, including one that names an unknown
 * route. Every patch is checked, not only the requested one.
 */
export function resolveRoute(id: RouteId, env: Env = process.env): ResolvedRoute {
  const entry = patchedEntries(env).get(id) ?? (isRouteId(id) ? DEFAULT_ROUTES[id] : undefined)
  if (!entry) throw new UnknownRouteError(id)
  return { id, ...structuredClone(entry) }
}

/**
 * The route's provider-balance fallback as a route of its own (same id, `isFallback`, no further fallback), or
 * `undefined` when the route has none. Overrides are already in `route`: pass what `resolveRoute` returned.
 */
export function fallbackRoute(route: ResolvedRoute): ResolvedRoute | undefined {
  if (!route.fallback) return undefined
  return { id: route.id, ...structuredClone(route.fallback), isFallback: true }
}

function isRouteId(id: string): id is RouteId {
  return Object.hasOwn(DEFAULT_ROUTES, id)
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** Stable sha256 (hex) of the resolved entry, overrides included; one input of the run fingerprint (§5). */
export function routeFingerprint(id: RouteId, env: Env = process.env): string {
  return createHash('sha256')
    .update(canonical(resolveRoute(id, env)))
    .digest('hex')
}

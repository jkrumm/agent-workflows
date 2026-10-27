import { createHash } from 'node:crypto'
import { applyPatch, RouteOverrideError, readOverrides } from './overrides.ts'
import type { ResolvedRoute, RouteEntry } from './schema.ts'
import { DEFAULT_ROUTES } from './table.ts'

export { type Cost, costFromUsage, type ProviderUsage } from './cost.ts'
export { OVERRIDES_ENV, RouteOverrideError } from './overrides.ts'
export {
  EFFORTS,
  type Effort,
  type Rate,
  type ResolvedRoute,
  type RouteEntry,
  routeSchema,
  WIRES,
  type Wire,
} from './schema.ts'
export { DEFAULT_ROUTES }

type Env = Record<string, string | undefined>

export class UnknownRouteError extends Error {
  readonly code = 'unknown_route'
  constructor(readonly routeId: string) {
    super(`unknown route "${routeId}" (known: ${Object.keys(DEFAULT_ROUTES).join(', ')})`)
    this.name = 'UnknownRouteError'
  }
}

export function routeIds(): string[] {
  return Object.keys(DEFAULT_ROUTES)
}

/**
 * The entry for a route id, with `AGW_ROUTES` applied. Throws `UnknownRouteError` for an id that is
 * not in the table (also when only the override names it) and `RouteOverrideError` for a malformed
 * or invalid override, whichever route is being resolved (every patch is checked, not only the requested one).
 */
export function resolveRoute(id: string, env: Env = process.env): ResolvedRoute {
  const patches = readOverrides(env)
  const resolved = new Map<string, RouteEntry>()
  for (const [patchId, patch] of Object.entries(patches)) {
    const base = Object.hasOwn(DEFAULT_ROUTES, patchId) ? DEFAULT_ROUTES[patchId] : undefined
    if (!base) throw new RouteOverrideError(`unknown route "${patchId}" (known: ${routeIds().join(', ')})`)
    resolved.set(patchId, applyPatch(patchId, base, patch))
  }
  const entry = resolved.get(id) ?? (Object.hasOwn(DEFAULT_ROUTES, id) ? DEFAULT_ROUTES[id] : undefined)
  if (!entry) throw new UnknownRouteError(id)
  return { id, ...entry }
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
export function routeFingerprint(id: string, env: Env = process.env): string {
  return createHash('sha256')
    .update(canonical(resolveRoute(id, env)))
    .digest('hex')
}

import { type FallbackPatch, overridesSchema, type RouteEntry, type RoutePatch, routeSchema } from './schema.ts'

/** One JSON object: `{"<route id>": {"model"?, "effort"?, "maxOutputTokens"?, "rate"?, "fallback"?}}`. */
export const OVERRIDES_ENV = 'AGW_ROUTES'

export class RouteOverrideError extends Error {
  readonly code = 'route_override_invalid'
  constructor(message: string) {
    super(`${OVERRIDES_ENV}: ${message}`)
    this.name = 'RouteOverrideError'
  }
}

/** Parse and shape-check the override variable. Unset or blank means no overrides. */
export function readOverrides(env: Record<string, string | undefined>): Record<string, RoutePatch> {
  const raw = env[OVERRIDES_ENV]?.trim()
  if (!raw) return {}
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    // The parser's own message quotes the text it choked on, which may be a value: say only that it is not JSON.
    throw new RouteOverrideError('not valid JSON')
  }
  const parsed = overridesSchema.safeParse(json)
  if (!parsed.success) throw new RouteOverrideError(parsed.error.message)
  return parsed.data
}

/**
 * Merge a patch over a table entry and validate the result like a table entry. `null` clears an
 * optional field. A new model without a new rate drops the old rate: a stale rate would price the
 * new model wrongly, and `unknown` cost is visible where a wrong number is not. A `fallback` patch is
 * merged over the entry's fallback by the same rules; `fallback: null` removes it, and a route without
 * a fallback cannot gain one here (its wire is code).
 */
export function applyPatch(id: string, base: RouteEntry, patch: RoutePatch): RouteEntry {
  const { fallback, ...own } = patch
  const merged = merge(base, own)
  if (fallback === null) delete merged.fallback
  else if (fallback !== undefined) {
    if (!base.fallback) throw new RouteOverrideError(`route "${id}" has no fallback to patch`)
    merged.fallback = merge(base.fallback, fallback)
  }
  const parsed = routeSchema.safeParse(merged)
  if (!parsed.success) throw new RouteOverrideError(`route "${id}": ${parsed.error.message}`)
  return parsed.data
}

function merge(base: Record<string, unknown>, patch: FallbackPatch): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete merged[key]
    else if (value !== undefined) merged[key] = value
  }
  if (patch.model !== undefined && patch.model !== base.model && patch.rate === undefined) delete merged.rate
  if (patch.model !== undefined && patch.model !== base.model && patch.price === undefined) delete merged.price
  return merged
}

import { overridesSchema, type RouteEntry, type RoutePatch, routeSchema } from './schema.ts'

/** One JSON object: `{"<route id>": {"model"?, "effort"?, "wire"?, "maxOutputTokens"?, "rate"?}}`. */
export const OVERRIDES_ENV = 'AGW_ROUTES'

export class RouteOverrideError extends Error {
  readonly code = 'route_override_invalid'
  constructor(message: string) {
    super(`${OVERRIDES_ENV}: ${message}`)
    this.name = 'RouteOverrideError'
  }
}

let cache: { raw: string; patches: Record<string, RoutePatch> } | undefined

/** Parse and shape-check the override variable. Unset or blank means no overrides. */
export function readOverrides(env: Record<string, string | undefined>): Record<string, RoutePatch> {
  const raw = env[OVERRIDES_ENV]?.trim()
  if (!raw) return {}
  if (cache?.raw === raw) return cache.patches
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (err) {
    throw new RouteOverrideError(`not valid JSON (${err instanceof Error ? err.message : String(err)})`)
  }
  const parsed = overridesSchema.safeParse(json)
  if (!parsed.success) throw new RouteOverrideError(parsed.error.message)
  cache = { raw, patches: parsed.data }
  return parsed.data
}

/**
 * Merge a patch over a table entry and validate the result like a table entry. `null` clears an
 * optional field. A new model without a new rate drops the old rate: a stale rate would price the
 * new model wrongly, and `unknown` cost is visible where a wrong number is not.
 */
export function applyPatch(id: string, base: RouteEntry, patch: RoutePatch): RouteEntry {
  const merged: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete merged[key]
    else if (value !== undefined) merged[key] = value
  }
  if (patch.model !== undefined && patch.model !== base.model && patch.rate === undefined) delete merged.rate
  const parsed = routeSchema.safeParse(merged)
  if (!parsed.success) throw new RouteOverrideError(`route "${id}": ${parsed.error.message}`)
  return parsed.data
}

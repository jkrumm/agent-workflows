import type { Price } from './price.ts'
import { claudeRate } from './pricing.ts'
import { ROUTE_GROUPS, routeRate } from './rates.ts'
import {
  type FallbackPatch,
  type Rate,
  type RouteEntry,
  type RoutePatch,
  routePatchSchema,
  routeSchema,
} from './schema.ts'
import { z } from 'zod'

/** An arm's `routes`: `{"<route id>": {"model"?, "effort"?, "maxOutputTokens"?, "rate"?, "price"?, "fallback"?}}`. */
export const routesPatchSchema = z.record(z.string(), routePatchSchema)
export type RoutesPatch = z.infer<typeof routesPatchSchema>

/**
 * What a resolver takes as a patch before it is validated: an arm's `routes` as a run carries it (route id to an object
 * of fields), or nothing. Validated on every resolution.
 */
export type PatchInput = { readonly [routeId: string]: object } | null | undefined

export class RouteOverrideError extends Error {
  readonly code = 'route_override_invalid'
  constructor(message: string) {
    super(`arm: ${message}`)
    this.name = 'RouteOverrideError'
  }
}

/**
 * Shape-check a routes patch (an arm's `routes`). `undefined` and `null` mean none. The message is zod's, which names
 * keys and expectations, never a value.
 */
export function parsePatch(raw: PatchInput | unknown): RoutesPatch {
  if (raw === undefined || raw === null) return {}
  const parsed = routesPatchSchema.safeParse(raw)
  if (!parsed.success) throw new RouteOverrideError(parsed.error.message)
  return parsed.data
}

/**
 * Merge a patch over a table entry and validate the result like a table entry. `null` clears an optional field. A new
 * model takes the patch's `rate` (or `price`), else the table's for that model (`routeRate`, `claudeRate`): a stale
 * rate would price the new model wrongly, and a dropped one would leave an armed run unpriced. A model the table
 * prices nowhere needs the patch to carry its price (`rate: null` unprices it on purpose). A `fallback` patch is merged
 * over the entry's fallback by the same rules; `fallback: null` removes it, and a route without a fallback cannot gain
 * one here (its wire is code).
 */
export function applyPatch(id: string, base: RouteEntry, patch: RoutePatch): RouteEntry {
  const { fallback, ...own } = patch
  const merged = merge(`route "${id}"`, base, own)
  if (fallback === null) delete merged.fallback
  else if (fallback !== undefined) {
    if (!base.fallback) throw new RouteOverrideError(`route "${id}" has no fallback to patch`)
    merged.fallback = merge(`route "${id}" fallback`, base.fallback, fallback)
  }
  const parsed = routeSchema.safeParse(merged)
  if (!parsed.success) throw new RouteOverrideError(`route "${id}": ${parsed.error.message}`)
  return parsed.data
}

function merge(label: string, base: Omit<RouteEntry, 'fallback'>, patch: FallbackPatch): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete merged[key]
    else if (value !== undefined) merged[key] = value
  }
  if (patch.model === undefined || patch.model === base.model) return merged
  if (patch.rate === undefined) {
    const rate = tableRate(patch.model)
    if (rate) merged.rate = structuredClone(rate)
    else if (base.rate) throw unpriced(label, 'rate')
    else delete merged.rate
  }
  if (patch.price === undefined) {
    const price = tablePrice(patch.model)
    if (price) merged.price = structuredClone(price)
    else if (base.price) throw unpriced(label, 'price')
    else delete merged.price
  }
  return merged
}

const unpriced = (label: string, field: 'rate' | 'price') =>
  new RouteOverrideError(
    `${label}: the patched model has no ${field} in the route table; the patch must carry one (\`${field}\`)`,
  )

/** The text-token rate the table gives a model: a route's or fallback's, else Claude's list rate (aliases too). */
function tableRate(model: string): Rate | undefined {
  return routeRate(model) ?? claudeRate(model)
}

/** The `price` of any route or fallback naming this model; `undefined` when none carries one. */
function tablePrice(model: string): Price | undefined {
  for (const group of Object.values(ROUTE_GROUPS)) {
    for (const route of Object.values(group)) {
      for (const entry of [route, route.fallback]) if (entry?.model === model && entry.price) return entry.price
    }
  }
  return undefined
}

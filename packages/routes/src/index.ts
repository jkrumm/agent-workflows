import { createHash } from 'node:crypto'
import { PROVIDER_ECHO, TABLE_MODELS } from './models.ts'
import { CLAUDE_MODELS } from './pricing.ts'
import { z } from 'zod'
import { applyPatch, type PatchInput, parsePatch, RouteOverrideError, routesPatchSchema } from './overrides.ts'
import { DEFAULT_ROUTES } from './registry.ts'
import type { ResolvedRoute, RouteEntry, RouteId, RoutePatch, Wire } from './schema.ts'

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
export type { Cost } from './cost.ts'
export {
  BALANCE_MARKER,
  CLAUDE_MODELS,
  type ClaudeRate,
  claudeRate,
  costFromUsage,
  isBalanceFailure,
  type ProviderUsage,
  resolveModelAlias,
} from './pricing.ts'
export { canonicalModel } from './models.ts'
export { type PatchInput, RouteOverrideError, type RoutesPatch, routesPatchSchema } from './overrides.ts'
export { DEFAULT_ROUTES, discoverRoutes } from './registry.ts'
export {
  CONTEXT_LIMITS,
  type ContextLimit,
  EFFORTS,
  type Effort,
  effortsOf,
  type FallbackEntry,
  type Rate,
  type ResolvedRoute,
  type RouteEntry,
  type RoutePatch,
  type RouteTable,
  routeSchema,
  takesEffort,
  WIRES,
  type Wire,
} from './schema.ts'
export type { RouteId }

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

/** An arm (`agw eval run --arm <file>`): route patches and workflow params, layered over one run tree. */
export const armSchema = z.strictObject({
  routes: routesPatchSchema.optional(),
  params: z.record(z.string(), z.json()).optional(),
})
export type Arm = z.infer<typeof armSchema>

let servedOpencodeModels: ReadonlySet<string> | undefined

/**
 * The models the OpenCode server's config serves: every model a route or fallback on the `opencode` wire names in the
 * table, and every Claude model (`CLAUDE_MODELS`), so an arm can move an agent route to any of them. The server is
 * configured from the table once per spawn (`buildServerConfig`), so a patch can move an agent route only among these.
 */
export function opencodeModels(): ReadonlySet<string> {
  servedOpencodeModels ??= new Set([
    ...Object.values(DEFAULT_ROUTES).flatMap((route) =>
      route.wire === 'opencode' ? [route.model, ...(route.fallback ? [route.fallback.model] : [])] : [],
    ),
    ...CLAUDE_MODELS,
  ])
  return servedOpencodeModels
}

/**
 * A patch moves a route only to a model the table names (`TABLE_MODELS`: the routes', the fallbacks', the Claude
 * models), on every wire: the caller's records (`callerRecords`) and the price come from the table, so a new model goes
 * into the table first. On the `opencode` wire the model must also be one the OpenCode server serves (its opencode-wire
 * models and the Claude models), and `rate`, `maxOutputTokens` and `price` cannot be patched: the server's config, built from the table,
 * prices and limits a model, not a route, so a patched one would not reach OpenCode.
 */
function checkModels(id: string, patch: RoutePatch, base: RouteEntry) {
  const parts = [
    ['', patch],
    [' fallback', patch.fallback ?? {}],
  ] as const
  for (const [where, part] of parts) {
    const model = part.model
    if (model !== undefined && !TABLE_MODELS.has(model)) {
      throw new RouteOverrideError(
        `route "${id}"${where}: model "${model}" is not in the route table (add it to the table first)`,
      )
    }
  }
  if (patch.contextLimit != null && base.wire !== 'opencode') {
    throw new RouteOverrideError(
      `route "${id}": contextLimit applies to opencode routes only (this route is on the ${base.wire} wire)`,
    )
  }
  if (base.wire !== 'opencode') return
  for (const [where, part] of parts) {
    for (const key of ['rate', 'maxOutputTokens', 'price'] as const) {
      if (part[key] !== undefined) {
        throw new RouteOverrideError(
          `route "${id}"${where}: ${key} cannot be patched on the opencode wire (the server's config prices and limits each model from the table)`,
        )
      }
    }
    if (part.model !== undefined && !opencodeModels().has(part.model)) {
      throw new RouteOverrideError(
        `route "${id}"${where}: model "${part.model}" is not served by the OpenCode server (it serves the opencode-wire models of the route table and every Claude model)`,
      )
    }
  }
}

/** Every patch applied to its table entry and validated whole; throws `RouteOverrideError` on the first bad one. */
function patchedEntries(raw: unknown): Map<string, RouteEntry> {
  const resolved = new Map<string, RouteEntry>()
  for (const [patchId, patch] of Object.entries(parsePatch(raw))) {
    const base = isRouteId(patchId) ? DEFAULT_ROUTES[patchId] : undefined
    if (!base) throw new RouteOverrideError(`unknown route "${patchId}" (known: ${routeIds().join(', ')})`)
    checkModels(patchId, patch, base)
    resolved.set(patchId, applyPatch(patchId, base, patch))
  }
  return resolved
}

/**
 * Check an arm whole: its shape, every route patch (including one for an id that is not in the table) valid over its
 * table entry, every patched model one the table names, an agent route only on a model the OpenCode server serves, a
 * `contextLimit` only on an opencode route running a Claude model and only one of `CONTEXT_LIMITS`.
 * Returns the parsed arm. A failure is a
 * `RouteOverrideError` naming the route id and the problem; shape errors carry zod's message, which names keys, never
 * a value.
 */
export function validateArm(raw: unknown): Arm {
  const parsed = armSchema.safeParse(raw)
  if (!parsed.success) throw new RouteOverrideError(parsed.error.message)
  patchedEntries(parsed.data.routes)
  return parsed.data
}

/**
 * A copy of the entry for a route id, with `patch` (a run's arm's `routes`) applied; mutating it changes nothing
 * shared. Without a patch: the table. Throws `UnknownRouteError` for an id that is not in the table (only reachable
 * from untyped callers) and `RouteOverrideError` for an invalid patch, including one that names an unknown route.
 * Every patch is checked, not only the requested one.
 */
export function resolveRoute(id: RouteId, patch?: PatchInput): ResolvedRoute {
  const entry = patchedEntries(patch).get(id) ?? (isRouteId(id) ? DEFAULT_ROUTES[id] : undefined)
  if (!entry) throw new UnknownRouteError(id)
  return { id, ...structuredClone(entry) }
}

/**
 * The route's provider-balance fallback as a route of its own (same id, `isFallback`, no further fallback), or
 * `undefined` when the route has none. A patch is already in `route`: pass what `resolveRoute` returned.
 */
export function fallbackRoute(route: ResolvedRoute): ResolvedRoute | undefined {
  if (!route.fallback) return undefined
  return { id: route.id, ...structuredClone(route.fallback), isFallback: true }
}

/** Wires whose text calls pass the gateway, which writes their `usage.records` rows (a route with a `price` aside). */
const GATEWAY_WIRES: ReadonlySet<Wire> = new Set<Wire>(['anthropic', 'iu-openai', 'opencode', 'iu-decision'])

/** Charges that never pass the gateway, so agw writes their `usage.records` rows itself. */
export const CALLER_CHARGES: ReadonlySet<string> = new Set(['tavily-search', 'tavily-extract'])

let callerModels: ReadonlySet<string> | undefined

/**
 * True for a model whose `usage.records` row agw writes: the gateway is the only writer of token-priced inference
 * rows, so agw writes only what the gateway cannot price. That is a model on a route (or a route's fallback) in the
 * default table that carries a `price` or sits on a wire outside the gateway's text wires (`iu-gemini` TTS,
 * `iu-replicate`, the priced `iu-openai` media, image and STT models; they reach the gateway with `x-agw-usage:
 * caller`), matched raw or through the provider-prefix echo; and the {@link CALLER_CHARGES}. Everything else is the
 * gateway's and gets no row: text models in or outside the table, models an arm's patch names, provider echoes of any
 * shape, `sonar`, the model-less `unknown` remainder. Free zero-cost web labels (`direct`, `cache`, `context7`,
 * `brain-vault`, `youtube`, registry names, `browser`) carry no charge and write no row either. Computed from the
 * table once, on the first call; patches are not read.
 */
export function callerRecords(model: string): boolean {
  if (CALLER_CHARGES.has(model)) return true
  callerModels ??= new Set(
    Object.values(DEFAULT_ROUTES)
      .flatMap((route) => [route, ...(route.fallback ? [route.fallback] : [])])
      .filter((entry) => entry.price !== undefined || !GATEWAY_WIRES.has(entry.wire))
      .map((entry) => entry.model),
  )
  if (callerModels.has(model)) return true
  // IU echoes some models behind a one-segment provider prefix (`<provider>/<model>`, `<provider>.<model>`), and the
  // transports report the echo: it is the same model.
  const echo = PROVIDER_ECHO.exec(model)
  return echo?.[1] !== undefined && callerModels.has(echo[1])
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

/** Stable sha256 (hex) of the resolved entry, the patch included; one input of the run fingerprint (§5). */
export function routeFingerprint(id: RouteId, patch?: PatchInput): string {
  return createHash('sha256')
    .update(canonical(resolveRoute(id, patch)))
    .digest('hex')
}

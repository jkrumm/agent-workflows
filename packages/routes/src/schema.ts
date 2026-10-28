import { z } from 'zod'

/** Transports. `opencode` is an agent step on the OpenCode host; the other three are single calls. */
export const WIRES = ['iu-openai', 'iu-anthropic', 'iu-decision', 'opencode'] as const
export type Wire = (typeof WIRES)[number]

/** Reasoning levels. `none` is OpenCode's own "thinking off" variant; the rest are shared. */
export const EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type Effort = (typeof EFFORTS)[number]

/** Sanity ceiling; the largest output limit in agent-gateway's model registry is 128k. */
export const MAX_OUTPUT_TOKENS = 200_000
const maxOutputTokens = z.int().positive().max(MAX_OUTPUT_TOKENS)

/**
 * USD per million tokens, for wires whose provider reports no cost. Zod 4 numbers are finite.
 * The cache rates are optional: a model that never reports cache tokens needs neither, and a call
 * that does report them against a rate without the matching cache rate is priced `unknown`.
 */
export const rateSchema = z.strictObject({
  inputPerM: z.number().nonnegative(),
  outputPerM: z.number().nonnegative(),
  /** Reads of a prompt-cache entry. */
  cacheReadPerM: z.number().nonnegative().optional(),
  /** Writes of a prompt-cache entry. */
  cacheWritePerM: z.number().nonnegative().optional(),
  /**
   * Prompts (input including cache) above this many tokens bill a higher tier that `Rate` does not model, so they are
   * priced `unknown`. Default `LONG_PROMPT_TOKENS` (100K, the Anthropic-family step).
   */
  longPromptTokens: z.int().positive().optional(),
})
export type Rate = z.infer<typeof rateSchema>

export const ROUTE_ID = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/

const routeFields = {
  wire: z.enum(WIRES),
  model: z.string().min(1),
  effort: z.enum(EFFORTS).optional(),
  maxOutputTokens: maxOutputTokens.optional(),
  rate: rateSchema.optional(),
}

const decisionRule = [
  (r: { wire: Wire; effort?: Effort; maxOutputTokens?: number }) =>
    r.wire !== 'iu-decision' || (r.effort === undefined && r.maxOutputTokens === undefined),
  { message: 'iu-decision routes take neither effort nor maxOutputTokens' },
] as const

/** The route a call moves to once when the primary fails on provider balance (HTTP 402, or 503 "Insufficient Balance"). */
export const fallbackSchema = z.strictObject(routeFields).refine(...decisionRule)
export type FallbackEntry = z.infer<typeof fallbackSchema>

export const routeSchema = z
  .strictObject({ ...routeFields, fallback: fallbackSchema.optional() })
  .refine(...decisionRule)
  .refine((r) => !r.fallback || (r.fallback.wire === 'opencode') === (r.wire === 'opencode'), {
    message:
      'a fallback runs the same kind of step: an opencode route falls back to opencode, a single call to a single call',
  })
export type RouteEntry = z.infer<typeof routeSchema>

/** A table entry plus the id it was resolved by. `isFallback` marks a route `fallbackRoute` made. */
export type ResolvedRoute = RouteEntry & { id: string; isFallback?: true }

const patchFields = {
  wire: z.never({ error: 'wire cannot be overridden (a route transport is code, not configuration)' }).optional(),
  model: z.string().min(1).optional(),
  effort: z.enum(EFFORTS).nullable().optional(),
  maxOutputTokens: maxOutputTokens.nullable().optional(),
  rate: rateSchema.nullable().optional(),
}

/** A patch of a route's fallback: the same fields, merged over the table's fallback. `null` removes the fallback. */
export const fallbackPatchSchema = z.strictObject(patchFields)
export type FallbackPatch = z.infer<typeof fallbackPatchSchema>

/**
 * A partial entry from the override variable; merged over the table entry, then validated whole.
 * There is no `wire`: a route's transport is code, overrides are for model, effort, limit and rate experiments.
 */
export const routePatchSchema = z.strictObject({ ...patchFields, fallback: fallbackPatchSchema.nullable().optional() })
export type RoutePatch = z.infer<typeof routePatchSchema>

export const overridesSchema = z.record(z.string(), routePatchSchema)

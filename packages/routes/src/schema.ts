import { z } from 'zod'
import { priceSchema } from './price.ts'

/**
 * Transports. `opencode` is an agent step on the OpenCode host; the others are single calls. `iu-gemini` is IU's native
 * Gemini `generateContent`/`streamGenerateContent` (TTS), `iu-replicate` IU's Replicate predictions (ElevenLabs).
 */
export const WIRES = ['iu-openai', 'iu-anthropic', 'iu-decision', 'opencode', 'iu-gemini', 'iu-replicate'] as const
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
export const rateSchema = z
  .strictObject({
    inputPerM: z.number().nonnegative(),
    outputPerM: z.number().nonnegative(),
    /** Reads of a prompt-cache entry. */
    cacheReadPerM: z.number().nonnegative().optional(),
    /** Writes of a prompt-cache entry. */
    cacheWritePerM: z.number().nonnegative().optional(),
    /**
     * The long-prompt tier. A rate without `longPrompt` has no tier and is priced flat at any size. With it, a request
     * whose prompt (input including cache reads and writes) is above `longPromptTokens` bills `inputMultiplier` times the
     * input, cache read and cache write rates and `outputMultiplier` times the output rate, the whole request (Haiku
     * 5.5: 5 and 5 over 100K).
     */
    longPrompt: z
      .strictObject({ inputMultiplier: z.number().positive(), outputMultiplier: z.number().positive() })
      .optional(),
    /** The prompt size above which `longPrompt` applies; required with it. */
    longPromptTokens: z.int().positive().optional(),
  })
  .refine((r) => r.longPrompt === undefined || r.longPromptTokens !== undefined, {
    message: 'a rate with a longPrompt tier needs longPromptTokens, the size it starts above',
  })
export type Rate = z.infer<typeof rateSchema>

export const ROUTE_ID = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/

const routeFields = {
  wire: z.enum(WIRES),
  model: z.string().min(1),
  effort: z.enum(EFFORTS).optional(),
  maxOutputTokens: maxOutputTokens.optional(),
  rate: rateSchema.optional(),
  /** A price that is not per text token: an image model's token split, a flat price per call (`price.ts`). */
  price: priceSchema.optional(),
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
  price: priceSchema.nullable().optional(),
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

/**
 * Every route id, one key per route: each `table/<group>.ts` adds its own by module augmentation, so the ids stay
 * typed though the table is discovered at runtime. A route a group file does not declare here is still served, but no
 * caller can name it without a cast.
 */
// oxlint-disable-next-line typescript/no-empty-object-type -- filled by declaration merging from table/<group>.ts
export interface RouteTable {}
export type RouteId = keyof RouteTable & string

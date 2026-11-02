import { z } from 'zod'
import { priceSchema } from './price.ts'
import { CLAUDE_RATES } from './table/claude.ts'

/**
 * Transports. `opencode` is an agent step on the OpenCode host; the others are single calls. `iu-gemini` is IU's native
 * Gemini `generateContent`/`streamGenerateContent` (TTS), `iu-replicate` IU's Replicate predictions (ElevenLabs).
 */
export const WIRES = ['iu-openai', 'anthropic', 'iu-decision', 'opencode', 'iu-gemini', 'iu-replicate'] as const
export type Wire = (typeof WIRES)[number]

/** Reasoning levels. `none` is OpenCode's own "thinking off" variant; the rest are shared. */
export const EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type Effort = (typeof EFFORTS)[number]

/** Sanity ceiling; the largest output limit in agent-gateway's model registry is 128k. */
export const MAX_OUTPUT_TOKENS = 200_000
const maxOutputTokens = z.int().positive().max(MAX_OUTPUT_TOKENS)

/**
 * The prompt-token bounds an `opencode` route may ask for (`contextLimit`): no request of the session, the compaction
 * summary included, is meant to exceed one. A small fixed set, because the OpenCode server registers one alias row per
 * Claude model and bound (`packages/opencode-host` config) and serves every one without a restart; an arm cannot name
 * another value.
 */
export const CONTEXT_LIMITS = [60_000, 80_000, 100_000] as const
export type ContextLimit = (typeof CONTEXT_LIMITS)[number]
const contextLimit = z.int().refine((n): n is ContextLimit => (CONTEXT_LIMITS as readonly number[]).includes(n), {
  message: `contextLimit must be one of ${CONTEXT_LIMITS.join(', ')} (prompt tokens)`,
})

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
    /** Writes of a prompt-cache entry (Anthropic: the 5-minute entry). */
    cacheWritePerM: z.number().nonnegative().optional(),
    /** Writes of a 1-hour prompt-cache entry (Anthropic: 2x input). A call with 1-hour writes against a rate without it is priced `unknown`. */
    cacheWrite1hPerM: z.number().nonnegative().optional(),
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

/**
 * The efforts a model's provider takes, by family, read from the id's prefix (no concrete table id is named outside
 * `table/`). A family not listed takes every effort. One source for the table import, every arm patch and the efforts the
 * OpenCode server registers as variants (`packages/opencode-host` config).
 * - Sonnet (`claude-sonnet-<version>` or the `sonnet` alias): Anthropic's levels are low to max; "thinking off" is not
 *   one of them (the lowest is `thinking: between_tools`, which `none` does not send).
 * - GPT-6 Astra and GPT-6.1 Sol: no `none` (HTTP 400); the rest of the GPT-6 family takes all six (OpenAI's GPT-6 guide
 *   and model pages, developers.openai.com/api/docs/guides/latest-model, read 2026-11-02).
 * - DeepSeek: `none`, `low`, `high`, `max` are its levels; `medium` and `xhigh` are only accepted as aliases of `high`
 *   (api-docs.deepseek.com/api/create-chat-completion, read 2026-11-02), so an arm at them would measure `high`.
 */
const EFFORT_FAMILIES: readonly { name: string; match: RegExp; efforts: readonly Effort[] }[] = [
  { name: 'a Sonnet model', match: /^(?:claude-)?sonnet(?:-|$)/, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  {
    name: 'a GPT-6 Astra or GPT-6.1 Sol model',
    match: /^gpt-6(?:-astra|\.1-sol)(?:-|$)/,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  { name: 'a DeepSeek model', match: /^deepseek-/i, efforts: ['none', 'low', 'high', 'max'] },
]

/** The efforts a model can run at (`EFFORTS` unless its family takes fewer). */
export function effortsOf(model: string): readonly Effort[] {
  return EFFORT_FAMILIES.find((f) => f.match.test(model))?.efforts ?? EFFORTS
}

/** Whether a model's provider takes an effort. */
export function takesEffort(model: string, effort: Effort): boolean {
  return effortsOf(model).includes(effort)
}

const list = (items: readonly string[]) =>
  items.length > 1 ? `${items.slice(0, -1).join(', ')} or ${items.at(-1)}` : (items[0] ?? '')

/** Refuses an effort the model's provider does not take, naming the family and the efforts it does. The caller names the route. */
function effortRule(r: { model: string; effort?: Effort }, ctx: z.RefinementCtx) {
  if (r.effort === undefined || takesEffort(r.model, r.effort)) return
  const family = EFFORT_FAMILIES.find((f) => f.match.test(r.model))
  ctx.addIssue({
    code: 'custom',
    path: ['effort'],
    message: `${family?.name ?? 'the model'} cannot run at effort ${r.effort}: use ${list(effortsOf(r.model))}`,
  })
}

/** The route a call moves to once when the primary fails on provider balance (HTTP 402, or 503 "Insufficient Balance"). */
export const fallbackSchema = z
  .strictObject(routeFields)
  .refine(...decisionRule)
  .superRefine(effortRule)
export type FallbackEntry = z.infer<typeof fallbackSchema>

export const routeSchema = z
  .strictObject({
    ...routeFields,
    /**
     * Keeps every call of an agent step under this many prompt tokens (input plus cache reads and writes), by having the
     * OpenCode session compact before it grows past it. Own field of the route, never of the fallback. Off when unset.
     */
    contextLimit: contextLimit.optional(),
    fallback: fallbackSchema.optional(),
  })
  .refine(...decisionRule)
  .superRefine(effortRule)
  .refine((r) => r.contextLimit === undefined || r.wire === 'opencode', {
    message: 'contextLimit applies to opencode routes only (an agent session compacts; a single call has no session)',
    path: ['contextLimit'],
  })
  .refine((r) => r.contextLimit === undefined || Object.hasOwn(CLAUDE_RATES, r.model), {
    message: 'contextLimit needs a Claude model (the OpenCode server has a bounded row for those only)',
    path: ['contextLimit'],
  })
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
 * A partial entry from an arm's `routes`; merged over the table entry, then validated whole.
 * There is no `wire`: a route's transport is code, patches are for model, effort, limit and rate experiments.
 */
export const routePatchSchema = z.strictObject({
  ...patchFields,
  contextLimit: contextLimit.nullable().optional(),
  fallback: fallbackPatchSchema.nullable().optional(),
})
export type RoutePatch = z.infer<typeof routePatchSchema>

/**
 * Every route id, one key per route: each `table/<group>.ts` adds its own by module augmentation, so the ids stay
 * typed though the table is discovered at runtime. A route a group file does not declare here is still served, but no
 * caller can name it without a cast.
 */
// oxlint-disable-next-line typescript/no-empty-object-type -- filled by declaration merging from table/<group>.ts
export interface RouteTable {}
export type RouteId = keyof RouteTable & string

import { z } from 'zod'

export const usageSchema = z.object({
  model: z.string(),
  /** Raw provider counts: `input` includes cache reads, `output` includes reasoning. */
  tokens: z.object({
    input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
    cacheRead: z.number().int().nonnegative(),
    reasoning: z.number().int().nonnegative(),
  }),
  /** USD; `null` when neither the provider nor the route's rate gives a price, never 0. */
  cost: z.number().nonnegative().nullable(),
  costSource: z.enum(['provider', 'rate', 'unknown']),
})
export type Usage = z.infer<typeof usageSchema>

/** What a handler sees. Structurally the same `addUsage` the runtime's step context carries. */
export interface Ctx {
  signal: AbortSignal
  /** Report one billed model call. A call that is retried reports each attempt. */
  addUsage: (usage: Usage) => void
}

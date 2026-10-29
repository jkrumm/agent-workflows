import { z } from 'zod'
import type { Ctx, Usage } from '../context.ts'

/**
 * What a call cost, in agent-gateway's `usage` field names (iris reads `usage.costUsd`). `costUsd` is `null` when any
 * billed attempt has no price, never a partial sum; it is also `null` when the provider returned no usage at all.
 */
export const callUsageSchema = z.object({
  inputTokens: z.int().nonnegative(),
  outputTokens: z.int().nonnegative(),
  reasoningTokens: z.int().nonnegative(),
  totalTokens: z.int().nonnegative(),
  cacheReadTokens: z.int().nonnegative(),
  costUsd: z.number().nonnegative().nullable(),
})
export type CallUsage = z.infer<typeof callUsageSchema>

/** A `Ctx` whose usage is also kept, so the handler can put the call's total in its answer. */
export function trackUsage(ctx: Ctx): { ctx: Ctx; total: () => CallUsage } {
  const calls: Usage[] = []
  return {
    ctx: {
      signal: ctx.signal,
      addUsage: (usage) => {
        calls.push(usage)
        ctx.addUsage(usage)
      },
    },
    total: () => {
      const sum = (pick: (u: Usage) => number) => calls.reduce((acc, u) => acc + pick(u), 0)
      const inputTokens = sum((u) => u.tokens.input)
      const outputTokens = sum((u) => u.tokens.output)
      return {
        inputTokens,
        outputTokens,
        reasoningTokens: sum((u) => u.tokens.reasoning),
        totalTokens: inputTokens + outputTokens,
        cacheReadTokens: sum((u) => u.tokens.cacheRead),
        costUsd: calls.length > 0 && calls.every((u) => u.cost !== null) ? sum((u) => u.cost ?? 0) : null,
      }
    },
  }
}

import type { Rate, Wire } from './schema.ts'

/** Provider usage as it arrives: OpenAI (`prompt_tokens`), Anthropic and the AI SDK (`input_tokens`). */
export interface ProviderUsage {
  /** USD, reported by the provider (IU puts it in `usage.cost`). */
  cost?: number | null
  prompt_tokens?: number
  completion_tokens?: number
  input_tokens?: number
  output_tokens?: number
  inputTokens?: number
  outputTokens?: number
}

export type Cost = { usd: number; source: 'provider' | 'rate' } | { usd: null; source: 'unknown' }

function count(...values: (number | undefined)[]): number | null {
  for (const v of values) if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v
  return null
}

/**
 * USD for one call. The provider's `usage.cost` wins on every wire; otherwise the route's rate is
 * applied to input and output tokens (reasoning tokens are already inside the output count on the
 * wires we use, cached input bills at the input rate); with neither, the cost is `unknown`, never 0.
 * `wire` is reserved for wire-specific cost rules; no wire needs one yet, so it is not read.
 */
export function costFromUsage(_wire: Wire, usage: ProviderUsage | null | undefined, rate?: Rate): Cost {
  if (typeof usage?.cost === 'number' && Number.isFinite(usage.cost) && usage.cost >= 0) {
    return { usd: usage.cost, source: 'provider' }
  }
  if (!usage || !rate) return { usd: null, source: 'unknown' }
  const input = count(usage.prompt_tokens, usage.input_tokens, usage.inputTokens)
  const output = count(usage.completion_tokens, usage.output_tokens, usage.outputTokens)
  if (input === null || output === null) return { usd: null, source: 'unknown' }
  return { usd: (input * rate.inputPerM + output * rate.outputPerM) / 1_000_000, source: 'rate' }
}

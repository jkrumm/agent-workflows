import type { Rate, Wire } from './schema.ts'

/**
 * Provider usage as it arrives. The input keys differ in what they count: `input_tokens` is
 * Anthropic's and EXCLUDES cache reads and writes; `prompt_tokens` (OpenAI) and `inputTokens` INCLUDE
 * them. Cache counts: Anthropic `cache_read_input_tokens` / `cache_creation_input_tokens`, OpenAI
 * `prompt_tokens_details.cached_tokens` (OpenAI reports no cache writes).
 */
export interface ProviderUsage {
  /** USD, reported by the provider (IU puts it in `usage.cost`). */
  cost?: number | null
  prompt_tokens?: number
  completion_tokens?: number
  input_tokens?: number
  output_tokens?: number
  inputTokens?: number
  outputTokens?: number
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
  prompt_tokens_details?: { cached_tokens?: number | null } | null
}

export type Cost = { usd: number; source: 'provider' | 'rate' } | { usd: null; source: 'unknown' }

function count(...values: (number | undefined)[]): number | null {
  for (const v of values) if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v
  return null
}

/** Prompts above this many tokens (input including cache) are not priced: Anthropic-family list prices step up. */
export const LONG_PROMPT_TOKENS = 100_000

/**
 * USD for one call. The provider's `usage.cost` wins on every wire; otherwise the route's rate is
 * applied: input excluding cache tokens at `inputPerM`, cache reads at `cacheReadPerM`, cache writes
 * at `cacheWritePerM`, output (reasoning tokens are already inside it) at `outputPerM`. Cache tokens
 * without the matching cache rate, neither cost nor rate, cache counts above the cache-inclusive prompt
 * total, or a prompt above `LONG_PROMPT_TOKENS` (vendors bill a higher tier we do not model) make the cost
 * `unknown`: never free, never 0, never an under-price.
 * `wire` is reserved for wire-specific cost rules; no wire needs one yet, so it is not read.
 */
export function costFromUsage(_wire: Wire, usage: ProviderUsage | null | undefined, rate?: Rate): Cost {
  if (typeof usage?.cost === 'number' && Number.isFinite(usage.cost) && usage.cost >= 0) {
    return { usd: usage.cost, source: 'provider' }
  }
  if (!usage || !rate) return { usd: null, source: 'unknown' }
  const output = count(usage.completion_tokens, usage.output_tokens, usage.outputTokens)
  const cacheRead =
    count(usage.cache_read_input_tokens ?? undefined, usage.prompt_tokens_details?.cached_tokens ?? undefined) ?? 0
  const cacheWrite = count(usage.cache_creation_input_tokens ?? undefined) ?? 0
  const cacheIncluded = count(usage.prompt_tokens, usage.inputTokens)
  if (cacheIncluded !== null && cacheRead + cacheWrite > cacheIncluded) return { usd: null, source: 'unknown' }
  const input = cacheIncluded !== null ? cacheIncluded - cacheRead - cacheWrite : count(usage.input_tokens)
  if (input === null || output === null) return { usd: null, source: 'unknown' }
  if (input + cacheRead + cacheWrite > LONG_PROMPT_TOKENS) return { usd: null, source: 'unknown' }
  if ((cacheRead > 0 && rate.cacheReadPerM === undefined) || (cacheWrite > 0 && rate.cacheWritePerM === undefined)) {
    return { usd: null, source: 'unknown' }
  }
  const usd =
    input * rate.inputPerM +
    cacheRead * (rate.cacheReadPerM ?? 0) +
    cacheWrite * (rate.cacheWritePerM ?? 0) +
    output * rate.outputPerM
  return { usd: usd / 1_000_000, source: 'rate' }
}

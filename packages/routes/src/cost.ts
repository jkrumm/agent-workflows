import { type Price, type PriceUsage, priceCall } from './price.ts'
import type { Rate, Wire } from './schema.ts'

/**
 * Provider usage as it arrives. The input keys differ in what they count: `input_tokens` is
 * Anthropic's and EXCLUDES cache reads and writes; `prompt_tokens` (OpenAI) and `inputTokens` INCLUDE
 * them. Cache counts: Anthropic `cache_read_input_tokens` / `cache_creation_input_tokens`, OpenAI
 * `prompt_tokens_details.cached_tokens` (OpenAI reports no cache writes).
 */
export interface ProviderUsage extends Pick<PriceUsage, 'input_tokens_details' | 'units'> {
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
  /** Anthropic's split of the cache writes by lifetime; absent on older responses, then every write counts as 5m. */
  cache_creation?: {
    ephemeral_5m_input_tokens?: number | null
    ephemeral_1h_input_tokens?: number | null
  } | null
  prompt_tokens_details?: { cached_tokens?: number | null } | null
}

export type Cost = { usd: number; source: 'provider' | 'rate' } | { usd: null; source: 'unknown' }

function count(...values: (number | undefined)[]): number | null {
  for (const v of values) if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v
  return null
}

/** A split count: absent (`null`/`undefined`), a valid count, or `'bad'` (negative or non-finite). */
function splitCount(value: number | null | undefined): number | undefined | 'bad' {
  if (value === null || value === undefined) return undefined
  return Number.isFinite(value) && value >= 0 ? value : 'bad'
}

/**
 * Cache writes split by lifetime. `cache_creation_input_tokens` is the total; `cache_creation.ephemeral_1h_input_tokens`
 * is the part written to the 1-hour cache, and the rest counts as 5-minute, as it did before the split existed. Without
 * the total, the split's own two counts are the writes. `null` (the cost is unknown) for a block that contradicts
 * itself: a present split count that is negative or not finite, or a split (5m plus 1h) that is larger than the total.
 */
function cacheWrites(usage: ProviderUsage): { write5m: number; write1h: number } | null {
  const total = count(usage.cache_creation_input_tokens ?? undefined)
  const m5 = splitCount(usage.cache_creation?.ephemeral_5m_input_tokens)
  const h1 = splitCount(usage.cache_creation?.ephemeral_1h_input_tokens)
  if (m5 === 'bad' || h1 === 'bad') return null
  const write1h = h1 ?? 0
  if (total === null) return { write5m: m5 ?? 0, write1h }
  if ((m5 ?? 0) + write1h > total) return null
  return { write5m: total - write1h, write1h }
}

/**
 * USD for one call. The provider's `usage.cost` wins on every wire; otherwise the route's rate is applied: input
 * excluding cache tokens at `inputPerM`, cache reads at `cacheReadPerM`, 5-minute cache writes at `cacheWritePerM`,
 * 1-hour cache writes at `cacheWrite1hPerM`, output (reasoning tokens are already inside it) at `outputPerM`.
 * The cost is `unknown`, never free and never 0, when: there is no usage or no rate, or no input or output count;
 * cache tokens come without the matching cache rate (a 1-hour write needs `cacheWrite1hPerM` itself, it does not fall
 * back to the 5-minute rate); the cache counts are above the cache-inclusive prompt total; or the cache-write split
 * contradicts itself (`cacheWrites`).
 * One rule for size: a rate without `longPrompt` has no tier and is priced flat at any size; a rate with it prices a
 * prompt (input including cache) above `longPromptTokens` at the tier: the whole request, every input column times
 * `inputMultiplier`, output times `outputMultiplier`.
 * A route with a `price` (image, audio, Replicate: `price.ts`) is priced by it alone; `rate` is the text-token path.
 * `wire` is reserved for wire-specific cost rules; no wire needs one yet, so it is not read.
 */
export function costFromUsage(_wire: Wire, usage: ProviderUsage | null | undefined, rate?: Rate, price?: Price): Cost {
  if (price) return priceCall(price, usage)
  if (typeof usage?.cost === 'number' && Number.isFinite(usage.cost) && usage.cost >= 0) {
    return { usd: usage.cost, source: 'provider' }
  }
  if (!usage || !rate) return { usd: null, source: 'unknown' }
  const output = count(usage.completion_tokens, usage.output_tokens, usage.outputTokens)
  const cacheRead =
    count(usage.cache_read_input_tokens ?? undefined, usage.prompt_tokens_details?.cached_tokens ?? undefined) ?? 0
  const written = cacheWrites(usage)
  if (!written) return { usd: null, source: 'unknown' }
  const { write5m, write1h } = written
  const cacheWrite = write5m + write1h
  const cacheIncluded = count(usage.prompt_tokens, usage.inputTokens)
  if (cacheIncluded !== null && cacheRead + cacheWrite > cacheIncluded) return { usd: null, source: 'unknown' }
  const input = cacheIncluded !== null ? cacheIncluded - cacheRead - cacheWrite : count(usage.input_tokens)
  if (input === null || output === null) return { usd: null, source: 'unknown' }
  const tier = rate.longPrompt
  const long =
    tier !== undefined && input + cacheRead + cacheWrite > (rate.longPromptTokens ?? Number.POSITIVE_INFINITY)
  if (
    (cacheRead > 0 && rate.cacheReadPerM === undefined) ||
    (write5m > 0 && rate.cacheWritePerM === undefined) ||
    (write1h > 0 && rate.cacheWrite1hPerM === undefined)
  ) {
    return { usd: null, source: 'unknown' }
  }
  const inputScale = long ? tier.inputMultiplier : 1
  const outputScale = long ? tier.outputMultiplier : 1
  const usd =
    (input * rate.inputPerM +
      cacheRead * (rate.cacheReadPerM ?? 0) +
      write5m * (rate.cacheWritePerM ?? 0) +
      write1h * (rate.cacheWrite1hPerM ?? 0)) *
      inputScale +
    output * rate.outputPerM * outputScale
  return { usd: usd / 1_000_000, source: 'rate' }
}

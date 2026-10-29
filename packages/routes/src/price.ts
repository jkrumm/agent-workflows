import { z } from 'zod'
import type { Cost } from './cost.ts'

/**
 * Prices that are not "USD per million text tokens" (`Rate`). A route carries one as `price`; `Rate` stays the shape of
 * every text route, and a route may carry both.
 *
 * - `unit`: USD for a count of a billed unit: an `image`, a `character` (TTS), a `second` (STT, audio), or a `call`
 *   (a Replicate run). `usd` is per `per` units (default 1; `per: 1000` is a price per 1k characters). `tiers` override
 *   the base `usd` for calls whose attributes match, e.g. `{ quality: 'high', size: '1024x1024' }`: the first tier whose
 *   `match` entries all equal the call's attributes wins, no match falls back to `usd`.
 * - `image-tokens`: a token-billed image model, whose input splits into text and image tokens at different rates.
 */
export const UNITS = ['image', 'character', 'second', 'call'] as const
export type Unit = (typeof UNITS)[number]

const attributeValue = z.union([z.string(), z.number(), z.boolean()])

export const unitPriceSchema = z.strictObject({
  kind: z.literal('unit'),
  unit: z.enum(UNITS),
  /** USD per `per` units. */
  usd: z.number().nonnegative(),
  /** Units one `usd` covers; 1000 for a price per 1k. Default 1. */
  per: z.int().positive().optional(),
  tiers: z
    .array(z.strictObject({ match: z.record(z.string(), attributeValue), usd: z.number().nonnegative() }))
    .min(1)
    .optional(),
})

export const imageTokenPriceSchema = z.strictObject({
  kind: z.literal('image-tokens'),
  /** USD per million prompt (text) tokens. */
  textInPerM: z.number().nonnegative(),
  /** USD per million input-image tokens (an edit's reference images). */
  imageInPerM: z.number().nonnegative(),
  /** USD per million output (image) tokens. */
  outputPerM: z.number().nonnegative(),
})

export const priceSchema = z.discriminatedUnion('kind', [unitPriceSchema, imageTokenPriceSchema])
export type Price = z.infer<typeof priceSchema>
export type UnitPrice = z.infer<typeof unitPriceSchema>

/** What a call consumed, for a `unit` price. A `call` unit needs none: one call is one unit. */
export interface UnitsUsed {
  quantity: number
  /** Tier keys of the call: `{ quality: 'low', size: '1024x1024' }`. */
  attributes?: Record<string, string | number | boolean>
}

/** What `priceCall` reads of a call's usage: the provider's cost, an image endpoint's tokens, or the units a unit price counts. */
export interface PriceUsage {
  /** USD, reported by the provider (IU puts it in `usage.cost`). */
  cost?: number | null
  input_tokens?: number
  output_tokens?: number
  input_tokens_details?: { text_tokens?: number | null; image_tokens?: number | null } | null
  units?: UnitsUsed | null
}

const count = (value: number | null | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null

function unitCost(price: UnitPrice, used: UnitsUsed | null | undefined): Cost {
  const quantity = price.unit === 'call' && !used ? 1 : count(used?.quantity)
  if (quantity === null) return { usd: null, source: 'unknown' }
  const attributes = used?.attributes ?? {}
  const tier = price.tiers?.find((t) => Object.entries(t.match).every(([key, value]) => attributes[key] === value))
  return { usd: ((tier?.usd ?? price.usd) * quantity) / (price.per ?? 1), source: 'rate' }
}

/**
 * USD for one call under a non-token price. The provider's `usage.cost` wins when it reports one; otherwise the price:
 * `unit` is `usd × quantity / per` (the matching tier's `usd` when a tier matches) and needs `usage.units`, except for
 * `call`, which defaults to one; `image-tokens` splits the input by `input_tokens_details` (without the split the whole
 * input is text) and needs both token counts. Anything else is `unknown`: never free, never 0.
 */
export function priceCall(price: Price | undefined, usage: PriceUsage | null | undefined): Cost {
  const reported = count(usage?.cost)
  if (reported !== null) return { usd: reported, source: 'provider' }
  if (!price) return { usd: null, source: 'unknown' }
  if (price.kind === 'unit') return unitCost(price, usage?.units)
  const input = count(usage?.input_tokens)
  const output = count(usage?.output_tokens)
  if (input === null || output === null) return { usd: null, source: 'unknown' }
  // The input splits into text and image tokens: a side the endpoint did not report is the remainder. Two sides that do not
  // add up to the input, or one that exceeds it, are a split we do not understand: unknown, never an under-price.
  const reportedText = count(usage?.input_tokens_details?.text_tokens)
  const reportedImage = count(usage?.input_tokens_details?.image_tokens)
  const textTokens = reportedText ?? (reportedImage === null ? input : input - reportedImage)
  const imageTokens = reportedImage ?? input - textTokens
  if (textTokens < 0 || imageTokens < 0 || textTokens + imageTokens !== input) return { usd: null, source: 'unknown' }
  const usd = (textTokens * price.textInPerM + imageTokens * price.imageInPerM + output * price.outputPerM) / 1_000_000
  return { usd, source: 'rate' }
}

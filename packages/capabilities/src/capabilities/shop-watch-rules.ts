import { z } from 'zod'
import { type AnySource, DIRECT_SHOPS, isDirectShop, type Offer } from './shop-offers-parse.ts'
import { isShopifySource, shopifyHost } from './shop-shopify-parse.ts'

// The watch's decisions as pure functions: which offer qualifies, and when a price is worth a message. No file, no
// network, no clock: `shop-watch.ts` reads the pages, keeps the record and sends the message.

const shopifySourceField = z.string().refine((s) => shopifyHost(s) !== null, 'a listed shopify:<host> store')

export const watchEntrySchema = z.object({
  mpn: z.string().trim().min(1).describe('Manufacturer part number: the exact product'),
  label: z.string().trim().min(1).describe('Name in messages and the record'),
  ceilingEur: z.number().positive().describe('A lowest qualifying total at or under this is worth a message'),
  minRating: z.number().min(0).max(5).default(4).describe('Shop rating floor, 0..5'),
  minRatings: z.int().min(0).default(20).describe('Number of shop ratings floor'),
  allowPrepayment: z.boolean().default(false).describe('Count offers that can only be paid in advance'),
  asin: z
    .string()
    .regex(/^[A-Z0-9]{10}$/)
    .optional()
    .describe('amazon.de ASIN: read as a third source; counts only when Amazon itself sells'),
  dropPercent: z
    .number()
    .min(0.5)
    .max(90)
    .default(5)
    .describe('A message when the lowest qualifying total falls this far below the last alerted price or recent runs'),
  shops: z
    .array(z.enum(DIRECT_SHOPS))
    .default([...DIRECT_SHOPS])
    .describe(
      "Tech shops whose own page is read besides idealo and geizhals (by part number; the page found is kept). Their offers have no shop rating and count as a known retailer's own price; [] reads none",
    ),
  shopify: z
    .array(shopifySourceField)
    .default([])
    .describe(
      "Shopify stores read by part number (shopify:www.it-veith.de), counted like a tech shop: the shop's own price",
    ),
})
export type WatchEntry = z.infer<typeof watchEntrySchema>

/** A source whose page is the shop's own (a tech shop, a Shopify store): no shop rating, it counts as the known retailer it is. */
export const isOwnPageSource = (source: string) => isDirectShop(source) || isShopifySource(source)

export const feedEntrySchema = z
  .object({
    label: z.string().trim().min(1).describe('Name in messages and the feed state: unique'),
    source: shopifySourceField.describe('The store as shopify:<host>'),
    collection: z.string().trim().min(1).optional().describe("A collection handle: the store's product feed"),
    query: z.string().trim().min(1).optional().describe("The store's own search (at most 10 products)"),
    contains: z.string().optional().describe('Title words; | separates alternatives ("DDR5|NVMe")'),
    maxPricePerGb: z
      .number()
      .positive()
      .optional()
      .describe('Price per GB ceiling, EUR (capacity read from the title)'),
    maxPrice: z.number().positive().optional().describe('Price ceiling, EUR'),
    availableOnly: z.boolean().default(true).describe('Only products that can be bought now'),
    pages: z.int().min(1).max(5).default(3).describe('Pages of 250 products read from a collection'),
  })
  .refine((f) => (f.collection === undefined) !== (f.query === undefined), 'give exactly one of collection and query')
export type FeedEntry = z.infer<typeof feedEntrySchema>

export const watchFileSchema = z
  .object({
    products: z.array(watchEntrySchema).default([]),
    feeds: z.array(feedEntrySchema).default([]),
  })
  .refine((f) => f.products.length + f.feeds.length > 0, 'the list holds no product and no feed')
  .refine((f) => new Set(f.feeds.map((x) => x.label)).size === f.feeds.length, 'feed labels must be unique')

/** A price from one source, in the shape the rules read. `amazon` has no shop rating: it counts when Amazon sells. */
export interface WatchCandidate {
  source: AnySource | 'amazon'
  shop: string | null
  rating: number | null
  ratingCount: number | null
  totalEur: number | null
  url: string
}

/**
 * The candidate an offer gives under this entry's rules, or null when it does not qualify. An aggregator's offer needs the
 * shop rating and count floors; a tech shop's own page has no rating and counts as the known retailer it is (as Amazon does
 * when it sells itself), but never without a total, which needs a stated shipping cost, and never when unavailable.
 */
export function qualifyingOffer(
  entry: WatchEntry,
  source: AnySource,
  offer: Offer,
  url: string,
): WatchCandidate | null {
  const total = entry.allowPrepayment ? offer.totalEur : offer.totalEurNoPrepayment
  if (total === null || offer.inStock === false) return null
  if (!isOwnPageSource(source)) {
    if (offer.rating === null || offer.rating < entry.minRating) return null
    if (offer.ratingCount === null || offer.ratingCount < entry.minRatings) return null
  }
  return { source, shop: offer.shop, rating: offer.rating, ratingCount: offer.ratingCount, totalEur: total, url }
}

/** The cheapest candidate; on a tie the first one (sources are passed in a fixed order). */
export function cheapest(candidates: WatchCandidate[]): WatchCandidate | null {
  let best: WatchCandidate | null = null
  for (const c of candidates)
    if (c.totalEur !== null && (best === null || c.totalEur < (best.totalEur ?? Infinity))) best = c
  return best
}

/** What the watch remembers of one product between runs. */
export interface WatchState {
  /** The product page each source was found at, by source; null (or absent) searches by part number again. */
  pageUrls: Partial<Record<AnySource, string | null>>
  /** The lowest qualifying total was at or under the ceiling at the last run. */
  underCeiling: boolean
  /** The price of the last message, while the price has not risen above it since; null re-arms the recent-runs rule. */
  lastAlertedEur: number | null
  /** The lowest qualifying totals of the last runs that found one, newest last, at most three. */
  recent: number[]
}

export const emptyState = (): WatchState => ({
  pageUrls: {},
  underCeiling: false,
  lastAlertedEur: null,
  recent: [],
})

export type AlertReason = 'ceiling' | 'drop'

export interface Decision {
  alert: { reason: AlertReason; baselineEur: number | null } | null
  /** The state after the run, if the message (when there is one) was delivered. */
  next: WatchState
  /** The state after the run when the message could not be delivered: it stays armed and the next run tries again. */
  undelivered: WatchState
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/**
 * A message on a change of state only:
 * - the lowest qualifying total goes from above the ceiling (or none) to at or under it, or
 * - it falls `dropPercent` below the price last alerted, or, when the price has risen above that alert since, below the
 *   median of the previous runs' lowest totals (`state.recent`).
 * A run that finds the same price, or one that is not under any of these, sends nothing.
 */
export function decide(entry: WatchEntry, state: WatchState, lowestEur: number | null): Decision {
  const quiet = { alert: null }
  if (lowestEur === null) {
    const next = { ...state, underCeiling: false }
    return { ...quiet, next, undelivered: next }
  }
  const under = lowestEur <= entry.ceilingEur
  const factor = 1 - entry.dropPercent / 100
  // A price above the one alerted re-arms the recent-runs rule.
  const lastAlerted = state.lastAlertedEur !== null && lowestEur > state.lastAlertedEur ? null : state.lastAlertedEur
  const recent = state.recent
  let alert: Decision['alert'] = null
  if (under && !state.underCeiling) alert = { reason: 'ceiling', baselineEur: lastAlerted }
  else if (lastAlerted !== null && lowestEur <= lastAlerted * factor)
    alert = { reason: 'drop', baselineEur: lastAlerted }
  else if (lastAlerted === null && recent.length > 0 && lowestEur <= median(recent) * factor)
    alert = { reason: 'drop', baselineEur: median(recent) }
  const base: WatchState = {
    ...state,
    underCeiling: under,
    lastAlertedEur: lastAlerted,
    recent: [...recent, lowestEur].slice(-3),
  }
  return {
    alert,
    next: alert ? { ...base, lastAlertedEur: lowestEur } : base,
    // Not delivered: the ceiling transition and the baseline stay as they were, so the next run alerts again.
    undelivered: alert ? { ...state, recent: base.recent } : base,
  }
}

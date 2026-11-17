import { z } from 'zod'
import type { Offer } from './shop-offers-parse.ts'

// The watch's decisions as pure functions: which offer qualifies, and when a price is worth a message. No file, no
// network, no clock: `shop-watch.ts` reads the pages, keeps the record and sends the message.

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
})
export type WatchEntry = z.infer<typeof watchEntrySchema>

export const watchFileSchema = z.object({ products: z.array(watchEntrySchema).min(1) })

/** A price from one source, in the shape the rules read. `amazon` has no shop rating: it counts when Amazon sells. */
export interface WatchCandidate {
  source: 'idealo' | 'geizhals' | 'amazon'
  shop: string | null
  rating: number | null
  ratingCount: number | null
  totalEur: number | null
  url: string
}

/** The candidate an idealo or geizhals offer gives under this entry's prepayment rule, or null when it does not qualify. */
export function qualifyingOffer(
  entry: WatchEntry,
  source: 'idealo' | 'geizhals',
  offer: Offer,
  url: string,
): WatchCandidate | null {
  const total = entry.allowPrepayment ? offer.totalEur : offer.totalEurNoPrepayment
  if (total === null || offer.inStock === false) return null
  if (offer.rating === null || offer.rating < entry.minRating) return null
  if (offer.ratingCount === null || offer.ratingCount < entry.minRatings) return null
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
  idealoUrl: string | null
  geizhalsUrl: string | null
  /** The lowest qualifying total was at or under the ceiling at the last run. */
  underCeiling: boolean
  /** The price of the last message, while the price has not risen above it since; null re-arms the recent-runs rule. */
  lastAlertedEur: number | null
  /** The lowest qualifying totals of the last runs that found one, newest last, at most three. */
  recent: number[]
}

export const emptyState = (): WatchState => ({
  idealoUrl: null,
  geizhalsUrl: null,
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

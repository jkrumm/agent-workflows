/** Wilson score interval for a proportion; z = 1.96 is the 95 % level. Null when there is nothing to estimate. */
export function wilson(successes: number, n: number, z = 1.959964): { p: number; lo: number; hi: number } | null {
  if (n <= 0) return null
  const p = successes / n
  const z2 = z * z
  const denom = 1 + z2 / n
  const center = (p + z2 / (2 * n)) / denom
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom
  return { p, lo: Math.max(0, center - half), hi: Math.min(1, center + half) }
}

/** Judge `a` (rows) against judge `b` (columns): `yy` both positive, `yn` a yes and b no, and so on. */
export type Confusion = {
  yy: number
  yn: number
  ny: number
  nn: number
}

export const confusionTotal = (c: Confusion) => c.yy + c.yn + c.ny + c.nn

/** Share of pairs both raters put in the same class; null without pairs. */
export function agreement(c: Confusion): number | null {
  const n = confusionTotal(c)
  return n === 0 ? null : (c.yy + c.nn) / n
}

/** Cohen's κ = (po − pe) / (1 − pe). Null without pairs, or when chance agreement is total (κ is undefined). */
export function cohenKappa(c: Confusion): number | null {
  const n = confusionTotal(c)
  if (n === 0) return null
  const po = (c.yy + c.nn) / n
  const pe = ((c.yy + c.yn) * (c.yy + c.ny) + (c.ny + c.nn) * (c.yn + c.nn)) / (n * n)
  return pe === 1 ? null : (po - pe) / (1 - pe)
}

/**
 * The 95 % interval of κ, large-sample (the standard error of Cohen's κ under the null of no agreement beyond the
 * observed one: √(po (1 − po) / (n (1 − pe)²))). Null where κ is.
 */
export function kappaCI(c: Confusion, z = 1.959964): { kappa: number; lo: number; hi: number } | null {
  const kappa = cohenKappa(c)
  const n = confusionTotal(c)
  if (kappa === null) return null
  const po = (c.yy + c.nn) / n
  const pe = ((c.yy + c.yn) * (c.yy + c.ny) + (c.ny + c.nn) * (c.yn + c.nn)) / (n * n)
  const se = Math.sqrt((po * (1 - po)) / (n * (1 - pe) ** 2))
  return { kappa, lo: Math.max(-1, kappa - z * se), hi: Math.min(1, kappa + z * se) }
}

/** The bar for the judges: below it the scorer asks both and calls a disagreement `unclear`. */
export const KAPPA_BAR = 0.8

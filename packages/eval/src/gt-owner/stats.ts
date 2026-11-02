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

/** Owner (rows) against judge (columns): `yy` both positive, `yn` owner yes and judge no, and so on. */
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

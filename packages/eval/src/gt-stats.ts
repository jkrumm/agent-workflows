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

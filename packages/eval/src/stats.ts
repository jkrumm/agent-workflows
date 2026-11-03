/** mulberry32: a small seeded PRNG, so a bootstrap CI is reproducible under a seed. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function median(values: number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
}

/** Percentile bootstrap 95% CI of the median. */
export function bootstrapMedianCI(
  values: number[],
  options: { seed: number; iterations?: number },
): [number, number] | null {
  if (values.length < 2) return null
  const random = seededRandom(options.seed)
  const iterations = options.iterations ?? 2000
  const medians: number[] = []
  const sample = new Array<number>(values.length)
  for (let i = 0; i < iterations; i++) {
    for (let j = 0; j < values.length; j++) sample[j] = values[Math.floor(random() * values.length)] as number
    medians.push(median(sample) as number)
  }
  medians.sort((a, b) => a - b)
  const lo = medians[Math.floor(0.025 * iterations)] as number
  const hi = medians[Math.min(iterations - 1, Math.ceil(0.975 * iterations) - 1)] as number
  return [lo, hi]
}

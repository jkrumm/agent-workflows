import { seededRandom } from './harness/stats.ts'

/** A seeded Fisher–Yates shuffle: the same seed gives the same order. The input is not changed. */
export function shuffled<T>(items: readonly T[], seed: number): T[] {
  const random = seededRandom(seed)
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[out[i], out[j]] = [out[j] as T, out[i] as T]
  }
  return out
}

/** `n` items at random (all of them when fewer exist), seeded. */
export const sampleOf = <T>(items: readonly T[], n: number, seed: number): T[] => shuffled(items, seed).slice(0, n)

/**
 * The pair sample: half judge-positive, the rest judge-negative. When positives fall short of half, all of them go in
 * and negatives fill up to `total`; `shortfall` says by how much each side missed its quota.
 */
export function samplePairs<T>(input: {
  positives: readonly T[]
  negatives: readonly T[]
  total: number
  seed: number
}): { positives: T[]; negatives: T[]; shortfall: { positives: number; negatives: number } } {
  const half = Math.floor(input.total / 2)
  const positives = sampleOf(input.positives, half, input.seed)
  const wantNegatives = input.total - positives.length
  const negatives = sampleOf(input.negatives, wantNegatives, input.seed + 1)
  return {
    positives,
    negatives,
    shortfall: {
      positives: half - positives.length,
      negatives: Math.max(0, input.total - positives.length - negatives.length),
    },
  }
}

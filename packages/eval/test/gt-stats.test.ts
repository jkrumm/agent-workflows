import { describe, expect, test } from 'bun:test'
import { agreement, cohenKappa, kappaCI, sampleOf, samplePairs, shuffled, wilson } from '../src/index.ts'

describe('wilson', () => {
  test('5 of 10 is [0.2366, 0.7634]', () => {
    const w = wilson(5, 10)
    expect(w?.p).toBe(0.5)
    expect(w?.lo).toBeCloseTo(0.2366, 4)
    expect(w?.hi).toBeCloseTo(0.7634, 4)
  })

  test('0 of 10 has a lower bound of 0 and an upper of 0.2775', () => {
    const w = wilson(0, 10)
    expect(w?.lo).toBe(0)
    expect(w?.hi).toBeCloseTo(0.2775, 4)
  })

  test('45 of 50 (the case bar): [0.7864, 0.9565]', () => {
    const w = wilson(45, 50)
    expect(w?.lo).toBeCloseTo(0.7864, 3)
    expect(w?.hi).toBeCloseTo(0.9565, 3)
  })

  test('nothing to estimate without observations', () => {
    expect(wilson(0, 0)).toBeNull()
  })
})

describe('cohen kappa', () => {
  test('the textbook table 20/5/10/15 is 0.4 at 0.7 agreement', () => {
    const table = { yy: 20, yn: 5, ny: 10, nn: 15 }
    expect(agreement(table)).toBeCloseTo(0.7, 10)
    expect(cohenKappa(table)).toBeCloseTo(0.4, 10)
  })

  test('perfect agreement is 1, chance-level is 0', () => {
    expect(cohenKappa({ yy: 25, yn: 0, ny: 0, nn: 25 })).toBe(1)
    expect(cohenKappa({ yy: 25, yn: 25, ny: 25, nn: 25 })).toBe(0)
  })

  test('total disagreement is -1', () => {
    expect(cohenKappa({ yy: 0, yn: 10, ny: 10, nn: 0 })).toBe(-1)
  })

  test('undefined when both raters only ever say one thing, or there are no pairs', () => {
    expect(cohenKappa({ yy: 10, yn: 0, ny: 0, nn: 0 })).toBeNull()
    expect(cohenKappa({ yy: 0, yn: 0, ny: 0, nn: 0 })).toBeNull()
    expect(agreement({ yy: 0, yn: 0, ny: 0, nn: 0 })).toBeNull()
  })
})

describe('kappa interval', () => {
  test('brackets κ, narrows with n, stays inside [-1, 1]', () => {
    const small = kappaCI({ yy: 20, yn: 5, ny: 10, nn: 15 })
    const large = kappaCI({ yy: 200, yn: 50, ny: 100, nn: 150 })
    expect(small?.kappa).toBeCloseTo(0.4, 10)
    expect(small && small.lo < small.kappa && small.kappa < small.hi).toBe(true)
    expect((large?.hi ?? 0) - (large?.lo ?? 0)).toBeLessThan((small?.hi ?? 0) - (small?.lo ?? 0))
    const perfect = kappaCI({ yy: 25, yn: 0, ny: 0, nn: 25 })
    expect(perfect).toEqual({ kappa: 1, lo: 1, hi: 1 })
  })

  test('null where κ is undefined', () => {
    expect(kappaCI({ yy: 10, yn: 0, ny: 0, nn: 0 })).toBeNull()
    expect(kappaCI({ yy: 0, yn: 0, ny: 0, nn: 0 })).toBeNull()
  })
})

describe('sampling', () => {
  const items = Array.from({ length: 30 }, (_, i) => i)

  test('seeded: the same seed gives the same order, another seed another', () => {
    expect(shuffled(items, 1)).toEqual(shuffled(items, 1))
    expect(shuffled(items, 1)).not.toEqual(shuffled(items, 2))
    expect([...shuffled(items, 1)].sort((a, b) => a - b)).toEqual(items)
  })

  test('takes n, or all when fewer exist', () => {
    expect(sampleOf(items, 5, 1)).toHaveLength(5)
    expect(sampleOf(items, 99, 1)).toHaveLength(30)
  })

  test('pairs: half and half when both sides have enough', () => {
    const s = samplePairs({ positives: items, negatives: items.map((i) => i + 100), total: 20, seed: 1 })
    expect([s.positives.length, s.negatives.length]).toEqual([10, 10])
    expect(s.shortfall).toEqual({ positives: 0, negatives: 0 })
  })

  test('pairs: short of positives takes all of them, negatives fill, the shortfall is said', () => {
    const s = samplePairs({ positives: [1, 2, 3], negatives: items, total: 20, seed: 1 })
    expect([s.positives.length, s.negatives.length]).toEqual([3, 17])
    expect(s.shortfall).toEqual({ positives: 7, negatives: 0 })
  })

  test('pairs: short of both is reported on the negative side too', () => {
    const s = samplePairs({ positives: [1, 2], negatives: [9, 8, 7], total: 20, seed: 1 })
    expect(s.shortfall).toEqual({ positives: 8, negatives: 15 })
  })
})

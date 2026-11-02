import { describe, expect, test } from 'bun:test'
import { agreement, cohenKappa, sampleOf, samplePairs, scoreSession, shuffled, wilson } from '../src/index.ts'
import type { ManifestItem } from '../src/index.ts'

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

describe('scoreSession', () => {
  const at = '2026-11-02T10:00:00.000Z'
  const caseItem = (id: string, truth: 'accepted' | 'rejected'): ManifestItem => ({ kind: 'case', id, truth })
  const pairItem = (id: string, judgeClass: 'match' | 'real'): ManifestItem => ({
    kind: 'pair',
    id,
    caseId: 'c',
    judgeRunId: 'r',
    findingId: id,
    judgeClass,
  })
  const items: ManifestItem[] = [
    caseItem('a1', 'accepted'),
    caseItem('a2', 'accepted'),
    caseItem('a3', 'accepted'),
    caseItem('r1', 'rejected'),
    caseItem('r2', 'rejected'),
    pairItem('p1', 'match'),
    pairItem('p2', 'match'),
    pairItem('p3', 'real'),
    pairItem('p4', 'real'),
    pairItem('p5', 'real'),
  ]
  const c = (candidateId: string, verdict: 'yes' | 'no' | 'unsure') => ({
    kind: 'case' as const,
    candidateId,
    verdict,
    at,
  })
  const p = (pairId: string, verdict: 'yes' | 'no' | 'unsure') => ({ kind: 'pair' as const, pairId, verdict, at })

  test('case precision with its interval, what the filter loses, unsure counted apart', () => {
    const report = scoreSession(items, [
      c('a1', 'yes'),
      c('a2', 'no'),
      c('a3', 'unsure'),
      c('r1', 'yes'),
      c('r2', 'no'),
    ])
    expect(report.cases.accepted).toMatchObject({ shown: 3, yes: 1, no: 1, unsure: 1, precision: 0.5 })
    expect(report.cases.rejected).toMatchObject({ shown: 2, yes: 1, no: 1, lost: 0.5 })
    expect(report.bars.cases).toEqual({ threshold: 0.9, value: 0.5, met: false })
  })

  test('the later answer of an id wins; labels outside the session do not count', () => {
    const report = scoreSession(items, [c('a1', 'no'), c('a1', 'yes'), c('zzz', 'no')])
    expect(report.cases.accepted).toMatchObject({ yes: 1, no: 0, precision: 1 })
    expect(report.unanswered).toEqual({ cases: 4, pairs: 5 })
  })

  test('kappa over yes/no pairs, unsure excluded and counted, confusion by owner × judge', () => {
    const report = scoreSession(items, [
      p('p1', 'yes'),
      p('p2', 'no'),
      p('p3', 'no'),
      p('p4', 'yes'),
      p('p5', 'unsure'),
    ])
    expect(report.pairs).toMatchObject({
      shown: 5,
      n: 4,
      unsure: 1,
      agreement: 0.5,
      confusion: { yy: 1, yn: 1, ny: 1, nn: 1 },
    })
    expect(report.pairs.kappa).toBe(0)
    expect(report.bars.kappa).toEqual({ threshold: 0.8, value: 0, met: false })
  })

  test('without answers the bars are undecided, not failed', () => {
    const report = scoreSession(items, [])
    expect(report.bars.cases.met).toBeNull()
    expect(report.bars.kappa.met).toBeNull()
    expect(report.unanswered).toEqual({ cases: 5, pairs: 5 })
  })

  test('a clean session meets both bars', () => {
    const report = scoreSession(items, [
      c('a1', 'yes'),
      c('a2', 'yes'),
      c('a3', 'yes'),
      p('p1', 'yes'),
      p('p2', 'yes'),
      p('p3', 'no'),
      p('p4', 'no'),
      p('p5', 'no'),
    ])
    expect(report.bars.cases.met).toBe(true)
    expect(report.pairs.kappa).toBe(1)
    expect(report.bars.kappa.met).toBe(true)
  })
})

import { describe, expect, test } from 'bun:test'
import { type ArmRun, bootstrapMeanCI, compareArms, MIN_PAIRS } from '../src/compare.ts'

const run = (caseId: string, over: Partial<ArmRun> = {}): ArmRun => ({
  caseId,
  scores: { recall: 0.5 },
  pass: false,
  costUsd: 1,
  wallMs: 1000,
  tokens: 100,
  toolCalls: 4,
  ...over,
})

describe('compareArms', () => {
  test('known deltas: B recalls more, costs half, same wall; paired by case id', () => {
    const ids = Array.from({ length: 12 }, (_, i) => `c${i}`)
    const a = ids.map((id, i) => run(id, { scores: { recall: 0.4 + (i % 3) * 0.1 }, wallMs: 1000 + i }))
    const b = ids.map((id, i) =>
      run(id, { scores: { recall: 0.6 + (i % 3) * 0.1 }, pass: true, costUsd: 0.5, wallMs: 1000 + i }),
    )
    const result = compareArms([...a, run('only-a')], [...b, run('only-b')], { seed: 1 })
    expect(result.cases).toEqual({
      a: 13,
      b: 13,
      paired: 12,
      onlyA: ['only-a'],
      onlyB: ['only-b'],
      unpricedCost: { a: 0, b: 0 },
    })
    const by = Object.fromEntries(result.metrics.map((m) => [m.metric, m]))
    expect(by.recall?.meanDelta).toBeCloseTo(0.2, 10)
    expect(by.recall?.meanDeltaCi95?.[0]).toBeCloseTo(0.2, 10) // a constant delta: a zero-width CI
    expect(by.recall?.better).toBe('b')
    expect(by.pass).toMatchObject({ meanA: 0, meanB: 1, better: 'b' })
    expect(by.costUsd).toMatchObject({ direction: 'lower', meanDelta: -0.5, better: 'b' })
    expect(by.wallMs).toMatchObject({ meanDelta: 0, better: 'tie' })
    expect(result.bBetter).toEqual(['pass', 'recall', 'costUsd'])
    expect(result.bWorse).toEqual([])
    expect(result.metrics.map((m) => m.metric)).toEqual(['pass', 'recall', 'costUsd', 'wallMs', 'tokens', 'toolCalls'])
  })

  test('reruns of a case are averaged first; unpriced runs leave the pair out of cost, counted; A wins are reported', () => {
    const ids = ['p', 'q', 'r', 's', 't']
    const a = [run('x', { costUsd: 1 }), run('x', { costUsd: 3 }), ...ids.map((id) => run(id, { costUsd: 2 }))]
    const b = [
      run('x', { costUsd: 4.5 }),
      ...ids.map((id) => run(id, { costUsd: 4.5 })),
      run('z', { costUsd: null, unpriced: true }),
    ]
    const result = compareArms([...a, run('z', { costUsd: 2 })], b, { seed: 1 })
    const cost = result.metrics.find((m) => m.metric === 'costUsd')
    expect(cost).toMatchObject({ n: 6, meanA: 2, meanB: 4.5, meanDelta: 2.5, better: 'a' })
    expect(result.cases.paired).toBe(7)
    expect(result.cases.unpricedCost).toEqual({ a: 0, b: 1 })
    expect(result.bWorse).toContain('costUsd')
  })

  test(`below ${MIN_PAIRS} pairs nothing is decided, even with a clear CI; the bootstrap is seeded`, () => {
    const one = compareArms([run('x')], [run('x', { scores: { recall: 1 } })], { seed: 1 })
    expect(one.metrics.find((m) => m.metric === 'recall')).toMatchObject({
      n: 1,
      better: 'unknown',
      meanDeltaCi95: null,
    })
    const four = ['a', 'b', 'c', 'd']
    const few = compareArms(
      four.map((id) => run(id)),
      four.map((id) => run(id, { scores: { recall: 1 } })),
      { seed: 1 },
    )
    expect(few.metrics.find((m) => m.metric === 'recall')).toMatchObject({ n: 4, meanDelta: 0.5, better: 'unknown' })
    expect(few.bBetter).toEqual([])
    const values = [0.1, -0.2, 0.3, 0.05, 0.4, -0.1]
    expect(bootstrapMeanCI(values, { seed: 7 })).toEqual(bootstrapMeanCI(values, { seed: 7 }))
    expect(bootstrapMeanCI([1], { seed: 7 })).toBeNull()
  })
})

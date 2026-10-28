import { describe, expect, test } from 'bun:test'
import { type ArmRun, bootstrapMeanCI, compareArms } from '../src/compare.ts'

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
    expect(result.cases).toEqual({ a: 13, b: 13, paired: 12, onlyA: ['only-a'], onlyB: ['only-b'] })
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

  test('reruns of a case are averaged first; a missing value leaves that pair out; A wins are reported', () => {
    const a = [run('x', { costUsd: 1 }), run('x', { costUsd: 3 }), run('y', { costUsd: 2 }), run('z', { costUsd: 2 })]
    const b = [run('x', { costUsd: 4 }), run('y', { costUsd: 5 }), run('z', { costUsd: null })]
    const cost = compareArms(a, b, { seed: 1 }).metrics.find((m) => m.metric === 'costUsd')
    expect(cost).toMatchObject({ n: 2, meanA: 2, meanB: 4.5, meanDelta: 2.5, better: 'a' })
  })

  test('below two pairs nothing is decided; the bootstrap is seeded', () => {
    const one = compareArms([run('x')], [run('x', { scores: { recall: 1 } })], { seed: 1 })
    expect(one.metrics.find((m) => m.metric === 'recall')).toMatchObject({
      n: 1,
      better: 'unknown',
      meanDeltaCi95: null,
    })
    const values = [0.1, -0.2, 0.3, 0.05, 0.4, -0.1]
    expect(bootstrapMeanCI(values, { seed: 7 })).toEqual(bootstrapMeanCI(values, { seed: 7 }))
    expect(bootstrapMeanCI([1], { seed: 7 })).toBeNull()
  })
})

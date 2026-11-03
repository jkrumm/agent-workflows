import { describe, expect, test } from 'bun:test'
import type { Json, ScorerContext } from '@agent-workflows/runtime'
import { type CheckReference, checkReference, checkScorer } from '../src/workflows/check/scorer.ts'

const signal = new AbortController().signal

const ctx = <R>(reference?: R): ScorerContext<R> => ({
  source: reference ? 'regression' : 'drift',
  signal,
  ...(reference ? { reference } : {}),
})

describe('check scorer', () => {
  const output = (over: Record<string, Json> = {}): Json => ({
    passed: false,
    steps: [
      { name: 'lint', passed: true },
      { name: 'test', passed: false, errors: ['1 failing'] },
    ],
    summary: '1/2 failed',
    ...over,
  })

  test('structure without a reference', async () => {
    expect(await checkScorer.score({ cwd: '/r' }, output(), ctx())).toEqual({
      scores: { valid: 1, reported: 1, evidence: 1, consistent: 1 },
      pass: true,
    })
    const thin = await checkScorer.score(
      { cwd: '/r', commands: ['a', 'b', 'c', 'd'] },
      output({ steps: [{ name: 'test', passed: false }], passed: true }),
      ctx(),
    )
    expect(thin.scores).toEqual({ valid: 1, reported: 0.25, evidence: 0, consistent: 0 })
    expect(thin.pass).toBe(false)
    expect(await checkScorer.score({ cwd: '/r' }, 'garbage', ctx())).toMatchObject({
      scores: { valid: 0 },
      pass: false,
    })
    expect((await checkScorer.score({ cwd: '/r' }, output({ passed: true, steps: [] }), ctx())).scores.consistent).toBe(
      0,
    )
  })

  test('with a reference: outcome and per-step agreement', async () => {
    const reference: CheckReference = {
      passed: false,
      steps: [
        { name: 'lint', passed: false },
        { name: 'test', passed: false },
        { name: 'format', passed: true },
      ],
    }
    const verdict = await checkScorer.score({ cwd: '/r' }, output(), ctx(reference))
    expect(verdict.scores).toMatchObject({ outcomeAgreement: 1, stepAgreement: 0.5 })
    expect(verdict.pass).toBe(true)
    const flipped = await checkScorer.score({ cwd: '/r' }, output(), ctx({ passed: true, steps: [] }))
    expect(flipped.scores.outcomeAgreement).toBe(0)
    expect(flipped.scores.stepAgreement).toBeUndefined()
    expect(checkReference({ passed: true, steps: [{ name: 'lint', passed: true }] })).toEqual({
      passed: true,
      steps: [{ name: 'lint', passed: true }],
    })
  })
})

import { describe, expect, test } from 'bun:test'
import type { Json, ScorerContext } from '@agent-workflows/runtime'
import { type CheckReference, checkReference, checkScorer } from '../src/workflows/check/scorer.ts'
import { type ReviewReference, reviewReference, reviewScorer } from '../src/workflows/review/scorer.ts'
import {
  allFailedVerdict,
  applyVerdictRules,
  balanceDegradedVerdict,
  salvagedVerdict,
} from '../src/workflows/review/verdict.ts'

const signal = new AbortController().signal
const ctx = <R>(reference?: R): ScorerContext<R> => ({
  source: reference ? 'regression' : 'drift',
  signal,
  ...(reference ? { reference } : {}),
})
const reviewInput = { cwd: '/tmp/repo' }

const synthesis = {
  outcome: 'actionable' as const,
  blocking: [
    { file: 'src/a.ts', line: 10, message: 'Null dereference when the user list is empty', angle: 'senior-dev' },
    { file: 'src/b.ts', message: 'Token leaks into the log line', angle: 'security' },
  ],
  improvements: [{ file: 'src/c.ts', line: 3, message: 'Rename x', angle: 'architect' }],
  discussions: [],
  testGaps: [],
  summary: 'Two blocking findings.',
}
const review = (failed: { angle: string; failureReason: string }[] = []) => ({
  ...applyVerdictRules(synthesis, failed, 6).verdict,
  schemaVersion: 2,
})

describe('review scorer', () => {
  test('structure without a reference: valid, complete, all angles, decided, located share', async () => {
    const verdict = await reviewScorer.score(reviewInput, review(), ctx())
    expect(verdict).toEqual({
      scores: { valid: 1, complete: 1, angleSuccess: 1, decided: 1, located: 2 / 3 },
      pass: true,
    })
  })

  test('failed angles, salvage, provider balance and invalid output', async () => {
    const partial = await reviewScorer.score(reviewInput, review([{ angle: 'qa', failureReason: 'idle' }]), ctx())
    expect(partial.scores).toMatchObject({ angleSuccess: 1 - 1 / 6, decided: 0, complete: 1 })
    expect(partial).toMatchObject({ pass: false, feedback: 'reviewers failed' })

    const all = await reviewScorer.score(reviewInput, allFailedVerdict([{ angle: 'qa', failureReason: 'x' }], 6), ctx())
    expect(all.scores.angleSuccess).toBe(0)

    const salvaged = await reviewScorer.score(reviewInput, salvagedVerdict('raw text', [], 6), ctx())
    expect(salvaged.scores).toMatchObject({ complete: 0, angleSuccess: 1 })
    expect(salvaged.feedback).toContain('no synthesized verdict')

    const balance = await reviewScorer.score(reviewInput, balanceDegradedVerdict([]), ctx())
    expect(balance.scores.complete).toBe(0)

    const invalid = await reviewScorer.score(reviewInput, { nope: true }, ctx())
    expect(invalid).toEqual({
      scores: { valid: 0, complete: 0, angleSuccess: 0, decided: 0, located: 0 },
      pass: false,
      feedback: 'the output is not REVIEW_OUTPUT v2',
    })
  })

  test('with a reference: recall and precision through the harness matcher, outcome agreement', async () => {
    const reference: ReviewReference = {
      outcome: 'actionable',
      blocking: [
        { file: 'src/a.ts', line: 12, message: 'Empty user list causes a null dereference' },
        { file: 'src/z.ts', line: 1, message: 'Missing migration rollback' },
      ],
    }
    const verdict = await reviewScorer.score(reviewInput, review(), ctx(reference))
    expect(verdict.scores).toMatchObject({ outcomeAgreement: 1, recall: 0.5, precision: 0.5 })
    expect(verdict.pass).toBe(true)

    const clean = await reviewScorer.score(reviewInput, review(), ctx({ outcome: 'clean' as const, blocking: [] }))
    expect(clean.scores).toMatchObject({ outcomeAgreement: 0, precision: 0 })
    expect(clean.scores.recall).toBeUndefined()
    expect(clean).toMatchObject({ pass: false, feedback: 'outcome actionable, expected clean' })

    const failedRun = await reviewScorer.score(reviewInput, null, ctx(reference))
    expect(failedRun).toMatchObject({
      scores: { outcomeAgreement: 0, recall: 0 },
      pass: false,
      feedback: 'the run failed',
    })
  })

  test('the reference of a recorded case keeps blocking findings only', () => {
    expect(
      reviewReference({
        outcome: 'actionable',
        findings: [
          { severity: 'blocking', file: 'a.ts', line: 1, message: 'm', angle: 'qa' } as never,
          { severity: 'improvement', file: 'b.ts', message: 'n' },
        ],
      }),
    ).toEqual({ outcome: 'actionable', blocking: [{ file: 'a.ts', line: 1, message: 'm' }] })
    expect(reviewScorer.reference?.safeParse(reviewReference({ outcome: 'clean', findings: [] })).success).toBe(true)
  })
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

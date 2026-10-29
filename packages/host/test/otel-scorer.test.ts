import { describe, expect, test } from 'bun:test'
import type { Json, ScoreJudge } from '@agent-workflows/runtime'
import { otelScorer } from '../src/workflows/otel/scorer.ts'
import type { OtelInputValue } from '../src/workflows/otel/schema.ts'

const input: OtelInputValue = { investigation: 'checkout errors', env: 'prod' }
const reference = {
  status: 'errors' as const,
  facts: ['checkout has about 140 error spans', 'payments db refuses connections'],
}

const result = (over: Record<string, Json> = {}): Json => ({
  status: 'errors',
  environment: 'prod',
  timeRange: 'last 2h',
  findings: [
    { service: 'checkout', summary: '142 error spans', severity: 'error', evidence: 'q3', unverified: false },
    { service: 'payments', summary: 'db refused', severity: 'error', evidence: 'x', unverified: true },
  ],
  recommendations: ['check payments-db'],
  hyperdx: { connected: true },
  queries: [],
  warnings: [],
  ...over,
})

/** A judge that answers every fact question by its position: `true` for the facts in `stated`. */
const judging =
  (stated: number[], seen: { state?: string; questions?: Json }[] = []): ScoreJudge =>
  async (capability, body) => {
    expect(capability).toBe('decide')
    const { state, questions } = body as { state: string; questions: Record<string, unknown> }
    seen.push({ state, questions: questions as Json })
    return {
      answers: Object.fromEntries(
        Object.keys(questions).map((key, i) => [
          key,
          { type: 'boolean', value: stated.includes(i), confidence: 0.9, probability: 0.9 },
        ]),
      ),
    }
  }

const ctx = (judge?: ScoreJudge, ref: typeof reference | null = reference) => ({
  source: 'regression' as const,
  signal: new AbortController().signal,
  ...(ref ? { reference: ref } : {}),
  ...(judge ? { judge } : {}),
})

describe('otel scorer', () => {
  test('valid, status, facts (judged per fact) and grounded (code) for the new arm', async () => {
    const seen: { state?: string; questions?: Json }[] = []
    const verdict = await otelScorer.score(input, result(), ctx(judging([0], seen)))
    expect(verdict.scores).toEqual({ valid: 1, grounded: 0.5, status: 1, facts: 0.5 })
    expect(verdict.pass).toBe(false)
    expect(verdict.feedback).toBe('ungrounded finding(s); 1 fact(s) missed')
    expect(Object.keys(seen[0]?.questions as object)).toEqual(['fact0', 'fact1'])
    expect(seen[0]?.state).toContain('Status: errors')
    expect(seen[0]?.state).toContain('checkout: 142 error spans (evidence: q3)')
  })

  test('passes when the status matches and every fact is stated', async () => {
    const verdict = await otelScorer.score(input, result({ findings: [] }), ctx(judging([0, 1])))
    expect(verdict.scores).toEqual({ valid: 1, status: 1, facts: 1 }) // no findings: grounded left out
    expect(verdict.pass).toBe(true)
  })

  test('a wrong status fails; without a judge facts are unscored and never pass', async () => {
    const wrong = await otelScorer.score(input, result({ status: 'healthy' }), ctx(judging([0, 1])))
    expect(wrong.scores.status).toBe(0)
    expect(wrong.pass).toBe(false)
    const unjudged = await otelScorer.score(input, result(), ctx())
    expect(unjudged.scores.facts).toBeUndefined()
    expect(unjudged.pass).toBe(false)
  })

  test('the legacy arm is scored by the same function: no queries, no grounded', async () => {
    const legacy = { ...(result() as Record<string, Json>) }
    delete legacy.queries
    delete legacy.hyperdx
    delete legacy.warnings
    legacy.findings = [{ service: 'checkout', summary: '142 error spans', severity: 'error' }]
    legacy.hyperdx = 'connected'
    const verdict = await otelScorer.score(input, legacy, ctx(judging([0, 1])))
    expect(verdict.scores).toEqual({ valid: 1, status: 1, facts: 1 })
    expect(verdict.pass).toBe(true)
  })

  test('a failed run or a wrong shape scores 0 everywhere', async () => {
    for (const output of [null, { status: 'fine' }, 'text'] as Json[]) {
      const verdict = await otelScorer.score(input, output, ctx(judging([0, 1])))
      expect(verdict).toMatchObject({ scores: { valid: 0, status: 0, facts: 0 }, pass: false })
    }
  })

  test('without a reference only the shape and grounding are scored, and a valid run passes', async () => {
    const verdict = await otelScorer.score(input, result(), ctx(undefined, null))
    expect(verdict.scores).toEqual({ valid: 1, grounded: 0.5 })
    expect(verdict.pass).toBe(true)
  })

  test('the reference is 1-3 facts and a status', () => {
    const parse = (value: unknown) => otelScorer.reference?.safeParse(value).success
    expect(parse(reference)).toBe(true)
    expect(parse({ status: 'errors', facts: [] })).toBe(false)
    expect(parse({ status: 'errors', facts: ['a', 'b', 'c', 'd'] })).toBe(false)
    expect(parse({ status: 'fine', facts: ['a'] })).toBe(false)
  })
})

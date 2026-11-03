import { describe, expect, test } from 'bun:test'
import type { Verdict } from '@agent-workflows/runtime'
import { plainSuite } from '../src/workflows/suite.ts'
import { OVERVIEW_INPUT } from '../src/workflows/overview/index.ts'
import { CASES_PATH } from '../src/workflows/overview/module.ts'
import { OVERVIEW_SCORER_VERSION, OverviewReference, overviewScorer } from '../src/workflows/overview/scorer.ts'

const score = (...args: Parameters<typeof overviewScorer.score>) => overviewScorer.score(...args) as Verdict
const ctx = (reference?: OverviewReference) => ({
  source: 'regression' as const,
  reference,
  signal: new AbortController().signal,
})
const fixture = { generatedAt: 1, projects: [{ agents: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }] }
const verdict = (id: string, recommendation: string, synthesized = false) => ({
  id,
  sessionId: null,
  project: 'p',
  recommendation,
  standing: null,
  blocker: null,
  confidence: 'high',
  ...(synthesized ? { synthesized: true } : {}),
})
const output = (...agents: ReturnType<typeof verdict>[]) => ({
  generatedAt: 2,
  model: 'm',
  snapshotGeneratedAt: 1,
  agents,
})
const reference = OverviewReference.parse({ agents: { a: 'answer', b: ['merge', 'review'], c: 'watch' } })

describe('overview scorer', () => {
  test('a perfect answer passes with every score 1; an accepted alternative counts', () => {
    const v = score(
      { fixture },
      output(verdict('a', 'answer'), verdict('b', 'review'), verdict('c', 'watch')),
      ctx(reference),
    )
    expect(v.pass).toBe(true)
    expect(v.scores).toEqual({ valid: 1, answered: 1, match: 1 })
  })

  test('a partial answer scores the share that matched and names the misses', () => {
    const v = score(
      { fixture },
      output(verdict('a', 'continue'), verdict('b', 'merge'), verdict('c', 'watch')),
      ctx(reference),
    )
    expect(v.pass).toBe(false)
    expect(v.scores.match).toBeCloseTo(2 / 3)
    expect(v.feedback).toContain('a: continue (want answer)')
  })

  test('a synthesized placeholder is not an answer and never matches, even when it says what was expected', () => {
    const v = score(
      { fixture },
      output(verdict('a', 'answer'), verdict('b', 'merge'), verdict('c', 'watch', true)),
      ctx(reference),
    )
    expect(v.scores.answered).toBeCloseTo(2 / 3)
    expect(v.scores.match).toBeCloseTo(2 / 3)
    expect(v.pass).toBe(false)
  })

  test('a missing, extra or repeated agent, a bad enum and a failed run score zero everywhere', () => {
    const zero = { valid: 0, answered: 0, match: 0 }
    expect(score({ fixture }, output(verdict('a', 'answer'), verdict('b', 'merge')), ctx(reference)).scores).toEqual(
      zero,
    )
    expect(
      score({ fixture }, output(...['a', 'b', 'c', 'd'].map((id) => verdict(id, 'watch'))), ctx(reference)).feedback,
    ).toContain('unexpected d')
    expect(
      score(
        { fixture },
        output(verdict('a', 'watch'), verdict('a', 'watch'), verdict('b', 'watch'), verdict('c', 'watch')),
        ctx(reference),
      ).feedback,
    ).toContain('repeated: a')
    expect(
      score({ fixture }, output(verdict('a', 'explode'), verdict('b', 'watch'), verdict('c', 'watch')), ctx(reference))
        .scores,
    ).toEqual(zero)
    expect(score({ fixture }, null, ctx(reference)).feedback).toBe('the run failed')
  })

  test('without a reference (drift) it checks validity only', () => {
    expect(score({}, output(verdict('a', 'watch')), ctx()).pass).toBe(true)
    expect(score({}, { nope: true }, ctx()).pass).toBe(false)
  })
})

describe('overview suite', () => {
  const cases = plainSuite.read(CASES_PATH)

  test('the committed cases parse, ids are unique and the reference names exactly the fixture agents', () => {
    expect(cases.length).toBeGreaterThanOrEqual(5)
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length)
    expect(OVERVIEW_SCORER_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/)
    for (const c of cases) {
      const input = OVERVIEW_INPUT.parse(c.input('', {}))
      const want = OverviewReference.parse(c.reference)
      const ids = input.fixture?.projects.flatMap((p) => p.agents.map((a) => a.id)) ?? []
      expect(ids.toSorted()).toEqual(Object.keys(want.agents).toSorted())
      expect(new Set(ids).size).toBe(ids.length)
    }
  })

  test('the committed cases hold no host path or address', () => {
    const text = Bun.file(CASES_PATH).text()
    return text.then((t) => expect(t).not.toMatch(/\/Users\/|\/home\/|\b\d{1,3}(\.\d{1,3}){3}\b|\.ts\.net/))
  })
})

import { describe, expect, test } from 'bun:test'
import type { Verdict } from '@agent-workflows/runtime'
import { detectLanguage, lintProse } from '../src/workflows/prose/lint.ts'
import { CASES_PATH } from '../src/workflows/prose-polish/module.ts'
import {
  PROSE_POLISH_SCORER_VERSION,
  ProsePolishReference,
  prosePolishScorer,
} from '../src/workflows/prose-polish/scorer.ts'
import { ProsePolishInput } from '../src/workflows/prose-polish/schema.ts'
import { plainSuite } from '../src/workflows/suite.ts'

const score = (...args: Parameters<typeof prosePolishScorer.score>) => prosePolishScorer.score(...args) as Verdict
const ctx = (reference?: ProsePolishReference) => ({
  source: 'regression' as const,
  reference,
  signal: new AbortController().signal,
})

const draft =
  'Our queue is a robust and seamless way to leverage Postgres. It handles 12000 jobs per minute at a median of 14 ms on a 4-core machine.'
const input = ProsePolishInput.parse({ text: draft, medium: 'article' })
const reference = ProsePolishReference.parse({
  gone: ['robust', 'seamless', 'leverag'],
  keep: ['Postgres', '12000', '14 ms', '4-core'],
})

/** The result the workflow would return for `text`, lint recomputed as the gate does. */
function polished(text: string, kept: 'rewrite' | 'original' = 'rewrite') {
  const findings = lintProse(text, 'en')
  return {
    kept,
    text,
    language: 'en',
    format: 'markdown',
    mediumNote: 'n',
    lint: { before: lintProse(draft, 'en').length, after: findings.length, findings },
    review: {
      scores: {
        structure: 4,
        no_repetition: 4,
        concision: 4,
        precision: 4,
        clarity: 4,
        visual_fit: 4,
        naturalness: 4,
        engagement: 4,
      },
      notes: [],
    },
    visualSuggestions: [],
    models: { writer: 'w', reviewer: 'r' },
    cost: null,
  }
}
const good =
  'Our queue runs background jobs on Postgres. It handles 12000 jobs per minute at a median of 14 ms on a 4-core machine.'

describe('prose-polish scorer', () => {
  test('a clean rewrite that keeps the facts passes with every score 1', () => {
    const v = score(input, polished(good), ctx(reference))
    expect(v.pass).toBe(true)
    expect(v.scores).toEqual({ valid: 1, honest: 1, notWorse: 1, fixed: 1, gone: 1, facts: 1, length: 1 })
  })

  test('the original kept on a draft with issues is safe but not good: fixed and gone fail', () => {
    const v = score(input, polished(draft, 'original'), ctx(reference))
    expect(v.scores).toMatchObject({ valid: 1, honest: 1, notWorse: 1, fixed: 0, gone: 0, facts: 1 })
    expect(v.pass).toBe(false)
  })

  test('a partial rewrite scores the share of planted phrases removed and facts kept', () => {
    const half =
      'Our queue is a robust way to run jobs on Postgres. It handles 12000 jobs per minute on a 4-core machine.'
    const v = score(input, polished(half), ctx(reference))
    expect(v.scores.gone).toBeCloseTo(2 / 3)
    expect(v.scores.facts).toBe(0.75)
    expect(v.feedback).toContain('still in the text: robust')
    expect(v.feedback).toContain('lost: 14 ms')
  })

  test('a rewrite with more lint, a made-up lint count or a changed "original" is not honest or worse', () => {
    const worse = polished(`${draft} It is crucial and pivotal to unlock this.`)
    expect(score(input, worse, ctx(reference)).scores.notWorse).toBe(0)
    const lying = { ...polished(good), lint: { before: 9, after: 0, findings: [] } }
    expect(score(input, lying, ctx(reference)).scores.honest).toBe(0)
    const edited = polished(good, 'original')
    expect(score(input, edited, ctx(reference)).scores.honest).toBe(0)
  })

  test('a text outside the length band fails length', () => {
    const v = score(input, polished('Queue on Postgres: 12000 jobs, 14 ms, 4-core.'), ctx(reference))
    expect(v.scores.length).toBe(0)
    expect(v.scores.facts).toBe(1)
  })

  test('a clean draft needs no fix', () => {
    const clean = ProsePolishInput.parse({ text: good, medium: 'chat' })
    const out = { ...polished(good), lint: { before: 0, after: 0, findings: [] } }
    expect(score(clean, out, ctx(ProsePolishReference.parse({ keep: ['12000'] }))).pass).toBe(true)
  })

  test('broken output and a failed run score zero everywhere; no reference checks honesty only', () => {
    expect(score(input, { kept: 'maybe' }, ctx(reference)).scores).toMatchObject({ valid: 0, honest: 0 })
    expect(score(input, null, ctx(reference)).feedback).toBe('the run failed')
    expect(score(input, polished(good), ctx()).pass).toBe(true)
  })
})

describe('prose-polish suite', () => {
  const cases = plainSuite.read(CASES_PATH)

  test('the committed cases parse as workflow input and reference, with unique ids', () => {
    expect(cases.length).toBeGreaterThanOrEqual(5)
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length)
    expect(PROSE_POLISH_SCORER_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/)
    for (const c of cases) {
      ProsePolishInput.parse(c.input('', {}))
      ProsePolishReference.parse(c.reference)
    }
  })

  test('every planted phrase is in its draft and every must-keep fact too; a draft with `gone` has lint findings', () => {
    for (const c of cases) {
      const text = String((c.input('', {}) as { text: string }).text)
      const want = ProsePolishReference.parse(c.reference)
      for (const g of want.gone) expect(text.toLowerCase()).toContain(g.toLowerCase())
      for (const k of want.keep) expect(text).toContain(k)
    }
  })

  test('the planted drafts really trip the lint and the control does not', () => {
    for (const c of cases) {
      const { text } = ProsePolishInput.parse(c.input('', {}))
      const findings = lintProse(text, detectLanguage(text))
      if (c.id.includes('control')) expect(findings).toHaveLength(0)
      else expect(findings.length).toBeGreaterThan(0)
    }
  })
})

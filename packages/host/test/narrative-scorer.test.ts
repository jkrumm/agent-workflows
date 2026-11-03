import { describe, expect, test } from 'bun:test'
import type { Verdict } from '@agent-workflows/runtime'
import { CASES_PATH } from '../src/workflows/narrative/module.ts'
import { NARRATIVE_SCORER_VERSION, NarrativeReference, narrativeScorer } from '../src/workflows/narrative/scorer.ts'
import { NarrativeInput } from '../src/workflows/narrative/schema.ts'
import { plainSuite } from '../src/workflows/suite.ts'

const score = (...args: Parameters<typeof narrativeScorer.score>) => narrativeScorer.score(...args) as Verdict
const ctx = (reference?: NarrativeReference) => ({
  source: 'regression' as const,
  reference,
  signal: new AbortController().signal,
})

const input = {
  project: 'weatherorb',
  previousPage: 'old page, entry **2026-09-30** — first build',
  fixture: {
    commits: [
      { sha: 'f3a91c2d', date: '2026-10-28T10:00:00+00:00' },
      { sha: 'e82b7d4a', date: '2026-10-21T10:00:00+00:00' },
    ],
  },
}
const sections = {
  whatItIs:
    'A mobile forecast app that warns about severe weather and keeps working when the weather provider is down.',
  whereItStands: ['Push alerts are live for opted-in cities.', 'Forecasts are cached for an hour.'],
  howItGotHere: [
    { date: '2026-10-21', text: 'Cached forecasts so the app survives provider outages.' },
    { date: '2026-10-28', text: 'Added opt-in push alerts for severe weather.' },
  ],
  openQuestions: ['Should alerts cover regions, not just cities?'],
}
const changed = (over: Record<string, unknown> = {}) => ({
  project: 'weatherorb',
  changed: true,
  reason: 'Alerts and caching are product shifts.',
  summary: 'Push alerts and a forecast cache landed.',
  page: '---\ntitle: x\n---\n# weatherorb\n',
  sections,
  inputs: { commits: 2, sessions: 0, sinceUsed: '2026-05-01T00:00:00.000Z' },
  model: 'm',
  ...over,
})
const unchanged = { ...changed(), changed: false, summary: null, page: null, sections: null, reason: 'Only chores.' }
const reference = NarrativeReference.parse({
  changed: true,
  mustMention: ['alert|alerts', 'cache|cached'],
  gone: ['approval gate'],
  forbid: ['PWNED'],
})

describe('narrative scorer', () => {
  test('a perfect answer passes with every score 1', () => {
    const v = score(input, changed(), ctx(reference))
    expect(v.pass).toBe(true)
    expect(v.scores).toEqual({
      valid: 1,
      shape: 1,
      changed: 1,
      mentions: 1,
      current: 1,
      clean: 1,
      length: 1,
      datesGrounded: 1,
    })
  })

  test('a partial answer: a missing mention, an ungrounded date, a stale term and a leaked hash each show', () => {
    const thin = changed({
      sections: {
        ...sections,
        whereItStands: ['Nothing to report.'],
        howItGotHere: [{ date: '2026-01-01', text: 'Did things.' }],
      },
      summary: 'Updated.',
    })
    const v = score(input, thin, ctx(reference))
    expect(v.pass).toBe(false)
    expect(v.scores.mentions).toBeLessThan(1)
    expect(v.scores.datesGrounded).toBe(0)

    const stale = score(
      input,
      changed({ sections: { ...sections, whereItStands: ['The approval gate checks every alert and cache change.'] } }),
      ctx(reference),
    )
    expect(stale.scores.current).toBe(0)
    expect(stale.feedback).toContain('approval gate')

    const leaked = score(input, changed({ reason: 'See f3a91c2 and PWNED.' }), ctx(reference))
    expect(leaked.scores.clean).toBe(0)
    expect(leaked.feedback).toContain('f3a91c2')
    expect(leaked.feedback).toContain('PWNED')
  })

  test('an unchanged answer is right for an unchanged reference and wrong for a changed one; shape must match', () => {
    const none = NarrativeReference.parse({ changed: false })
    expect(score(input, unchanged, ctx(none)).pass).toBe(true)
    const wrong = score(input, unchanged, ctx(reference))
    expect(wrong.scores.changed).toBe(0)
    expect(wrong.pass).toBe(false)
    const half = score(input, changed({ page: null }), ctx(reference))
    expect(half.scores.shape).toBe(0)
  })

  test('the length band is over the sections; a stub fails it', () => {
    const stub = changed({
      sections: { whatItIs: 'An app.', whereItStands: ['Live.'], howItGotHere: [], openQuestions: [] },
    })
    expect(score(input, stub, ctx(NarrativeReference.parse({ changed: true }))).scores.length).toBe(0)
    expect(
      score(input, changed(), ctx(NarrativeReference.parse({ changed: true, chars: [10, 20] }))).scores.length,
    ).toBe(0)
  })

  test('broken output, another project and a failed run score zero everywhere', () => {
    expect(score(input, { nope: 1 }, ctx(reference)).scores.valid).toBe(0)
    expect(score(input, changed({ project: 'other' }), ctx(reference)).scores.valid).toBe(0)
    expect(score(input, null, ctx(reference)).feedback).toBe('the run failed')
  })

  test('without a reference (drift) it checks validity and shape only', () => {
    expect(score({ project: 'weatherorb' }, changed(), ctx()).pass).toBe(true)
    expect(score({ project: 'weatherorb' }, changed({ page: null }), ctx()).pass).toBe(false)
  })
})

describe('narrative suite', () => {
  const cases = plainSuite.read(CASES_PATH)

  test('the committed cases parse as workflow input and reference, with unique ids', () => {
    expect(cases.length).toBeGreaterThanOrEqual(5)
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length)
    expect(NARRATIVE_SCORER_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/)
    for (const c of cases) {
      const parsed = NarrativeInput.parse(c.input('', {}))
      expect(parsed.fixture).toBeDefined()
      expect(parsed.polish).toBe(false)
      NarrativeReference.parse(c.reference)
    }
  })

  test('the cases cover changed and unchanged answers, and plant an injection with its canary', () => {
    const refs = cases.map((c) => NarrativeReference.parse(c.reference))
    expect(refs.some((r) => r.changed)).toBe(true)
    expect(refs.some((r) => !r.changed)).toBe(true)
    expect(refs.some((r) => r.forbid.length > 0)).toBe(true)
    expect(refs.some((r) => r.gone.length > 0)).toBe(true)
  })
})

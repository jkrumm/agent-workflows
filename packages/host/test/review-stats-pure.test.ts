import { describe, expect, test } from 'bun:test'
import type { StatsFinding, StatsJob } from '../src/review/ledger.ts'
import { computeStats, normalizeRule, percentile } from '../src/review/stats.ts'

describe('normalizeRule', () => {
  const cases: [string, string][] = [
    ['sensitive path: packages/runtime/a.ts', 'sensitive path'],
    ['sensitive path: packages/runtime/a.ts (+2)', 'sensitive path'],
    ['sensitive path: x (fix round, thread already deep)', 'sensitive path (fix round)'],
    ['sensitive path: x (+2) (fix round, thread already deep)', 'sensitive path (fix round)'],
    ['912 changed non-test code lines > 800', 'size'],
    ['4 packages > 3: a cross-package change', 'cross-package'],
    ['small: 12 code lines in 2 files', 'small'],
    ['small: 12 code lines in 2 files (raised by caller from light)', 'small (raised by caller)'],
    ['default (raised by caller from standard)', 'default (raised by caller)'],
    ['sensitive path: x (raised by caller from standard)', 'sensitive path (raised by caller)'],
    ['classifier: deep (rules left it open)', 'classifier'],
    ['tests only', 'tests only'],
    ['a manifest changed (dependencies)', 'a manifest changed (dependencies)'],
  ]
  test.each(cases)('%s → %s', (rule, key) => expect(normalizeRule(rule)).toBe(key))
})

describe('percentile', () => {
  test('nearest rank; empty is null', () => {
    expect(percentile([], 0.5)).toBeNull()
    expect(percentile([7], 0.5)).toBe(7)
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2)
    expect(percentile([1, 2, 3], 0.5)).toBe(2)
    expect(percentile([1, 2, 3, 4], 1)).toBe(4)
  })
})

describe('computeStats', () => {
  const job = (id: string, extra: Partial<StatsJob> = {}): StatsJob => ({
    id,
    repo: 'r',
    thread: 't',
    tier: 'standard',
    rule: 'default',
    round: 1,
    state: 'submitted',
    reviewerPrompt: null,
    outcome: 'clean',
    wallS: 10,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...extra,
  })
  const finding = (jobId: string, extra: Partial<StatsFinding> = {}): StatsFinding => ({
    jobId,
    tag: 'important',
    disposition: 'open',
    lineValid: null,
    anchored: null,
    ...extra,
  })

  test('empty ledger: null ratios, zero counts', () => {
    const out = computeStats({ jobs: [], findings: [], by: 'tier', since: null })
    expect(out.groups).toEqual([])
    expect(out.total).toMatchObject({
      jobs: 0,
      wallS: { p50: null, max: null },
      round1: { jobs: 0, clean: 0, cleanRate: null },
      precision: { important: null, nit: null },
      anchoredShare: null,
      lineValidShare: null,
      deepRound2: { count: 0, share: null },
      stalled: 0,
    })
  })

  test('tier groups are ordered by tier, findings follow their job', () => {
    const out = computeStats({
      jobs: [job('a', { tier: 'deep' }), job('b', { tier: 'light' }), job('c', { tier: 'deep', round: 2 })],
      findings: [finding('a'), finding('b', { tag: 'nit' })],
      by: 'tier',
      since: null,
    })
    expect(out.groups.map((g) => [g.key, g.jobs, g.findings.important, g.findings.nit])).toEqual([
      ['light', 1, 0, 1],
      ['deep', 2, 1, 0],
    ])
    expect(out.groups[1]?.deepRound2).toEqual({ count: 1, share: 0.5 })
  })

  test('stalled: a thread whose last submitted round was actionable and that no prepared round followed', () => {
    const at = (n: number) => new Date(`2026-01-0${n}T00:00:00Z`)
    const out = computeStats({
      jobs: [
        // stopped on round 1
        job('s1', { thread: 'stopped', outcome: 'actionable', createdAt: at(1) }),
        // a fix round followed and was clean
        job('f1', { thread: 'fixed', outcome: 'actionable', createdAt: at(1) }),
        job('f2', { thread: 'fixed', round: 2, outcome: 'clean', createdAt: at(2) }),
        // a re-review is in flight
        job('p1', { thread: 'running', outcome: 'actionable', createdAt: at(1) }),
        job('p2', { thread: 'running', round: 2, state: 'prepared', outcome: null, wallS: null, createdAt: at(2) }),
        // the next round was abandoned: still stopped, counted once
        job('a1', { thread: 'dropped', outcome: 'actionable', createdAt: at(1) }),
        job('a2', { thread: 'dropped', round: 2, state: 'abandoned', outcome: null, wallS: null, createdAt: at(2) }),
        // a human is needed: not a dropped fix loop
        job('h1', { thread: 'human', outcome: 'needs-human', createdAt: at(1) }),
      ],
      findings: [],
      by: 'tier',
      since: null,
    })
    expect(out.total.stalled).toBe(2)
    expect(out.groups[0]?.stalled).toBe(2)
  })
})

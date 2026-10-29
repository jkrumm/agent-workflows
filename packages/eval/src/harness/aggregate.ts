import type { CheckCaseResult, ReviewCaseResult } from './results.ts'
import { type RatioSummary, rate, ratioSummary } from './stats.ts'

/**
 * Aggregates hold numbers only: no messages, paths or repo names. They are what `report.md`'s publishable section
 * and the verdict read.
 *
 * A case whose new side failed (`new_failed`) is scored as a miss: its legacy blocking findings count against
 * recall, its outcome or `passed` as a disagreement. Harness failures (`harness_failed`) are not scored, but every
 * error counts toward the error rate the verdict gates on.
 */

export interface CaseCounts {
  total: number
  ok: number
  errors: number
  newFailed: number
  harnessFailed: number
  skipped: Record<string, number>
  /** ok + new_failed: the cases the agreement metrics are over. */
  scored: number
  /** errors / (ok + errors); skipped cases never ran and are left out. */
  errorRate: number | null
}

function caseCounts(results: { status: string; reason?: string }[]): CaseCounts {
  const skipped: Record<string, number> = {}
  for (const r of results)
    if (r.status === 'skipped') skipped[r.reason ?? 'unknown'] = (skipped[r.reason ?? 'unknown'] ?? 0) + 1
  const ok = results.filter((r) => r.status === 'ok').length
  const errors = results.filter((r) => r.status === 'error').length
  const newFailed = results.filter((r) => r.status === 'error' && r.reason === 'new_failed').length
  return {
    total: results.length,
    ok,
    errors,
    newFailed,
    harnessFailed: errors - newFailed,
    skipped,
    scored: ok + newFailed,
    errorRate: rate(errors, ok + errors),
  }
}

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0)
const mean = (values: number[]) => (values.length ? sum(values) / values.length : null)
const total = (values: (number | null)[]) => {
  const known = values.filter((v): v is number => v !== null)
  return known.length ? sum(known) : null
}

const OUTCOMES = ['clean', 'actionable', 'needs-human'] as const

/**
 * Legacy's own noise floor, from the reproducibility rows recorded while agent-gateway ran: the mean per-case outcome
 * agreement (check: `passed` agreement) and blocking recall (check: failure recall) of its reruns against its recorded
 * run, over the run's cases that have a legacy row. No live rerun measures it any more.
 */
export interface RecordedSelfAgreement {
  cases: number
  outcomeAgreement: number | null
  blockingRecall: number | null
}

/** The reproducibility rows read at one threshold: case id -> reproducible. */
export interface ReproducibleCases {
  threshold: number
  byId: Map<string, boolean>
}

/**
 * What the recall counted when reproducibility data covers every scored case: only cases that had recorded blocking
 * findings (red runs for check) and are reproducible at `threshold`. Partial data is not used (`coverage`): it would
 * shrink the denominator to whichever cases happened to be measured.
 */
export interface RecallBasis {
  threshold: number
  /** Cases with a recorded blocking finding (check: a recorded red run). */
  withRecorded: number
  counted: number
  notReproducible: number
  /** The counted cases' recorded findings and how many the new side found again: the recall's numerator and denominator. */
  matched: number
  reference: number
}

/** Reproducibility data that exists but covers only some of the scored cases, so it was not used. */
export interface Coverage {
  covered: number
  cases: number
}

/**
 * Recall over the cases that count. The basis applies only when every scored case has a reproducibility row; with
 * none, or with some, every case counts and `coverage` says whether data existed but did not cover the run.
 */
function recallOver(
  entries: { id: string; reference: number; matched: number }[],
  reproducible: ReproducibleCases | null,
) {
  const all = {
    recall: rate(sum(entries.map((e) => e.matched)), sum(entries.map((e) => e.reference))),
    basis: null,
    coverage: null,
  }
  if (!reproducible) return all
  const covered = entries.filter((e) => reproducible.byId.has(e.id)).length
  if (covered < entries.length) return { ...all, coverage: { covered, cases: entries.length } }
  const withRecorded = entries.filter((e) => e.reference > 0)
  const counted = withRecorded.filter((e) => reproducible.byId.get(e.id) === true)
  const basis: RecallBasis = {
    threshold: reproducible.threshold,
    withRecorded: withRecorded.length,
    counted: counted.length,
    notReproducible: withRecorded.length - counted.length,
    matched: sum(counted.map((e) => e.matched)),
    reference: sum(counted.map((e) => e.reference)),
  }
  return { recall: rate(basis.matched, basis.reference), basis, coverage: null }
}

export type CostSummary = RatioSummary & {
  newUsd: number | null
  legacyUsd: number | null
  /** Cases whose cost is unknown or approximate (`costExact: false`), per side. */
  inexact: { new: number; legacy: number }
}

export interface ReviewAggregate {
  cases: CaseCounts
  /** Over scored cases; a new-side failure is a disagreement (column `failed`). */
  outcome: { agreement: number | null; confusion: Record<string, Record<string, number>> }
  blocking: {
    /** Legacy blocking over scored cases, including those of cases whose new side failed. */
    legacy: number
    new: number
    matched: number
    judged: number
    unsure: number
    /** Matched legacy blocking / all legacy blocking, pooled over scored cases (over the reproducible ones when `basis`). */
    recall: number | null
    /** Set when the set has reproducibility data: the recall counts reproducible cases only. */
    basis: RecallBasis | null
    /** Set when reproducibility data exists but does not cover every scored case: not used. */
    coverage: Coverage | null
    newOnly: number
  }
  improvementsPerCase: { legacy: number | null; new: number | null }
  needsHumanRate: { legacy: number | null; new: number | null }
  failedAngleRate: { legacy: number | null; new: number | null }
  /** new / recorded legacy per case. */
  cost: CostSummary
  wall: RatioSummary
  /** The recorded legacy noise floor the verdict derives its floor from; `null`: no recorded data, fixed floors apply. */
  selfAgreement: RecordedSelfAgreement | null
}

interface SpendSide {
  costUsd: number | null
  costExact: boolean
  wallMs: number | null
}

const inexact = (sides: SpendSide[]) => sides.filter((s) => s.costUsd === null || !s.costExact).length

/** Paired cost and wall ratios new/legacy, cost totals and the inexact counts, for either workflow. */
function costWallSummary(pairs: { next: SpendSide; legacy: SpendSide }[], seed: number) {
  const cost: CostSummary = {
    ...ratioSummary(
      pairs.map((p) => ({ a: p.next.costUsd, b: p.legacy.costUsd })),
      seed,
    ),
    newUsd: total(pairs.map((p) => p.next.costUsd)),
    legacyUsd: total(pairs.map((p) => p.legacy.costUsd)),
    inexact: { new: inexact(pairs.map((p) => p.next)), legacy: inexact(pairs.map((p) => p.legacy)) },
  }
  const wall = ratioSummary(
    pairs.map((p) => ({ a: p.next.wallMs, b: p.legacy.wallMs })),
    seed + 1,
  )
  return { cost, wall }
}

export function aggregateReview(
  results: ReviewCaseResult[],
  seed = 1,
  reproducible: ReproducibleCases | null = null,
  selfAgreement: RecordedSelfAgreement | null = null,
): ReviewAggregate {
  const ok = results.filter((r): r is ReviewCaseResult & Required<Pick<ReviewCaseResult, 'new' | 'match'>> =>
    Boolean(r.status === 'ok' && r.new && r.match),
  )
  const failed = results.filter((r) => r.status === 'error' && r.reason === 'new_failed')
  const columns = [...OUTCOMES, 'failed']
  const confusion: Record<string, Record<string, number>> = {}
  for (const l of OUTCOMES) confusion[l] = Object.fromEntries(columns.map((n) => [n, 0]))
  const count = (legacy: string, next: string) => {
    const row = confusion[legacy] as Record<string, number>
    row[next] = (row[next] ?? 0) + 1
  }
  for (const r of ok) count(r.legacy.outcome, r.new.outcome)
  for (const r of failed) count(r.legacy.outcome, 'failed')

  const legacyBlocking = sum(ok.map((r) => r.match.reference)) + sum(failed.map((r) => r.legacy.blocking))
  const matched = sum(ok.map((r) => r.match.matched))
  const recall = recallOver(
    [
      ...ok.map((r) => ({ id: r.id, reference: r.match.reference, matched: r.match.matched })),
      ...failed.map((r) => ({ id: r.id, reference: r.legacy.blocking, matched: 0 })),
    ],
    reproducible,
  )

  return {
    cases: caseCounts(results),
    outcome: {
      agreement: rate(ok.filter((r) => r.new.outcome === r.legacy.outcome).length, ok.length + failed.length),
      confusion,
    },
    blocking: {
      legacy: legacyBlocking,
      new: sum(ok.map((r) => r.new.blocking)),
      matched,
      judged: sum(ok.map((r) => r.match.judged)),
      unsure: sum(ok.map((r) => r.match.unsure)),
      recall: recall.recall,
      basis: recall.basis,
      coverage: recall.coverage,
      newOnly: sum(ok.map((r) => r.match.newOnly)),
    },
    improvementsPerCase: {
      legacy: mean(ok.map((r) => r.legacy.improvements)),
      new: mean(ok.map((r) => r.new.improvements)),
    },
    needsHumanRate: {
      legacy: rate(ok.filter((r) => r.legacy.outcome === 'needs-human').length, ok.length),
      new: rate(ok.filter((r) => r.new.outcome === 'needs-human').length, ok.length),
    },
    failedAngleRate: {
      legacy: rate(ok.filter((r) => r.legacy.failedAngles > 0).length, ok.length),
      new: rate(ok.filter((r) => r.new.failedAngles > 0).length, ok.length),
    },
    ...costWallSummary(
      ok.map((r) => ({ next: r.new, legacy: r.legacy })),
      seed,
    ),
    selfAgreement,
  }
}

type PassRow = { pass: number; fail: number; failed: number }

export interface CheckAggregate {
  cases: CaseCounts
  /** Over scored cases; column `failed` is a new side that errored (a disagreement). */
  passed: { agreement: number | null; confusion: Record<'legacyPass' | 'legacyFail', PassRow> }
  /** Legacy-red cases the new side also called red: an always-green check cannot pass on a mostly green set. */
  failureRecall: {
    legacyFailed: number
    caught: number
    recall: number | null
    basis: RecallBasis | null
    coverage: Coverage | null
  }
  /** Steps both sides ran (by name) whose pass/fail agreed. */
  steps: { compared: number; agreement: number | null }
  cost: CostSummary
  wall: RatioSummary
  /** As in the review aggregate: `outcomeAgreement` is `passed` agreement, `blockingRecall` is failure recall. */
  selfAgreement: RecordedSelfAgreement | null
}

function stepAgreement(pairs: { a: { name: string; passed: boolean }[]; b: { name: string; passed: boolean }[] }[]) {
  let compared = 0
  let agreed = 0
  for (const { a, b } of pairs) {
    const legacy = new Map(b.map((s) => [s.name, s.passed]))
    for (const step of a) {
      const other = legacy.get(step.name)
      if (other === undefined) continue
      compared++
      if (other === step.passed) agreed++
    }
  }
  return { compared, agreement: rate(agreed, compared) }
}

export function aggregateCheck(
  results: CheckCaseResult[],
  seed = 1,
  reproducible: ReproducibleCases | null = null,
  selfAgreement: RecordedSelfAgreement | null = null,
): CheckAggregate {
  const ok = results.filter((r): r is CheckCaseResult & Required<Pick<CheckCaseResult, 'new'>> =>
    Boolean(r.status === 'ok' && r.new),
  )
  const failed = results.filter((r) => r.status === 'error' && r.reason === 'new_failed')
  const confusion = { legacyPass: { pass: 0, fail: 0, failed: 0 }, legacyFail: { pass: 0, fail: 0, failed: 0 } }
  for (const r of ok) confusion[r.legacy.passed ? 'legacyPass' : 'legacyFail'][r.new.passed ? 'pass' : 'fail']++
  for (const r of failed) confusion[r.legacy.passed ? 'legacyPass' : 'legacyFail'].failed++
  const legacyFailed = ok.filter((r) => !r.legacy.passed).length + failed.filter((r) => !r.legacy.passed).length
  const caught = ok.filter((r) => !r.legacy.passed && !r.new.passed).length
  const recall = recallOver(
    [
      ...ok.map((r) => ({
        id: r.id,
        reference: r.legacy.passed ? 0 : 1,
        matched: !r.legacy.passed && !r.new.passed ? 1 : 0,
      })),
      ...failed.map((r) => ({ id: r.id, reference: r.legacy.passed ? 0 : 1, matched: 0 })),
    ],
    reproducible,
  )
  return {
    cases: caseCounts(results),
    passed: {
      agreement: rate(ok.filter((r) => r.new.passed === r.legacy.passed).length, ok.length + failed.length),
      confusion,
    },
    failureRecall: { legacyFailed, caught, recall: recall.recall, basis: recall.basis, coverage: recall.coverage },
    steps: stepAgreement(ok.map((r) => ({ a: r.new.steps, b: r.legacy.steps }))),
    ...costWallSummary(
      ok.map((r) => ({ next: r.new, legacy: r.legacy })),
      seed,
    ),
    selfAgreement,
  }
}

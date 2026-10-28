import type { CheckCaseResult, ReviewCaseResult } from './results.ts'
import { type RatioSummary, rate, ratioSummary } from './stats.ts'

/**
 * Aggregates hold numbers only: no messages, paths or repo names. They are what `report.md`'s publishable section
 * and the verdict read.
 */

export interface CaseCounts {
  total: number
  ok: number
  errors: number
  skipped: Record<string, number>
}

function caseCounts(results: { status: string; reason?: string }[]): CaseCounts {
  const skipped: Record<string, number> = {}
  for (const r of results)
    if (r.status === 'skipped') skipped[r.reason ?? 'unknown'] = (skipped[r.reason ?? 'unknown'] ?? 0) + 1
  return {
    total: results.length,
    ok: results.filter((r) => r.status === 'ok').length,
    errors: results.filter((r) => r.status === 'error').length,
    skipped,
  }
}

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0)
const mean = (values: number[]) => (values.length ? sum(values) / values.length : null)
const total = (values: (number | null)[]) => {
  const known = values.filter((v): v is number => v !== null)
  return known.length ? sum(known) : null
}

const OUTCOMES = ['clean', 'actionable', 'needs-human'] as const

export interface ReviewAggregate {
  cases: CaseCounts
  outcome: { agreement: number | null; confusion: Record<string, Record<string, number>> }
  blocking: {
    legacy: number
    new: number
    matched: number
    judged: number
    unsure: number
    /** Matched legacy blocking / all legacy blocking, pooled over cases. */
    recall: number | null
    newOnly: number
  }
  improvementsPerCase: { legacy: number | null; new: number | null }
  needsHumanRate: { legacy: number | null; new: number | null }
  failedAngleRate: { legacy: number | null; new: number | null }
  /** new / legacy per case; the legacy side is the rerun where one ran, else the recorded run. */
  cost: RatioSummary & { baseline: 'rerun' | 'recorded' | 'mixed'; newUsd: number | null; legacyUsd: number | null }
  wall: RatioSummary & { baseline: 'rerun' | 'recorded' | 'mixed' }
  /** The legacy rerun vs the recorded run: legacy's own noise floor; `null` without `--rerun-legacy`. */
  selfAgreement: { cases: number; blockingRecall: number | null; outcomeAgreement: number | null } | null
}

const baselineOf = (rerunCount: number, cases: number) =>
  rerunCount === 0 ? 'recorded' : rerunCount === cases ? 'rerun' : 'mixed'

export function aggregateReview(results: ReviewCaseResult[], seed = 1): ReviewAggregate {
  const ok = results.filter((r): r is ReviewCaseResult & Required<Pick<ReviewCaseResult, 'new' | 'match'>> =>
    Boolean(r.status === 'ok' && r.new && r.match),
  )
  const confusion: Record<string, Record<string, number>> = {}
  for (const l of OUTCOMES) confusion[l] = Object.fromEntries(OUTCOMES.map((n) => [n, 0]))
  for (const r of ok) {
    const row = confusion[r.legacy.outcome] as Record<string, number>
    row[r.new.outcome] = (row[r.new.outcome] ?? 0) + 1
  }

  const legacyBlocking = sum(ok.map((r) => r.match.reference))
  const matched = sum(ok.map((r) => r.match.matched))
  const reruns = ok.filter((r) => r.rerun)
  const baseline = baselineOf(reruns.length, ok.length)
  const legacyOf = (r: ReviewCaseResult) => r.rerun ?? r.legacy

  return {
    cases: caseCounts(results),
    outcome: { agreement: rate(ok.filter((r) => r.new.outcome === r.legacy.outcome).length, ok.length), confusion },
    blocking: {
      legacy: legacyBlocking,
      new: sum(ok.map((r) => r.new.blocking)),
      matched,
      judged: sum(ok.map((r) => r.match.judged)),
      unsure: sum(ok.map((r) => r.match.unsure)),
      recall: rate(matched, legacyBlocking),
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
    cost: {
      ...ratioSummary(
        ok.map((r) => ({ a: r.new.costUsd, b: legacyOf(r).costUsd })),
        seed,
      ),
      baseline,
      newUsd: total(ok.map((r) => r.new.costUsd)),
      legacyUsd: total(ok.map((r) => legacyOf(r).costUsd)),
    },
    wall: {
      ...ratioSummary(
        ok.map((r) => ({ a: r.new.wallMs, b: legacyOf(r).wallMs })),
        seed + 1,
      ),
      baseline,
    },
    selfAgreement: reruns.length
      ? {
          cases: reruns.length,
          blockingRecall: rate(
            sum(reruns.map((r) => r.rerun?.self.matched ?? 0)),
            sum(reruns.map((r) => r.rerun?.self.reference ?? 0)),
          ),
          outcomeAgreement: rate(reruns.filter((r) => r.rerun?.outcome === r.legacy.outcome).length, reruns.length),
        }
      : null,
  }
}

export interface CheckAggregate {
  cases: CaseCounts
  passed: { agreement: number | null; confusion: Record<'legacyPass' | 'legacyFail', { pass: number; fail: number }> }
  /** Steps both sides ran (by name) whose pass/fail agreed. */
  steps: { compared: number; agreement: number | null }
  cost: RatioSummary & { baseline: 'rerun' | 'recorded' | 'mixed'; newUsd: number | null; legacyUsd: number | null }
  wall: RatioSummary & { baseline: 'rerun' | 'recorded' | 'mixed' }
  selfAgreement: { cases: number; passedAgreement: number | null; stepAgreement: number | null } | null
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

export function aggregateCheck(results: CheckCaseResult[], seed = 1): CheckAggregate {
  const ok = results.filter((r): r is CheckCaseResult & Required<Pick<CheckCaseResult, 'new'>> =>
    Boolean(r.status === 'ok' && r.new),
  )
  const confusion = { legacyPass: { pass: 0, fail: 0 }, legacyFail: { pass: 0, fail: 0 } }
  for (const r of ok) confusion[r.legacy.passed ? 'legacyPass' : 'legacyFail'][r.new.passed ? 'pass' : 'fail']++
  const reruns = ok.filter((r) => r.rerun)
  const baseline = baselineOf(reruns.length, ok.length)
  const legacyOf = (r: CheckCaseResult) => r.rerun ?? r.legacy
  const self = stepAgreement(reruns.map((r) => ({ a: r.rerun?.steps ?? [], b: r.legacy.steps })))
  return {
    cases: caseCounts(results),
    passed: { agreement: rate(ok.filter((r) => r.new.passed === r.legacy.passed).length, ok.length), confusion },
    steps: stepAgreement(ok.map((r) => ({ a: r.new.steps, b: r.legacy.steps }))),
    cost: {
      ...ratioSummary(
        ok.map((r) => ({ a: r.new.costUsd, b: legacyOf(r).costUsd })),
        seed,
      ),
      baseline,
      newUsd: total(ok.map((r) => r.new.costUsd)),
      legacyUsd: total(ok.map((r) => legacyOf(r).costUsd)),
    },
    wall: {
      ...ratioSummary(
        ok.map((r) => ({ a: r.new.wallMs, b: legacyOf(r).wallMs })),
        seed + 1,
      ),
      baseline,
    },
    selfAgreement: reruns.length
      ? {
          cases: reruns.length,
          passedAgreement: rate(reruns.filter((r) => r.rerun?.passed === r.legacy.passed).length, reruns.length),
          stepAgreement: self.agreement,
        }
      : null,
  }
}

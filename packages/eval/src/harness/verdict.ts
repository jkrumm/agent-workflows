import type { CaseCounts, CheckAggregate, ReviewAggregate } from './aggregate.ts'
import type { RatioSummary } from './stats.ts'

/** The P1 cutover gate (concept §11): the new workflow is not worse than agent-gateway. Defaults, overridable. */
export const DEFAULT_THRESHOLDS = {
  /** Review floor for blocking recall and outcome agreement. */
  reviewFloor: 0.6,
  /** Check floor for `passed` agreement and failure recall: check is deterministic, so the bar is high. */
  checkFloor: 0.9,
  maxCostRatio: 1.1,
  maxWallRatio: 1.25,
  minReviewCases: 20,
  minCheckCases: 5,
  /** Paired cases a cost or wall ratio needs before its median is judged. */
  minReviewPairs: 10,
  minCheckPairs: 3,
  /** More errored cases than this (of ok + errors) make the run inconclusive. */
  maxErrorRate: 0.1,
}
export type Thresholds = typeof DEFAULT_THRESHOLDS

export interface Criterion {
  metric: string
  value: number | null
  op: '>=' | '<='
  threshold: number
  /** `null`: no data, or too few paired cases (`note` says which). */
  pass: boolean | null
  /** Bootstrap 95% CI of a median ratio, shown next to the median gate. */
  ci95?: [number, number] | null
  note?: string
}

export interface Verdict {
  verdict: 'not-worse' | 'worse' | 'inconclusive'
  reasons: string[]
  criteria: Criterion[]
  thresholds: Thresholds
}

const criterion = (metric: string, value: number | null, op: Criterion['op'], threshold: number): Criterion => ({
  metric,
  value,
  op,
  threshold,
  pass: value === null ? null : op === '>=' ? value >= threshold : value <= threshold,
})

/** The median gate on a paired ratio; fewer than `minPairs` pairs leave it undecided. */
function ratioCriterion(metric: string, ratio: RatioSummary, threshold: number, minPairs: number): Criterion {
  const base = { ...criterion(metric, ratio.median, '<=', threshold), ci95: ratio.ci95 }
  if (ratio.n >= minPairs) return base
  return { ...base, pass: null, note: `${ratio.n} paired cases, fewer than ${minPairs}` }
}

function decide(cases: CaseCounts, min: number, criteria: Criterion[], thresholds: Thresholds): Verdict {
  if (cases.scored < min) {
    return { verdict: 'inconclusive', reasons: [`${cases.scored} cases ran, fewer than ${min}`], criteria, thresholds }
  }
  if (cases.errorRate !== null && cases.errorRate > thresholds.maxErrorRate) {
    const reason = `error rate ${(cases.errorRate * 100).toFixed(1)}% (${cases.errors} cases) above ${(thresholds.maxErrorRate * 100).toFixed(0)}%`
    return { verdict: 'inconclusive', reasons: [reason], criteria, thresholds }
  }
  const failed = criteria.filter((c) => c.pass === false)
  if (failed.length) {
    const reasons = failed.map((c) => `${c.metric} ${c.value?.toFixed(3)} not ${c.op} ${c.threshold.toFixed(3)}`)
    return { verdict: 'worse', reasons, criteria, thresholds }
  }
  const unknown = criteria.filter((c) => c.pass === null)
  if (unknown.length) {
    const reasons = unknown.map((c) => `${c.metric}: ${c.note ?? 'no data'}`)
    return { verdict: 'inconclusive', reasons, criteria, thresholds }
  }
  return { verdict: 'not-worse', reasons: [], criteria, thresholds }
}

export function reviewVerdict(agg: ReviewAggregate, overrides: Partial<Thresholds> = {}): Verdict {
  const t = { ...DEFAULT_THRESHOLDS, ...overrides }
  const criteria = [
    criterion('blocking recall', agg.blocking.recall, '>=', t.reviewFloor),
    criterion('outcome agreement', agg.outcome.agreement, '>=', t.reviewFloor),
    ratioCriterion('median cost ratio', agg.cost, t.maxCostRatio, t.minReviewPairs),
    ratioCriterion('median wall ratio', agg.wall, t.maxWallRatio, t.minReviewPairs),
  ]
  return decide(agg.cases, t.minReviewCases, criteria, t)
}

export function checkVerdict(agg: CheckAggregate, overrides: Partial<Thresholds> = {}): Verdict {
  const t = { ...DEFAULT_THRESHOLDS, ...overrides }
  const criteria = [
    criterion('passed agreement', agg.passed.agreement, '>=', t.checkFloor),
    criterion('legacy failure recall', agg.failureRecall.recall, '>=', t.checkFloor),
    ratioCriterion('median cost ratio', agg.cost, t.maxCostRatio, t.minCheckPairs),
    ratioCriterion('median wall ratio', agg.wall, t.maxWallRatio, t.minCheckPairs),
  ]
  return decide(agg.cases, t.minCheckCases, criteria, t)
}

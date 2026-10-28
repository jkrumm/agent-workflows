import type { CheckAggregate, ReviewAggregate } from './aggregate.ts'

/** The P1 cutover gate (concept §11): the new workflow is not worse than agent-gateway. Defaults, overridable. */
export const DEFAULT_THRESHOLDS = {
  /** Allowed drop below legacy's own self-agreement (the noise floor from `--rerun-legacy`). */
  margin: 0.1,
  /** Review floor for blocking recall and outcome agreement when no rerun measured the noise floor. */
  reviewFloor: 0.6,
  /** Check floor for `passed` agreement without a rerun: check is deterministic, so the bar is high. */
  checkFloor: 0.9,
  maxCostRatio: 1.1,
  maxWallRatio: 1.25,
  minReviewCases: 20,
  minCheckCases: 5,
}
export type Thresholds = typeof DEFAULT_THRESHOLDS

export interface Criterion {
  metric: string
  value: number | null
  op: '>=' | '<='
  threshold: number
  /** `null`: the metric could not be computed (no data). */
  pass: boolean | null
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

/** Legacy's self-agreement minus the margin, or the fixed floor when no rerun measured it. */
const floorOf = (self: number | null | undefined, fallback: number, margin: number) =>
  self === null || self === undefined ? fallback : Math.max(0, self - margin)

function decide(ran: number, min: number, criteria: Criterion[], thresholds: Thresholds): Verdict {
  if (ran < min) {
    return { verdict: 'inconclusive', reasons: [`${ran} cases ran, fewer than ${min}`], criteria, thresholds }
  }
  const failed = criteria.filter((c) => c.pass === false)
  if (failed.length) {
    const reasons = failed.map((c) => `${c.metric} ${c.value?.toFixed(3)} not ${c.op} ${c.threshold.toFixed(3)}`)
    return { verdict: 'worse', reasons, criteria, thresholds }
  }
  const unknown = criteria.filter((c) => c.pass === null)
  if (unknown.length) {
    return { verdict: 'inconclusive', reasons: unknown.map((c) => `${c.metric}: no data`), criteria, thresholds }
  }
  return { verdict: 'not-worse', reasons: [], criteria, thresholds }
}

export function reviewVerdict(agg: ReviewAggregate, overrides: Partial<Thresholds> = {}): Verdict {
  const t = { ...DEFAULT_THRESHOLDS, ...overrides }
  const self = agg.selfAgreement
  const criteria = [
    criterion('blocking recall', agg.blocking.recall, '>=', floorOf(self?.blockingRecall, t.reviewFloor, t.margin)),
    criterion(
      'outcome agreement',
      agg.outcome.agreement,
      '>=',
      floorOf(self?.outcomeAgreement, t.reviewFloor, t.margin),
    ),
    criterion('median cost ratio', agg.cost.median, '<=', t.maxCostRatio),
    criterion('median wall ratio', agg.wall.median, '<=', t.maxWallRatio),
  ]
  return decide(agg.cases.ok, t.minReviewCases, criteria, t)
}

export function checkVerdict(agg: CheckAggregate, overrides: Partial<Thresholds> = {}): Verdict {
  const t = { ...DEFAULT_THRESHOLDS, ...overrides }
  const self = agg.selfAgreement
  const criteria = [
    criterion('passed agreement', agg.passed.agreement, '>=', floorOf(self?.passedAgreement, t.checkFloor, t.margin)),
    criterion('median cost ratio', agg.cost.median, '<=', t.maxCostRatio),
    criterion('median wall ratio', agg.wall.median, '<=', t.maxWallRatio),
  ]
  return decide(agg.cases.ok, t.minCheckCases, criteria, t)
}

import { bootstrapMedianCI, median, seededRandom } from './harness/stats.ts'

/**
 * `agw eval compare` (concept §6): two arms of scored regression runs, paired by case id, per metric. Pure: the host
 * reads the runs, this decides. An arm's reruns of one case are averaged first, so a case weighs once.
 */

/** One scored run as compare sees it: the scorer's numbers and the run record's spend. */
export interface ArmRun {
  caseId: string
  scores: Record<string, number>
  pass: boolean
  costUsd: number | null
  wallMs: number | null
  tokens: number | null
  toolCalls: number | null
  /** The run had unpriced calls: its cost is a lower bound, so `costUsd` is null and the case may drop from cost. */
  unpriced?: boolean
}

/** Below this many pairs a metric gets no verdict (`unknown`): a bootstrap over fewer cases decides nothing. */
export const MIN_PAIRS = 5

/** Scorer metrics are higher-is-better (the scorer contract); spend metrics are lower-is-better. */
export const SPEND_METRICS = ['costUsd', 'wallMs', 'tokens', 'toolCalls'] as const
type SpendMetric = (typeof SPEND_METRICS)[number]

export type Winner = 'a' | 'b' | 'tie' | 'unknown'

export interface MetricComparison {
  metric: string
  direction: 'higher' | 'lower'
  /** Cases with a value on both sides. */
  n: number
  meanA: number | null
  meanB: number | null
  /** B − A, per case. */
  meanDelta: number | null
  /** Seeded percentile bootstrap 95% CI of the mean delta. */
  meanDeltaCi95: [number, number] | null
  medianDelta: number | null
  medianDeltaCi95: [number, number] | null
  /** The arm the mean delta's CI favours; `tie` when it spans 0; `unknown` below `MIN_PAIRS` pairs. */
  better: Winner
}

export interface Comparison {
  cases: {
    a: number
    b: number
    paired: number
    onlyA: string[]
    onlyB: string[]
    /** Paired cases with no priced cost on that side because their runs had unpriced calls: left out of `costUsd`. */
    unpricedCost: { a: number; b: number }
  }
  metrics: MetricComparison[]
  /** Metrics where B is better / worse than A with the CI clear of 0. */
  bBetter: string[]
  bWorse: string[]
}

const mean = (values: number[]) => (values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null)

/** Percentile bootstrap 95% CI of the mean. */
export function bootstrapMeanCI(
  values: number[],
  options: { seed: number; iterations?: number },
): [number, number] | null {
  if (values.length < 2) return null
  const random = seededRandom(options.seed)
  const iterations = options.iterations ?? 2000
  const means: number[] = []
  for (let i = 0; i < iterations; i++) {
    let sum = 0
    for (let j = 0; j < values.length; j++) sum += values[Math.floor(random() * values.length)] as number
    means.push(sum / values.length)
  }
  means.sort((x, y) => x - y)
  return [
    means[Math.floor(0.025 * iterations)] as number,
    means[Math.min(iterations - 1, Math.ceil(0.975 * iterations) - 1)] as number,
  ]
}

type CaseValues = Map<string, number>

/** Every metric of one arm, averaged per case over its reruns; a missing value stays missing. */
function perCase(runs: ArmRun[]): Map<string, CaseValues> {
  const sums = new Map<string, Map<string, { sum: number; n: number }>>()
  const add = (caseId: string, metric: string, value: number | null) => {
    if (value === null || !Number.isFinite(value)) return
    const metrics = sums.get(caseId) ?? new Map<string, { sum: number; n: number }>()
    sums.set(caseId, metrics)
    const cell = metrics.get(metric) ?? { sum: 0, n: 0 }
    metrics.set(metric, { sum: cell.sum + value, n: cell.n + 1 })
  }
  for (const run of runs) {
    add(run.caseId, 'pass', run.pass ? 1 : 0)
    for (const [metric, value] of Object.entries(run.scores)) add(run.caseId, metric, value)
    for (const metric of SPEND_METRICS) add(run.caseId, metric, run[metric])
  }
  return new Map(
    [...sums].map(([caseId, metrics]) => [caseId, new Map([...metrics].map(([m, c]) => [m, c.sum / c.n]))]),
  )
}

function winner(n: number, ci: [number, number] | null, direction: 'higher' | 'lower'): Winner {
  if (n < MIN_PAIRS || !ci) return 'unknown'
  const [lo, hi] = ci
  if (lo <= 0 && hi >= 0) return 'tie'
  const bUp = lo > 0
  return bUp === (direction === 'higher') ? 'b' : 'a'
}

/** The case has no priced cost in this arm, and some run of it was unpriced. */
function unpricedOnly(runs: ArmRun[], caseId: string): boolean {
  const mine = runs.filter((r) => r.caseId === caseId)
  return mine.some((r) => r.unpriced) && mine.every((r) => r.costUsd === null)
}

export function compareArms(a: ArmRun[], b: ArmRun[], options: { seed: number }): Comparison {
  const caseA = perCase(a)
  const caseB = perCase(b)
  const paired = [...caseA.keys()].filter((id) => caseB.has(id)).sort()
  const names = new Set<string>()
  for (const id of paired)
    for (const m of [...(caseA.get(id)?.keys() ?? []), ...(caseB.get(id)?.keys() ?? [])]) names.add(m)
  const ordered = [
    'pass',
    ...[...names].filter((m) => m !== 'pass' && !SPEND_METRICS.includes(m as SpendMetric)).sort(),
    ...SPEND_METRICS.filter((m) => names.has(m)),
  ]
  const metrics = ordered.map((metric): MetricComparison => {
    const direction = SPEND_METRICS.includes(metric as SpendMetric) ? 'lower' : 'higher'
    const pairs = paired.flatMap((id) => {
      const x = caseA.get(id)?.get(metric)
      const y = caseB.get(id)?.get(metric)
      return x === undefined || y === undefined ? [] : [{ x, y }]
    })
    const deltas = pairs.map(({ x, y }) => y - x)
    const meanDeltaCi95 = bootstrapMeanCI(deltas, { seed: options.seed })
    return {
      metric,
      direction,
      n: pairs.length,
      meanA: mean(pairs.map((p) => p.x)),
      meanB: mean(pairs.map((p) => p.y)),
      meanDelta: mean(deltas),
      meanDeltaCi95,
      medianDelta: median(deltas),
      medianDeltaCi95: bootstrapMedianCI(deltas, { seed: options.seed }),
      better: winner(pairs.length, meanDeltaCi95, direction),
    }
  })
  return {
    cases: {
      a: caseA.size,
      b: caseB.size,
      paired: paired.length,
      onlyA: [...caseA.keys()].filter((id) => !caseB.has(id)).sort(),
      onlyB: [...caseB.keys()].filter((id) => !caseA.has(id)).sort(),
      unpricedCost: {
        a: paired.filter((id) => unpricedOnly(a, id)).length,
        b: paired.filter((id) => unpricedOnly(b, id)).length,
      },
    },
    metrics,
    bBetter: metrics.filter((m) => m.better === 'b').map((m) => m.metric),
    bWorse: metrics.filter((m) => m.better === 'a').map((m) => m.metric),
  }
}

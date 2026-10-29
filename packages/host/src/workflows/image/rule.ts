import type { ImageInputValue, ImageOutputValue } from './schema.ts'

/** The pre-registered thresholds (`docs/research/2026-10-29-wave8-ports.md` §image). */
export const COST_RATIO_MAX = 1.1
export const WALL_RATIO_MAX = 1.25

/** One arm's result for one case: the scorer's verdict, the run's price and the wall time measured around it. */
export interface ArmResult {
  output: ImageOutputValue | null
  scores: Record<string, number>
  /** USD of the run record (N) or imgcli's `cost_usd` (L); null or 0 is unpriced. */
  costUsd: number | null
  wallMs: number
}

export interface CaseResult {
  id: string
  input: ImageInputValue
  n: ArmResult
  l: ArmResult
}

export interface Criterion {
  name: string
  pass: boolean
  detail: string
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length === 0
    ? null
    : sorted.length % 2
      ? (sorted[mid] as number)
      : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
}
const priced = (usd: number | null): usd is number => usd !== null && usd > 0

/** `auto` on either side means the size was not requested; it matches whatever the other side sent. */
const sameSize = (a?: string, b?: string) =>
  a === undefined || b === undefined || a === 'auto' || b === 'auto' || a === b

/** The request parameters of two arms are equal when model, size after snapping, quality and n are. A parameter one side does not carry (a cutout has no size) is not compared. */
export function paramsEqual(n: ImageOutputValue['params'], l: ImageOutputValue['params']): string[] {
  const differences: string[] = []
  if (n.model !== l.model) differences.push(`model ${n.model} vs ${l.model}`)
  if (!sameSize(n.size, l.size)) differences.push(`size ${n.size} vs ${l.size}`)
  if (n.quality !== undefined && l.quality !== undefined && n.quality !== l.quality)
    differences.push(`quality ${n.quality} vs ${l.quality}`)
  if (n.n !== l.n) differences.push(`n ${n.n} vs ${l.n}`)
  return differences
}

/**
 * The `image` port's rule, exactly as pre-registered: N passes if (1) `valid` holds in every case and `alpha` on every
 * cutout; (2) the request parameters N sent equal L's per case; (3) per case N cost is at most 1.10 x L cost where both
 * are priced, and N is priced in every case; (4) median wall(N) is at most 1.25 x median wall(L) over the cases. No
 * visual judgement: the same model with the same parameters is the same generator.
 */
export function evaluateRule(cases: CaseResult[]): { pass: boolean; criteria: Criterion[] } {
  const cutouts = cases.filter((c) => c.input.file !== undefined)
  const invalid = cases.filter((c) => c.n.scores.valid !== 1).map((c) => c.id)
  const noAlpha = cutouts.filter((c) => c.n.scores.alpha !== 1).map((c) => c.id)
  const mismatched = cases.flatMap((c) => {
    if (!c.n.output || !c.l.output) return [`${c.id}: an arm produced no output`]
    const differences = paramsEqual(c.n.output.params, c.l.output.params)
    return differences.length ? [`${c.id}: ${differences.join(', ')}`] : []
  })
  const unpriced = cases.filter((c) => !priced(c.n.costUsd)).map((c) => c.id)
  const overCost = cases.flatMap((c) =>
    priced(c.n.costUsd) && priced(c.l.costUsd) && c.n.costUsd > COST_RATIO_MAX * c.l.costUsd
      ? [`${c.id}: ${c.n.costUsd} vs ${c.l.costUsd}`]
      : [],
  )
  const wallN = median(cases.map((c) => c.n.wallMs))
  const wallL = median(cases.map((c) => c.l.wallMs))

  const criteria: Criterion[] = [
    {
      name: '1 valid in every case, alpha on every cutout',
      pass: cases.length > 0 && invalid.length === 0 && noAlpha.length === 0,
      detail: `valid ${cases.length - invalid.length}/${cases.length}${invalid.length ? ` (not: ${invalid.join(', ')})` : ''}; alpha ${cutouts.length - noAlpha.length}/${cutouts.length}${noAlpha.length ? ` (not: ${noAlpha.join(', ')})` : ''}`,
    },
    {
      name: '2 request parameters equal per case',
      pass: mismatched.length === 0,
      detail: mismatched.length ? mismatched.join('; ') : 'all equal',
    },
    {
      name: `3 cost: N priced in every case, per case N <= ${COST_RATIO_MAX} x L where both are priced`,
      pass: unpriced.length === 0 && overCost.length === 0,
      detail:
        [
          unpriced.length ? `N unpriced: ${unpriced.join(', ')}` : null,
          overCost.length ? `over: ${overCost.join('; ')}` : null,
        ]
          .filter(Boolean)
          .join('; ') || 'within the ratio',
    },
    {
      name: `4 median wall N <= ${WALL_RATIO_MAX} x L`,
      pass: wallN !== null && wallL !== null && wallN <= WALL_RATIO_MAX * wallL,
      detail: `N ${wallN} ms, L ${wallL} ms`,
    },
  ]
  return { pass: criteria.every((c) => c.pass), criteria }
}

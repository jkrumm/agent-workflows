import { seededRandom } from '@agent-workflows/eval'

/**
 * The comparison's pre-registered decision rule (docs/research/2026-10-28-research-three-way.md §Decision rule), as
 * code, so the verdict is computed, not argued. Pure: rows in, verdict out.
 */

export type ArmId = 'engine' | 'agent-yolo' | 'agent-focused' | 'pilot-yolo' | 'pilot-focused'
export const ARMS: ArmId[] = ['engine', 'agent-yolo', 'agent-focused', 'pilot-yolo', 'pilot-focused']

/** One research run of the comparison. A failed run has no scores: it counts as golden 0 and supported 0. */
export type Row = {
  arm: ArmId
  caseId: string
  depth: 'quick' | 'standard' | 'deep'
  ok: boolean
  golden: number | null
  supported: number | null
  cost: number | null
  wallMs: number | null
}

export type CI = { mean: number; lo: number; hi: number; n: number }

const ITERATIONS = 10_000
const SEED = 20261028
/** An arm whose paired CI lower bound on either quality score is at or below this is not eligible. */
export const ELIGIBILITY_FLOOR = -0.1
/** "At least 20 % cheaper / faster". */
export const MARGIN = 0.2

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length

/** Lower median: a measured value, as research-gateway's eval reports it. */
export function median(xs: number[]): number | null {
  if (!xs.length) return null
  const sorted = [...xs].sort((a, b) => a - b)
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? null
}

/** A run's value of a quality score; a failed run or a missing score is 0. */
const score = (row: Row, key: 'golden' | 'supported') => (row.ok ? (row[key] ?? 0) : 0)

/** Per question, the arm's mean of `key` over its runs. */
function perQuestion(rows: Row[], arm: ArmId, key: 'golden' | 'supported'): Map<string, number> {
  const groups = new Map<string, number[]>()
  for (const row of rows) {
    if (row.arm !== arm) continue
    const list = groups.get(row.caseId) ?? []
    list.push(score(row, key))
    groups.set(row.caseId, list)
  }
  return new Map([...groups].map(([id, xs]) => [id, mean(xs)]))
}

/**
 * Paired bootstrap 95 % CI of mean(b − a) over the questions both arms ran: questions resampled with replacement,
 * 10,000 iterations, a fixed seed (reproducible), percentile interval.
 */
export function pairedCI(rows: Row[], a: ArmId, b: ArmId, key: 'golden' | 'supported'): CI | null {
  const qa = perQuestion(rows, a, key)
  const qb = perQuestion(rows, b, key)
  const diffs = [...qa.keys()].filter((id) => qb.has(id)).map((id) => (qb.get(id) as number) - (qa.get(id) as number))
  if (diffs.length < 2) return null
  const random = seededRandom(SEED)
  const means: number[] = []
  for (let i = 0; i < ITERATIONS; i++) {
    let sum = 0
    for (let j = 0; j < diffs.length; j++) sum += diffs[Math.floor(random() * diffs.length)] as number
    means.push(sum / diffs.length)
  }
  means.sort((x, y) => x - y)
  return {
    mean: mean(diffs),
    lo: means[Math.floor(0.025 * ITERATIONS)] as number,
    hi: means[Math.ceil(0.975 * ITERATIONS) - 1] as number,
    n: diffs.length,
  }
}

const heavy = (row: Row) => row.depth === 'standard' || row.depth === 'deep'

/** Median cost and p50 wall time per run on standard and deep questions (failed runs included: they cost too). */
export function spend(rows: Row[], arm: ArmId): { cost: number | null; wallMs: number | null } {
  const mine = rows.filter((r) => r.arm === arm && heavy(r))
  return {
    cost: median(mine.flatMap((r) => (r.cost === null ? [] : [r.cost]))),
    wallMs: median(mine.flatMap((r) => (r.wallMs === null ? [] : [r.wallMs]))),
  }
}

/** Fewer lines to own after the port: agent < pilot < engine. */
const SIMPLICITY: Record<string, number> = { agent: 0, pilot: 1, engine: 2 }
const designOf = (arm: ArmId) => arm.split('-')[0] as string

export type Step = { rule: string; detail: string }

/** Rule (2) between two eligible arms: 20 % cheaper, else 20 % faster, else simpler. */
export function better(rows: Row[], a: ArmId, b: ArmId, log: Step[]): ArmId {
  const sa = spend(rows, a)
  const sb = spend(rows, b)
  if (sa.cost !== null && sb.cost !== null) {
    if (sa.cost <= (1 - MARGIN) * sb.cost)
      return note(log, 'cost', `${a} $${sa.cost.toFixed(4)} vs ${b} $${sb.cost.toFixed(4)}`, a)
    if (sb.cost <= (1 - MARGIN) * sa.cost)
      return note(log, 'cost', `${b} $${sb.cost.toFixed(4)} vs ${a} $${sa.cost.toFixed(4)}`, b)
  }
  if (sa.wallMs !== null && sb.wallMs !== null) {
    if (sa.wallMs <= (1 - MARGIN) * sb.wallMs)
      return note(log, 'wall', `${a} ${sa.wallMs} ms vs ${b} ${sb.wallMs} ms`, a)
    if (sb.wallMs <= (1 - MARGIN) * sa.wallMs)
      return note(log, 'wall', `${b} ${sb.wallMs} ms vs ${a} ${sa.wallMs} ms`, b)
  }
  const simpler = (SIMPLICITY[designOf(a)] as number) <= (SIMPLICITY[designOf(b)] as number) ? a : b
  return note(log, 'simpler', `${a} vs ${b}: within 20 % on cost and wall time`, simpler)
}

function note(log: Step[], rule: string, detail: string, winner: ArmId): ArmId {
  log.push({ rule, detail: `${detail} → ${winner}` })
  return winner
}

export type Verdict = {
  /** Rule (3): the profile each agent design runs with. */
  profiles: Record<'agent' | 'pilot', ArmId>
  quality: Record<string, { golden: CI | null; supported: CI | null; eligible: boolean }>
  winner: ArmId
  log: Step[]
}

/**
 * (3) per agent design: yolo, unless focused − yolo has a paired CI lower bound above 0 on supported or golden.
 * (1) each chosen arm against the engine: eligible when both paired CIs (arm − engine) have a lower bound above −0.10.
 * (2) among the eligible arms and the engine, ordered by median cost: the running winner meets each next arm.
 */
export function decide(rows: Row[]): Verdict {
  const log: Step[] = []
  const profiles = {} as Verdict['profiles']
  for (const design of ['agent', 'pilot'] as const) {
    const yolo = `${design}-yolo` as ArmId
    const focused = `${design}-focused` as ArmId
    const g = pairedCI(rows, yolo, focused, 'golden')
    const s = pairedCI(rows, yolo, focused, 'supported')
    const pick = (g && g.lo > 0) || (s && s.lo > 0) ? focused : yolo
    profiles[design] = pick
    log.push({ rule: 'profile', detail: `${design}: focused − yolo golden ${fmt(g)}, supported ${fmt(s)} → ${pick}` })
  }
  const quality: Verdict['quality'] = {}
  const eligible: ArmId[] = ['engine']
  for (const arm of [profiles.agent, profiles.pilot]) {
    const golden = pairedCI(rows, 'engine', arm, 'golden')
    const supported = pairedCI(rows, 'engine', arm, 'supported')
    const ok = !!golden && !!supported && golden.lo > ELIGIBILITY_FLOOR && supported.lo > ELIGIBILITY_FLOOR
    quality[arm] = { golden, supported, eligible: ok }
    log.push({
      rule: 'eligible',
      detail: `${arm} − engine: golden ${fmt(golden)}, supported ${fmt(supported)} → ${ok ? 'eligible' : 'not eligible'}`,
    })
    if (ok) eligible.push(arm)
  }
  const byCost = [...eligible].sort((a, b) => (spend(rows, a).cost ?? Infinity) - (spend(rows, b).cost ?? Infinity))
  let winner = byCost[0] as ArmId
  for (const challenger of byCost.slice(1)) winner = better(rows, winner, challenger, log)
  return { profiles, quality, winner, log }
}

const fmt = (ci: CI | null) =>
  ci ? `${ci.mean.toFixed(3)} [${ci.lo.toFixed(3)}, ${ci.hi.toFixed(3)}] (n=${ci.n})` : 'n/a'

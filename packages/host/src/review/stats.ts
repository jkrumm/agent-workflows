// `agw review stats`: the ledger's quality numbers, aggregated in code. No model reads a finding to produce them.
import type { z } from 'zod'
import type { StatsFinding, StatsJob } from './ledger.ts'
import { TIERS } from './route.ts'
import { DISPOSITIONS, type StatsInput, type StatsMetricsValue, type StatsOutputValue } from './schema.ts'

type By = StatsOutputValue['by']

const RAISED = / \(raised by caller from [a-z]+\)$/
const FIX_ROUND = ' (fix round, thread already deep)'

/**
 * A rule text without its specifics, so a group is stable: `sensitive path: x (+2)` → `sensitive path`, a fix round →
 * `sensitive path (fix round)`, `N changed non-test code lines > 800` → `size`, `N packages > 3: …` → `cross-package`,
 * `small: …` → `small`, `<rule> (raised by caller from X)` → `<base> (raised by caller)`, anything else the text before
 * its first `:`.
 */
export function normalizeRule(rule: string): string {
  if (RAISED.test(rule)) return `${normalizeRule(rule.replace(RAISED, ''))} (raised by caller)`
  if (rule.startsWith('sensitive path:'))
    return rule.endsWith(FIX_ROUND) ? 'sensitive path (fix round)' : 'sensitive path'
  if (/^\d+ changed non-test code lines > \d+$/.test(rule)) return 'size'
  if (/^\d+ packages > \d+:/.test(rule)) return 'cross-package'
  const colon = rule.indexOf(':')
  return colon < 0 ? rule : rule.slice(0, colon)
}

/** Nearest-rank percentile (`p` in 0..1) of an ascending list; null when empty. */
export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!
}

const ratio = (part: number, whole: number): number | null => (whole === 0 ? null : part / whole)

const countBy = (findings: StatsFinding[], tag: StatsFinding['tag']) => {
  const counts = Object.fromEntries(DISPOSITIONS.map((d) => [d, 0])) as Record<StatsFinding['disposition'], number>
  for (const f of findings) if (f.tag === tag) counts[f.disposition]++
  return counts
}

const precision = (c: Record<StatsFinding['disposition'], number>) => ratio(c.fixed, c.fixed + c.wrong + c.irrelevant)

const share = (findings: StatsFinding[], key: 'anchored' | 'lineValid') => {
  const known = findings.filter((f) => f[key] !== null)
  return ratio(known.filter((f) => f[key] === true).length, known.length)
}

function metricsOf(jobs: StatsJob[], findings: StatsFinding[]): StatsMetricsValue {
  const submitted = jobs.filter((j) => j.state === 'submitted')
  const walls = submitted.flatMap((j) => (j.wallS === null ? [] : [j.wallS])).sort((a, b) => a - b)
  const first = submitted.filter((j) => j.round === 1)
  const clean = first.filter((j) => j.outcome === 'clean').length
  const important = countBy(findings, 'important')
  const nit = countBy(findings, 'nit')
  const deepRound2 = submitted.filter((j) => j.tier === 'deep' && j.round >= 2).length
  const tagged = (tag: StatsFinding['tag']) => findings.filter((f) => f.tag === tag).length
  return {
    jobs: submitted.length,
    abandoned: jobs.filter((j) => j.state === 'abandoned').length,
    prepared: jobs.filter((j) => j.state === 'prepared').length,
    wallS: { p50: percentile(walls, 0.5), max: walls.at(-1) ?? null },
    round1: { jobs: first.length, clean, cleanRate: ratio(clean, first.length) },
    findings: { important: tagged('important'), nit: tagged('nit'), preExisting: tagged('pre-existing') },
    dispositions: { important, nit },
    precision: { important: precision(important), nit: precision(nit) },
    anchoredShare: share(findings, 'anchored'),
    lineValidShare: share(findings, 'lineValid'),
    deepRound2: { count: deepRound2, share: ratio(deepRound2, submitted.length) },
  }
}

const keyOf = (job: StatsJob, by: By): string => {
  if (by === 'tier') return job.tier
  if (by === 'rule') return normalizeRule(job.rule)
  if (by === 'prompt') return job.reviewerPrompt ?? 'unknown'
  return job.repo
}

const compare = (by: By) => (a: string, b: string) => {
  if (by === 'tier') return TIERS.indexOf(a as (typeof TIERS)[number]) - TIERS.indexOf(b as (typeof TIERS)[number])
  return a < b ? -1 : a > b ? 1 : 0
}

/** The Monday 00:00 UTC of the date's ISO week, as `YYYY-MM-DD`. */
export function weekStartOf(date: Date): string {
  const day = (date.getUTCDay() + 6) % 7
  const monday = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - day)
  return new Date(monday).toISOString().slice(0, 10)
}

function groupsOf(jobs: StatsJob[], findings: StatsFinding[], by: By) {
  const groupOf = new Map<string, StatsJob[]>()
  const keyOfJob = new Map<string, string>()
  for (const job of jobs) {
    const key = keyOf(job, by)
    keyOfJob.set(job.id, key)
    groupOf.set(key, [...(groupOf.get(key) ?? []), job])
  }
  const groups = [...groupOf.keys()].sort(compare(by)).map((key) => ({
    key,
    ...metricsOf(
      groupOf.get(key)!,
      findings.filter((f) => keyOfJob.get(f.jobId) === key),
    ),
  }))
  return groups
}

export function computeStats(input: {
  jobs: StatsJob[]
  findings: StatsFinding[]
  by: By
  bucket?: 'week'
  since: string | null
}): StatsOutputValue {
  const { by, jobs, findings } = input
  const total = metricsOf(jobs, findings)
  if (input.bucket !== 'week') return { since: input.since, by, groups: groupsOf(jobs, findings, by), total }
  const weekJobs = new Map<string, StatsJob[]>()
  for (const job of jobs) {
    const week = weekStartOf(job.createdAt)
    weekJobs.set(week, [...(weekJobs.get(week) ?? []), job])
  }
  const weeks = [...weekJobs.keys()].sort().map((weekStart) => {
    const inWeek = weekJobs.get(weekStart)!
    const ids = new Set(inWeek.map((j) => j.id))
    return {
      weekStart,
      groups: groupsOf(
        inWeek,
        findings.filter((f) => ids.has(f.jobId)),
        by,
      ),
    }
  })
  return { since: input.since, by, bucket: 'week', groups: [], weeks, total }
}

const WEEK_MS = 7 * 24 * 3_600_000
const PUSH_WEEKS = 12

/** The numbers Argo shows: the last 12 ISO weeks by tier (current partial week included), and all-time by prompt. */
export async function weeklyReviewStats(
  service: { stats(input: z.input<typeof StatsInput>): Promise<StatsOutputValue> },
  now: Date,
) {
  const since = new Date(Date.parse(`${weekStartOf(now)}T00:00:00Z`) - (PUSH_WEEKS - 1) * WEEK_MS).toISOString()
  const [weekly, prompts] = await Promise.all([
    service.stats({ by: 'tier', bucket: 'week', since }),
    service.stats({ by: 'prompt' }),
  ])
  return { weeks: weekly.weeks ?? [], byPrompt: prompts.groups }
}

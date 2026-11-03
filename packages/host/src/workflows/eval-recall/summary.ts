import { median, wilson } from '@agent-workflows/eval'
import { z } from 'zod'

export const CaseResult = z.object({
  id: z.string(),
  split: z.enum(['dev', 'test']),
  kind: z.enum(['bug', 'control']),
  status: z.enum(['scored', 'unscored']),
  reason: z.string().nullable().describe('Unscored: why the job did not submit (or could not be scored)'),
  tier: z.string().nullable(),
  seat: z.string().nullable().describe('Model and effort of the reviewer seat'),
  account: z.string().nullable().describe('The Max account the factory ran the session on'),
  wallMs: z.number().int().nullable().describe('Request to submit, held time included'),
  findings: z.array(
    z.object({
      id: z.string(),
      tag: z.string(),
      file: z.string(),
      line: z.number().int().nullable(),
      class: z.string().describe('The judge’s class: match, real, not-a-bug, nit, unclear'),
    }),
  ),
  scores: z.record(z.string(), z.number()).nullable(),
  pass: z.boolean().nullable(),
})
export type CaseResult = z.infer<typeof CaseResult>

const Rate = z.object({
  n: z.number().int(),
  hits: z.number().int(),
  p: z.number().nullable(),
  lo: z.number().nullable(),
  hi: z.number().nullable(),
})

export const RecallSummary = z.object({
  scored: z.number().int(),
  unscored: z.number().int(),
  unscoredReasons: z.record(z.string(), z.number().int()),
  bug: z.object({
    recall: Rate.describe('Bug cases with an important finding judged a match, Wilson 95 % interval'),
    detected: Rate.describe('Bug cases any finding of which is judged a match'),
    severityCalibration: Rate.describe('Detected bugs whose matching finding is important'),
  }),
  control: z.object({
    n: z.number().int(),
    falseAlarms: z.number().int().describe('Important findings on clean controls'),
    falseAlarmsPerControl: z.number().nullable(),
    clean: Rate,
  }),
  noise: z.number().nullable().describe('Findings judged not-a-bug over all findings of scored cases'),
  findings: z.number().int(),
  tiers: z.record(z.string(), z.number().int()),
  wallMs: z.object({ p50: z.number().nullable(), p95: z.number().nullable() }),
})
export type RecallSummary = z.infer<typeof RecallSummary>

const rate = (hits: number, n: number) => {
  const w = wilson(hits, n)
  return { n, hits, p: w?.p ?? null, lo: w?.lo ?? null, hi: w?.hi ?? null }
}

const percentile = (values: number[], q: number): number | null => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? null
}

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0)

/** Recall with a Wilson interval, false alarms per control and noise over the scored cases; unscored ones are counted apart, never as misses. */
export function summarize(cases: readonly CaseResult[]): RecallSummary {
  const scored = cases.filter((c) => c.status === 'scored' && c.scores)
  const score = (c: CaseResult, name: string) => c.scores?.[name] ?? 0
  const bugs = scored.filter((c) => c.kind === 'bug')
  const controls = scored.filter((c) => c.kind === 'control')
  const detected = bugs.filter((c) => score(c, 'detected') === 1)
  const alarms = sum(controls.map((c) => score(c, 'falseAlarms')))
  const findings = sum(scored.map((c) => score(c, 'findings')))
  const noisy = sum(scored.map((c) => Math.round(score(c, 'noise') * score(c, 'findings'))))
  const unscoredReasons: Record<string, number> = {}
  for (const c of cases) {
    if (c.status === 'unscored') {
      const reason = c.reason ?? 'unknown'
      unscoredReasons[reason] = (unscoredReasons[reason] ?? 0) + 1
    }
  }
  const tiers: Record<string, number> = {}
  for (const c of cases) if (c.tier) tiers[c.tier] = (tiers[c.tier] ?? 0) + 1
  const walls = cases.flatMap((c) => (c.wallMs === null ? [] : [c.wallMs]))
  return {
    scored: scored.length,
    unscored: cases.length - scored.length,
    unscoredReasons,
    bug: {
      recall: rate(sum(bugs.map((c) => score(c, 'recall'))), bugs.length),
      detected: rate(detected.length, bugs.length),
      severityCalibration: rate(sum(detected.map((c) => score(c, 'severityCalibration'))), detected.length),
    },
    control: {
      n: controls.length,
      falseAlarms: alarms,
      falseAlarmsPerControl: controls.length ? alarms / controls.length : null,
      clean: rate(sum(controls.map((c) => score(c, 'clean'))), controls.length),
    },
    noise: findings ? noisy / findings : null,
    findings,
    tiers,
    wallMs: { p50: median(walls), p95: percentile(walls, 0.95) },
  }
}

import { z } from 'zod'

/** The defaults of `--auto`; each is also an input of the workflow. */
export const AUTO_DEFAULTS = {
  /** Bug cases the review ground truth needs. */
  target: 200,
  /** The line (USD) on IU eval spend, i.e. the eval workflows' spend on the personal key (not the key's whole total), set 2026-11-03; the margin stays under it. */
  iuLineUsd: 20,
  iuMarginUsd: 0.75,
  /** The IU eval spend counts from here: the line was set at this instant. */
  iuSince: '2026-11-03T00:00:00Z',
  /** Candidates one run labels at most. */
  maxPerRun: 150,
  /** The share of the gateway's eval credit a run plans to spend; the rest absorbs a wrong per-candidate cost. */
  creditShare: 0.9,
  /** Per labelled candidate when no run has history yet (measured 2026-11-03: ≈ $0.047 credit, ≈ $0.028 IU). */
  fallbackCreditUsd: 0.05,
  fallbackIuUsd: 0.035,
  /**
   * The gateway refuses credit mid-run, but nothing stops IU mid-run: the per-record IU cost estimate is the only guard,
   * so the plan uses it times this.
   */
  iuSafetyFactor: 1.25,
} as const

/** What one past labelling run cost each payer, and the candidates it labelled. */
export type RunSpend = { runId: string; labelled: number; creditUsd: number; iuUsd: number }

/**
 * The reads `--auto` sizes a run from. Every one throws with its reason when it cannot answer: the run then fails on
 * that step instead of planning spend from a guess.
 */
export interface AutoPorts {
  /** The gateway's eval credit now: the sum of `evalAvailableUsd` over the pools that are `evalEligible`. */
  creditAvailableUsd(): Promise<number>
  /**
   * The IU eval spend: the eval workflows' spend on the personal key since `since` (ISO instant), not the key's whole
   * total. Throws when a row in range has no cost, so a gap is never read as zero.
   */
  iuSpentUsd(options: { since: string }): Promise<number>
  /** The newest `eval.mine` runs that wrote records, newest first, each with what the gateway billed it per payer. */
  runSpend(options: { limit: number }): Promise<RunSpend[]>
}

export const AutoState = z.enum(['labelled', 'target-reached', 'no-credit', 'iu-line'])
export type AutoState = z.infer<typeof AutoState>

/** The `auto` object of the run record: why this many candidates were labelled, readable without the log. */
export const AutoRecord = z.object({
  state: AutoState,
  target: z.number().int(),
  bugCasesBefore: z.number().int().describe('dev + test bug cases when the run began'),
  bugCasesAfter: z.number().int().describe('dev + test bug cases when the run ended'),
  creditAvailableUsd: z.number().nullable().describe('Eval credit the gateway had; null when the target was reached'),
  creditPerCandidateUsd: z.number().nullable(),
  iuSpentUsd: z.number().nullable().describe('IU spent on eval workflows since the line was set'),
  iuLineUsd: z.number(),
  iuPerCandidateUsd: z.number().nullable(),
  planned: z.number().int().describe('Candidates this run labels'),
})
export type AutoRecord = z.infer<typeof AutoRecord>

/** The cost of one labelled candidate per payer, pooled over the newest runs. A payer with no measured spend falls back to the constant. */
export function perCandidateCosts(history: RunSpend[]): { creditUsd: number; iuUsd: number; runs: number } {
  const used = history.filter((run) => run.labelled > 0)
  const total = (pick: (run: RunSpend) => number) => used.reduce((sum, run) => sum + pick(run), 0)
  const per = (spent: number, records: number, fallback: number) =>
    records > 0 && spent > 0 ? spent / records : fallback
  return {
    creditUsd: per(
      total((run) => run.creditUsd),
      total((run) => run.labelled),
      AUTO_DEFAULTS.fallbackCreditUsd,
    ),
    iuUsd: per(
      total((run) => run.iuUsd),
      total((run) => run.labelled),
      AUTO_DEFAULTS.fallbackIuUsd,
    ),
    runs: used.length,
  }
}

export interface Sizing {
  creditAvailableUsd: number
  iuSpentUsd: number
  iuLineUsd: number
  iuMarginUsd: number
  perCandidate: { creditUsd: number; iuUsd: number }
  /** Unlabelled candidates left. */
  unlabelled: number
  maxPerRun: number
}

/**
 * How many new candidates fit: the smaller of what 90 % of the eval credit pays, what the IU headroom pays (both at the measured IU cost × `iuSafetyFactor`), the per-run cap and the candidates left. No room on the IU side is `iu-line`, none on the credit
 * side `no-credit` (the IU check first: it is the hard line).
 */
export function sizeRun(s: Sizing): { state: 'labelled' | 'no-credit' | 'iu-line'; planned: number } {
  const headroom = s.iuLineUsd - s.iuMarginUsd - s.iuSpentUsd
  const iuPerRecord = s.perCandidate.iuUsd * AUTO_DEFAULTS.iuSafetyFactor
  const byIu = Math.floor(headroom / iuPerRecord)
  if (byIu < 1) return { state: 'iu-line', planned: 0 }
  const byCredit = Math.floor((s.creditAvailableUsd * AUTO_DEFAULTS.creditShare) / s.perCandidate.creditUsd)
  if (byCredit < 1) return { state: 'no-credit', planned: 0 }
  return { state: 'labelled', planned: Math.max(0, Math.min(byIu, byCredit, s.maxPerRun, s.unlabelled)) }
}

import { z } from 'zod'

/** The defaults of `--auto`; each is also an input of the workflow. */
export const AUTO_DEFAULTS = {
  /** Bug cases the review ground truth needs. */
  target: 200,
  /** The IU personal-key line (USD), set 2026-11-03; the margin stays under it. */
  iuLineUsd: 20,
  iuMarginUsd: 0.75,
  /** The IU total counts from here: the line was set at this instant. */
  iuSince: '2026-11-03T00:00:00Z',
  /** Candidates one run labels at most. */
  maxPerRun: 150,
  /** The share of the gateway's eval credit a run plans to spend; the rest absorbs a wrong per-candidate cost. */
  creditShare: 0.9,
  /** Per labelled candidate when no run has history yet (measured 2026-11-03: ≈ $0.047 credit, ≈ $0.028 IU). */
  fallbackCreditUsd: 0.05,
  fallbackIuUsd: 0.035,
} as const

/** What one past labelling run cost each payer, and how many records it wrote (labelled candidates + third seats). */
export type RunSpend = { runId: string; units: number; creditUsd: number; iuUsd: number }

/**
 * The reads `--auto` sizes a run from. Every one throws with its reason when it cannot answer: the run then fails on
 * that step instead of planning spend from a guess.
 */
export interface AutoPorts {
  /** The gateway's eval credit now: the sum of `evalAvailableUsd` over the pools that are `evalEligible`. */
  creditAvailableUsd(): Promise<number>
  /** The running IU total of the eval workflows on the personal key since `since` (ISO instant). */
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
  planned: z.number().int().describe('Candidates this run labels (the third-seat backlog is on top)'),
})
export type AutoRecord = z.infer<typeof AutoRecord>

/**
 * The cost of one record per payer: the newest runs' spend over the records they wrote. A payer with no measured spend
 * falls back to the constant. Pooled over the runs, so a big run weighs more than a three-candidate probe.
 */
export function perCandidateCosts(history: RunSpend[]): { creditUsd: number; iuUsd: number; runs: number } {
  const used = history.filter((run) => run.units > 0)
  const units = used.reduce((sum, run) => sum + run.units, 0)
  const mean = (pick: (run: RunSpend) => number, fallback: number) => {
    const spent = used.reduce((sum, run) => sum + pick(run), 0)
    return units > 0 && spent > 0 ? spent / units : fallback
  }
  return {
    creditUsd: mean((run) => run.creditUsd, AUTO_DEFAULTS.fallbackCreditUsd),
    iuUsd: mean((run) => run.iuUsd, AUTO_DEFAULTS.fallbackIuUsd),
    runs: used.length,
  }
}

export interface Sizing {
  creditAvailableUsd: number
  iuSpentUsd: number
  iuLineUsd: number
  iuMarginUsd: number
  perCandidate: { creditUsd: number; iuUsd: number }
  /** Records awaiting the third labeller: IU only, and they run before the new candidates. */
  thirdSeatBacklog: number
  /** Unlabelled candidates left. */
  unlabelled: number
  maxPerRun: number
}

/**
 * How many new candidates fit: the smaller of what 90 % of the eval credit pays, what the IU headroom pays after the
 * third-seat backlog, the per-run cap and the candidates left. No room on the IU side is `iu-line`, none on the credit
 * side `no-credit` (the IU check first: it is the hard line).
 */
export function sizeRun(s: Sizing): { state: 'labelled' | 'no-credit' | 'iu-line'; planned: number } {
  const headroom = s.iuLineUsd - s.iuMarginUsd - s.iuSpentUsd
  const byIu = Math.floor((headroom - s.thirdSeatBacklog * s.perCandidate.iuUsd) / s.perCandidate.iuUsd)
  if (byIu < 1) return { state: 'iu-line', planned: 0 }
  const byCredit = Math.floor((s.creditAvailableUsd * AUTO_DEFAULTS.creditShare) / s.perCandidate.creditUsd)
  if (byCredit < 1) return { state: 'no-credit', planned: 0 }
  return { state: 'labelled', planned: Math.max(0, Math.min(byIu, byCredit, s.maxPerRun, s.unlabelled)) }
}

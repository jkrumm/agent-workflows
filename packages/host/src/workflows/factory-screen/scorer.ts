import type { Scorer, Verdict } from '@agent-workflows/runtime'
import { z } from 'zod'
import { FactoryScreenOutput } from './schema.ts'

/** Bump on any change to what a score means: compare refuses to mix scorer versions silently. */
export const FACTORY_SCREEN_SCORER_VERSION = '2026-11-08.1'

/** A case's expected verdict: what a careful owner would have answered for the signal. */
export const FactoryScreenReference = z.object({
  verdict: z.enum(['promote', 'dismiss', 'leave']),
  duplicateOf: z.string().nullable(),
  repo: z.string().nullable(),
})
export type FactoryScreenReference = z.output<typeof FactoryScreenReference>

const ZERO = { valid: 0, verdict: 0, safe: 0, duplicate: 0, repo: 0 }

/**
 * The `factory-screen` scorer. Deterministic, no model. Every score is 0 or 1:
 * - `valid`: the output parses as the answer; when it is 0 (or the run failed) so is every other score;
 * - `verdict`: exact agreement with the reference;
 * - `safe`: no wrong act. An acting verdict (promote, dismiss) that differs from the reference's is unsafe; `leave` is
 *   always safe;
 * - `duplicate`: for a dismiss reference with a duplicate, the exact `duplicateOf`; else 1;
 * - `repo`: for a promote reference, the effective repo (`signal.repo` or else the answer's) equals the reference's; else 1.
 * `pass`: valid, verdict, duplicate and repo. A wrong act is named in the feedback.
 */
export const factoryScreenScorer: Scorer<unknown, FactoryScreenReference> = {
  version: FACTORY_SCREEN_SCORER_VERSION,
  reference: FactoryScreenReference,
  score(input, output, ctx): Verdict {
    const failed = (feedback: string): Verdict => ({ scores: { ...ZERO }, pass: false, feedback })
    const parsed = FactoryScreenOutput.safeParse(output)
    if (!parsed.success) return failed(output === null ? 'the run failed' : 'the output is not a screening')
    const got = parsed.data
    const want = ctx.reference
    if (!want) return { scores: { valid: 1 }, pass: true }

    const signalRepo = (input as { request?: { signal?: { repo?: string | null } } } | null)?.request?.signal?.repo
    const effectiveRepo = signalRepo ?? got.repo
    const acts = got.verdict !== 'leave'
    const scores = {
      valid: 1,
      verdict: got.verdict === want.verdict ? 1 : 0,
      safe: acts && got.verdict !== want.verdict ? 0 : 1,
      duplicate:
        want.verdict === 'dismiss' && want.duplicateOf !== null ? Number(got.duplicateOf === want.duplicateOf) : 1,
      repo: want.verdict === 'promote' ? Number(effectiveRepo === want.repo) : 1,
    }
    const problems = [
      ...(scores.safe === 0 ? [`wrong act: ${got.verdict} (want ${want.verdict})`] : []),
      ...(scores.safe === 1 && scores.verdict === 0 ? [`verdict: ${got.verdict} (want ${want.verdict})`] : []),
      ...(scores.duplicate === 0 ? [`duplicateOf: ${String(got.duplicateOf)} (want ${String(want.duplicateOf)})`] : []),
      ...(scores.repo === 0 ? [`repo: ${String(effectiveRepo)} (want ${String(want.repo)})`] : []),
    ]
    return { scores, pass: problems.length === 0, ...(problems.length ? { feedback: problems.join('; ') } : {}) }
  },
}

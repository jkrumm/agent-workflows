import type { Scorer, Verdict } from '@agent-workflows/runtime'
import { z } from 'zod'
import { FactoryErrandNeededOutput } from './schema.ts'

/** Bump on any change to what a score means: compare refuses to mix scorer versions silently. */
export const FACTORY_ERRAND_NEEDED_SCORER_VERSION = '2026-11-13.1'

/** A case's expected verdict: what a careful owner would have answered for the request and its evidence. */
export const FactoryErrandNeededReference = z.object({
  verdict: z.enum(['needed', 'not_needed', 'unsure']),
})
export type FactoryErrandNeededReference = z.output<typeof FactoryErrandNeededReference>

const ZERO = { valid: 0, verdict: 0, safe: 0 }

/**
 * The `factory-errand-needed` scorer. Deterministic, no model. Every score is 0 or 1:
 * - `valid`: the output parses as the answer; when it is 0 (or the run failed) so is every other score;
 * - `verdict`: exact agreement with the reference;
 * - `safe`: no wrong `not_needed`. A `not_needed` where the reference is `needed` closes a request the owner still wanted, so
 *   it is unsafe; an `unsure` where the reference is `needed` is safe (the request stays open) but wrong.
 * `pass`: valid and verdict. A wrong not_needed is named in the feedback.
 */
export const factoryErrandNeededScorer: Scorer<unknown, FactoryErrandNeededReference> = {
  version: FACTORY_ERRAND_NEEDED_SCORER_VERSION,
  reference: FactoryErrandNeededReference,
  score(_input, output, ctx): Verdict {
    const failed = (feedback: string): Verdict => ({ scores: { ...ZERO }, pass: false, feedback })
    const parsed = FactoryErrandNeededOutput.safeParse(output)
    if (!parsed.success) return failed(output === null ? 'the run failed' : 'the output is not a still-needed answer')
    const got = parsed.data
    const want = ctx.reference
    if (!want) return { scores: { valid: 1 }, pass: true }

    const scores = {
      valid: 1,
      verdict: got.verdict === want.verdict ? 1 : 0,
      safe: got.verdict === 'not_needed' && want.verdict === 'needed' ? 0 : 1,
    }
    const feedback =
      scores.safe === 0
        ? `wrong not_needed: ${got.reason}`
        : scores.verdict === 0
          ? `verdict: ${got.verdict} (want ${want.verdict})`
          : undefined
    return { scores, pass: scores.verdict === 1, ...(feedback === undefined ? {} : { feedback }) }
  },
}

import type { Scorer, Verdict } from '@agent-workflows/runtime'
import { z } from 'zod'
import { FactoryErrandOutput } from './schema.ts'

/** Bump on any change to what a score means: compare refuses to mix scorer versions silently. */
export const FACTORY_ERRAND_SCORER_VERSION = '2026-11-08.1'

/** A case's expected verdict: what a careful owner would have answered for the Errand. */
export const FactoryErrandReference = z.object({
  verdict: z.enum(['pass', 'turn_away']),
})
export type FactoryErrandReference = z.output<typeof FactoryErrandReference>

const ZERO = { valid: 0, verdict: 0, safe: 0 }

/**
 * The `factory-errand` scorer. Deterministic, no model. Every score is 0 or 1:
 * - `valid`: the output parses as the answer; when it is 0 (or the run failed) so is every other score;
 * - `verdict`: exact agreement with the reference;
 * - `safe`: no wrong turn-away. A `turn_away` where the reference is `pass` is unsafe (the owner is never paged); a `pass`
 *   where the reference is `turn_away` is safe for the lead but wrong.
 * `pass`: valid and verdict. A wrong turn-away is named in the feedback.
 */
export const factoryErrandScorer: Scorer<unknown, FactoryErrandReference> = {
  version: FACTORY_ERRAND_SCORER_VERSION,
  reference: FactoryErrandReference,
  score(_input, output, ctx): Verdict {
    const failed = (feedback: string): Verdict => ({ scores: { ...ZERO }, pass: false, feedback })
    const parsed = FactoryErrandOutput.safeParse(output)
    if (!parsed.success) return failed(output === null ? 'the run failed' : 'the output is not an Errand screening')
    const got = parsed.data
    const want = ctx.reference
    if (!want) return { scores: { valid: 1 }, pass: true }

    const scores = {
      valid: 1,
      verdict: got.verdict === want.verdict ? 1 : 0,
      safe: got.verdict === 'turn_away' && want.verdict === 'pass' ? 0 : 1,
    }
    const feedback =
      scores.safe === 0
        ? `wrong turn-away: ${got.reason}`
        : scores.verdict === 0
          ? `verdict: ${got.verdict} (want ${want.verdict})`
          : undefined
    return { scores, pass: scores.verdict === 1, ...(feedback === undefined ? {} : { feedback }) }
  },
}

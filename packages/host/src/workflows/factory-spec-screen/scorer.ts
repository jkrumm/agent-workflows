import type { Scorer, Verdict } from '@agent-workflows/runtime'
import { z } from 'zod'
import { FactorySpecScreenOutput } from './schema.ts'

/** Bump on any change to what a score means: compare refuses to mix scorer versions silently. */
export const FACTORY_SPEC_SCREEN_SCORER_VERSION = '2026-11-14.1'

/** A case's expected verdict: what the owner would have wanted for the Spec. */
export const FactorySpecScreenReference = z.object({
  verdict: z.enum(['pass', 'settle']),
})
export type FactorySpecScreenReference = z.output<typeof FactorySpecScreenReference>

const ZERO = { valid: 0, verdict: 0, safe: 0 }

/**
 * The `factory-spec-screen` scorer. Deterministic, no model. Every score is 0 or 1:
 * - `valid`: the output parses as the answer; when it is 0 (or the run failed) so is every other score;
 * - `verdict`: exact agreement with the reference;
 * - `safe`: no wrong `settle`. A `settle` where the reference is `pass` keeps from the owner a Spec he wanted to see, so it is
 *   unsafe; a `pass` where the reference is `settle` is safe (he reads one more) but wrong.
 * `pass`: valid and verdict. A wrong settle is named in the feedback.
 */
export const factorySpecScreenScorer: Scorer<unknown, FactorySpecScreenReference> = {
  version: FACTORY_SPEC_SCREEN_SCORER_VERSION,
  reference: FactorySpecScreenReference,
  score(_input, output, ctx): Verdict {
    const failed = (feedback: string): Verdict => ({ scores: { ...ZERO }, pass: false, feedback })
    const parsed = FactorySpecScreenOutput.safeParse(output)
    if (!parsed.success) return failed(output === null ? 'the run failed' : 'the output is not a pass or settle answer')
    const got = parsed.data
    const want = ctx.reference
    if (!want) return { scores: { valid: 1 }, pass: true }

    const scores = {
      valid: 1,
      verdict: got.verdict === want.verdict ? 1 : 0,
      safe: got.verdict === 'settle' && want.verdict === 'pass' ? 0 : 1,
    }
    const feedback =
      scores.safe === 0
        ? `wrong settle: ${got.reason}`
        : scores.verdict === 0
          ? `verdict: ${got.verdict} (want ${want.verdict})`
          : undefined
    return { scores, pass: scores.verdict === 1, ...(feedback === undefined ? {} : { feedback }) }
  },
}

import type { Scorer, Verdict } from '@agent-workflows/runtime'
import { z } from 'zod'
import { FactorySpecLookOutput } from './schema.ts'

/** Bump on any change to what a score means: compare refuses to mix scorer versions silently. */
const FACTORY_SPEC_LOOK_SCORER_VERSION = '2026-11-21.1'

/** A case's expected verdict: whether the Spec is ready for the owner as written. */
export const FactorySpecLookReference = z.object({
  verdict: z.enum(['ready', 'back']),
})
export type FactorySpecLookReference = z.output<typeof FactorySpecLookReference>

/**
 * The `factory-spec-look` scorer. Deterministic, no model, every score 0 or 1:
 * - `valid`: the output parses as the answer; when it is 0 (or the run failed) so is every other score;
 * - `verdict`: exact agreement with the reference;
 * - `noNeedlessBack`: no `back` where the reference is `ready`. A needless back costs the lead a revision, and the factory
 *   sends a Spec back once, so it is the expensive direction.
 * A run without a reference (drift) scores `valid` alone.
 */
export const factorySpecLookScorer: Scorer<unknown, FactorySpecLookReference> = {
  version: FACTORY_SPEC_LOOK_SCORER_VERSION,
  reference: FactorySpecLookReference,
  score(_input, output, ctx): Verdict {
    const parsed = FactorySpecLookOutput.safeParse(output)
    if (!parsed.success) {
      return {
        scores: { valid: 0, verdict: 0, noNeedlessBack: 0 },
        pass: false,
        feedback: output === null ? 'the run failed' : 'the output is not a ready or back answer',
      }
    }
    const got = parsed.data
    const want = ctx.reference
    if (!want) return { scores: { valid: 1 }, pass: true }
    const scores = {
      valid: 1,
      verdict: got.verdict === want.verdict ? 1 : 0,
      noNeedlessBack: got.verdict === 'back' && want.verdict === 'ready' ? 0 : 1,
    }
    const feedback =
      scores.noNeedlessBack === 0
        ? `needless back: ${got.note ?? got.reason}`
        : scores.verdict === 0
          ? `verdict: ${got.verdict} (want ${want.verdict})`
          : undefined
    return { scores, pass: scores.verdict === 1, ...(feedback === undefined ? {} : { feedback }) }
  },
}

import type { Scorer, Verdict } from '@agent-workflows/runtime'
import { z } from 'zod'
import { FactoryTriageOutput } from './schema.ts'

/** Bump on any change to what a score means: compare refuses to mix scorer versions silently. */
export const FACTORY_TRIAGE_SCORER_VERSION = '2026-11-14.1'

/** A case's expected checkpoint: `spec` for a settle case that owes a Spec, `null` for one that does not. */
export const FactoryTriageReference = z.object({
  checkpoint: z.literal('spec').nullable(),
})
export type FactoryTriageReference = z.output<typeof FactoryTriageReference>

const ZERO = { valid: 0, checkpoint: 0, sized: 0 }

/**
 * The `factory-triage` scorer, for the `checkpoint` answer of settle cases. Deterministic, no model. Every score is 0 or 1:
 * - `valid`: the output parses as the answer; when it is 0 (or the run failed) so is every other score;
 * - `checkpoint`: exact agreement with the reference (an owed Spec that should not be, or a missing one, is 0);
 * - `sized`: a `spec` answer carries `size` medium or large, because the factory drops one whose size is small or null;
 *   1 for a `null` answer.
 * `pass`: checkpoint and sized.
 */
export const factoryTriageScorer: Scorer<unknown, FactoryTriageReference> = {
  version: FACTORY_TRIAGE_SCORER_VERSION,
  reference: FactoryTriageReference,
  score(_input, output, ctx): Verdict {
    const failed = (feedback: string): Verdict => ({ scores: { ...ZERO }, pass: false, feedback })
    const parsed = FactoryTriageOutput.safeParse(output)
    if (!parsed.success) return failed(output === null ? 'the run failed' : 'the output is not a triage answer')
    const got = parsed.data
    const want = ctx.reference
    if (!want) return { scores: { valid: 1 }, pass: true }

    const scores = {
      valid: 1,
      checkpoint: got.checkpoint === want.checkpoint ? 1 : 0,
      sized: got.checkpoint === 'spec' && got.size !== 'medium' && got.size !== 'large' ? 0 : 1,
    }
    const feedback =
      scores.checkpoint === 0
        ? `checkpoint: ${got.checkpoint ?? 'null'} (want ${want.checkpoint ?? 'null'}): ${got.reason}`
        : scores.sized === 0
          ? `a spec flag with size ${got.size ?? 'null'}: the factory drops it`
          : undefined
    return {
      scores,
      pass: scores.checkpoint === 1 && scores.sized === 1,
      ...(feedback === undefined ? {} : { feedback }),
    }
  },
}

import { STEWARD_ACTIONS } from '@agent-workflows/capabilities'
import type { Scorer, Verdict } from '@agent-workflows/runtime'
import { z } from 'zod'
import { FactoryStewardOutput } from './schema.ts'

/** Bump on any change to what a score means: compare refuses to mix scorer versions silently. */
export const FACTORY_STEWARD_SCORER_VERSION = '2026-11-16.1'

/**
 * A case's expected action: the one that the Issue's later record shows was enough. `basis` says which record
 * (`issue-outcome`, `owner-answer`, `rule`, `written`); it is read by people, never by the scorer.
 */
export const FactoryStewardReference = z.object({
  action: z.enum(STEWARD_ACTIONS),
  basis: z.string().min(1),
})
export type FactoryStewardReference = z.output<typeof FactoryStewardReference>

const ZERO = { valid: 0, correct: 0 }

/**
 * The `factory-steward` scorer. Deterministic, no model. Every score is 0 or 1, and a score exists only where it means
 * something, so `agw eval run` (which averages each score over the cases that have it) prints the figures per action:
 * - `valid`: the output parses as an answer; when it is 0 (or the run failed) `correct` is 0 and no other score exists;
 * - `correct`: the action equals the reference's. A guard or an unavailable answer is `none` and scores as one;
 * - `recall.<action>`: on a case whose reference is `<action>`, 1 when the answer is that action (the mean is the recall);
 * - `precision.<action>`: on a case the steward answered `<action>`, 1 when the reference is that action (the mean is
 *   the precision).
 * `pass`: correct. A run without a reference (drift) scores `valid` only.
 */
export const factoryStewardScorer: Scorer<unknown, FactoryStewardReference> = {
  version: FACTORY_STEWARD_SCORER_VERSION,
  reference: FactoryStewardReference,
  score(_input, output, ctx): Verdict {
    const parsed = FactoryStewardOutput.safeParse(output)
    const want = ctx.reference
    if (!parsed.success) {
      const feedback = output === null ? 'the run failed' : 'the output is not a steward answer'
      // A reference makes a failed answer a miss of its action's recall; without one only `valid` exists.
      const scores = want ? { ...ZERO, [`recall.${want.action}`]: 0 } : { valid: 0 }
      return { scores, pass: false, feedback }
    }
    const got = parsed.data
    if (!want) return { scores: { valid: 1 }, pass: true }
    const correct = got.action === want.action ? 1 : 0
    const scores: Record<string, number> = {
      valid: 1,
      correct,
      [`recall.${want.action}`]: correct,
      [`precision.${got.action}`]: correct,
    }
    return {
      scores,
      pass: correct === 1,
      ...(correct === 1 ? {} : { feedback: `${got.action} (want ${want.action}): ${got.reason}` }),
    }
  },
}

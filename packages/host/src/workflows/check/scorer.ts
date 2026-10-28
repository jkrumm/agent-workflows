import type { Json, Scorer, Verdict } from '@agent-workflows/runtime'
import { z } from 'zod'
import { CHECK_OUTPUT, type CheckInput } from './schema.ts'

/** Bump on any change to what a score means: compare refuses to mix scorer versions silently. */
export const CHECK_SCORER_VERSION = '2026-10-28.1'

/** A regression case's expected result: the recorded `passed` and per-step outcome (`CheckCase.legacy`). */
export const CheckReference = z.object({
  passed: z.boolean(),
  steps: z.array(z.object({ name: z.string(), passed: z.boolean() })),
})
export type CheckReference = z.infer<typeof CheckReference>

/**
 * The `check` scorer (concept §6). Deterministic, no model. Every score is in [0, 1], higher is better:
 * - `valid`: the output parses as the check output (else every other score is 0);
 * - `reported`: every requested step is reported (with `commands`: steps over commands, capped at 1; else any step);
 * - `evidence`: the share of failed steps that carry error lines;
 * - `consistent`: `passed` is true exactly when every reported step passed, and a pass reports a step.
 * With a reference (regression): `outcomeAgreement` (`passed` against the recorded run) and `stepAgreement` over the
 * step names both sides ran (left out when they share none). `pass`: valid, reported, evidenced, consistent, and with
 * a reference the outcome agrees.
 */
export const checkScorer: Scorer<CheckInput, CheckReference> = {
  version: CHECK_SCORER_VERSION,
  reference: CheckReference,
  score(input, output, ctx): Verdict {
    const parsed = CHECK_OUTPUT.safeParse(output)
    if (!parsed.success) {
      const scores: Record<string, number> = { valid: 0, reported: 0, evidence: 0, consistent: 0 }
      if (ctx.reference) scores.outcomeAgreement = 0
      return {
        scores,
        pass: false,
        feedback: output === null ? 'the run failed' : 'the output is not the check output',
      }
    }
    const { passed, steps } = parsed.data
    const requested = input.commands?.length ?? 0
    const failed = steps.filter((s) => !s.passed)
    const reported = requested > 0 ? Math.min(1, steps.length / requested) : steps.length > 0 ? 1 : 0
    const evidence = failed.length ? failed.filter((s) => s.errors?.some((e) => e.trim())).length / failed.length : 1
    const consistent = passed === steps.every((s) => s.passed) && (!passed || steps.length > 0) ? 1 : 0
    const scores: Record<string, number> = { valid: 1, reported, evidence, consistent }
    const problems: string[] = []
    if (reported < 1) problems.push('not every requested step is reported')
    if (evidence < 1) problems.push('a failed step has no error lines')
    if (!consistent) problems.push('`passed` disagrees with the steps')
    if (ctx.reference) {
      const { reference } = ctx
      scores.outcomeAgreement = passed === reference.passed ? 1 : 0
      const expected = new Map(reference.steps.map((s) => [s.name, s.passed]))
      const shared = steps.filter((s) => expected.has(s.name))
      if (shared.length)
        scores.stepAgreement = shared.filter((s) => expected.get(s.name) === s.passed).length / shared.length
      if (!scores.outcomeAgreement) problems.push(`passed ${passed}, expected ${reference.passed}`)
    }
    const pass = problems.length === 0
    return { scores, pass, ...(problems.length ? { feedback: problems.join('; ') } : {}) }
  },
}

/** The reference of a recorded check case. */
export function checkReference(legacy: { passed: boolean; steps: { name: string; passed: boolean }[] }): Json {
  return { passed: legacy.passed, steps: legacy.steps.map((s) => ({ name: s.name, passed: s.passed })) }
}

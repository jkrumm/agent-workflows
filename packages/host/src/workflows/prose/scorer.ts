import type { Scorer, Verdict } from '@agent-workflows/runtime'
import { z } from 'zod'
import { type ProseReviewInputValue, ProseReviewOutput } from './schema.ts'

/** Bump on any change to what a score means: compare refuses to mix scorer versions silently. */
export const PROSE_SCORER_VERSION = '2026-10-29.1'

/** A recorded case's expected result: legacy's review scores where a legacy review was recorded, and its lint count. */
export const ProseReference = z.object({
  scores: z.record(z.string(), z.number()).optional(),
  lintCount: z.number().int().nonnegative().optional(),
})
export type ProseReference = z.output<typeof ProseReference>

/**
 * The `prose` scorer (concept §6). Deterministic, no model. Every score is in [0, 1], higher is better:
 * - `valid`: the output parses as the review shape (else every other score is 0);
 * - `notesPresent`: the reviewer wrote notes (a review that finds nothing to say about a draft is not a review);
 * - `scoresInRange`: every criterion score is an integer in 1..5, and `verdict_first` is there exactly when the
 *   caller asked for a verdict-first draft;
 * With a reference: `scoreAgreement` (1 − mean |score − recorded| / 4 over the criteria both sides scored; left out when
 * the case recorded no review) and `lintAgreement` (1 when the lint finding count equals the recorded one).
 * `pass`: valid, notes present, scores in range and, with a recorded lint count, the same findings (lint is code: a
 * difference is a bug, not noise).
 */
export const proseScorer: Scorer<ProseReviewInputValue, ProseReference> = {
  version: PROSE_SCORER_VERSION,
  reference: ProseReference,
  score(input, output, ctx): Verdict {
    const parsed = ProseReviewOutput.safeParse(output)
    if (!parsed.success) {
      const scores: Record<string, number> = { valid: 0, notesPresent: 0, scoresInRange: 0 }
      return { scores, pass: false, feedback: output === null ? 'the run failed' : 'the output is not a prose review' }
    }
    const { review, lint } = parsed.data
    const values = Object.entries(review.scores)
    const inRange = values.every(([, v]) => Number.isInteger(v) && v >= 1 && v <= 5)
    const verdictOk = (review.scores.verdict_first !== undefined) === input.verdictFirst
    const scores: Record<string, number> = {
      valid: 1,
      notesPresent: review.notes.length > 0 ? 1 : 0,
      scoresInRange: inRange && verdictOk ? 1 : 0,
    }
    const problems: string[] = []
    if (!scores.notesPresent) problems.push('the review has no notes')
    if (!scores.scoresInRange) problems.push('a score is out of range, or verdict_first does not match the request')
    const { reference } = ctx
    if (reference?.scores) {
      const recorded = reference.scores
      const shared = values.filter(([criterion]) => recorded[criterion] !== undefined)
      if (shared.length)
        scores.scoreAgreement =
          1 -
          shared.reduce((sum, [criterion, v]) => sum + Math.abs(v - (recorded[criterion] as number)), 0) /
            shared.length /
            4
    }
    if (reference?.lintCount !== undefined) {
      scores.lintAgreement = lint.findings.length === reference.lintCount ? 1 : 0
      if (!scores.lintAgreement) problems.push(`${lint.findings.length} lint findings, recorded ${reference.lintCount}`)
    }
    return { scores, pass: problems.length === 0, ...(problems.length ? { feedback: problems.join('; ') } : {}) }
  },
}

import { matchFindings } from '@agent-workflows/eval'
import type { Json, Scorer, Verdict } from '@agent-workflows/runtime'
import { z } from 'zod'
import { REVIEW_OUTCOMES, type ReviewInputValue, ReviewOutput, type ReviewResult } from './schema.ts'

/** Bump on any change to what a score means: compare refuses to mix scorer versions silently. */
export const REVIEW_SCORER_VERSION = '2026-10-28.1'

const PIPELINE = '(review pipeline)'

/** A regression case's expected result: the recorded outcome and blocking findings (`ReviewCase.legacy`). */
export const ReviewReference = z.object({
  outcome: z.enum(REVIEW_OUTCOMES),
  blocking: z.array(z.object({ file: z.string(), line: z.number().nullish(), message: z.string() })),
})
export type ReviewReference = z.infer<typeof ReviewReference>

/** `Partial review: 2/6 reviewers failed` and `All 6 specialist reviewers failed`, as `verdict.ts` writes them. */
function failedShare(review: ReviewResult): number {
  if (/^All \d+ specialist reviewers failed/.test(review.summary)) return 1
  const partial = /^Partial review: (\d+)\/(\d+) reviewers failed/.exec(review.summary)
  if (partial) return Number(partial[1]) / Math.max(1, Number(partial[2]))
  const failed = review.discussions.filter((d) => d.file === PIPELINE && d.angle !== 'synthesis').length
  return failed > 0 ? 1 : 0 // a pipeline discussion without the lead: the share is unknown, count it as all
}

/** No synthesized verdict: the raw synthesizer text was salvaged, or no review ran (provider balance). */
const incomplete = (review: ReviewResult) =>
  review.degraded !== undefined || review.discussions.some((d) => d.file === PIPELINE && d.angle === 'synthesis')

/**
 * The `review` scorer (concept §6). Deterministic, no model. Every score is in [0, 1], higher is better:
 * - `valid`: the output parses as REVIEW_OUTPUT v2 (else every other score is 0);
 * - `complete`: a synthesized verdict, not a salvaged one or a provider-balance stand-in;
 * - `angleSuccess`: 1 − the share of reviewers that failed;
 * - `decided`: the outcome is not `needs-human`;
 * - `located`: the share of blocking and improvement findings with a file and a line.
 * With a reference (regression): `outcomeAgreement`, and blocking `recall` / `precision` against the reference's
 * blocking findings through the eval harness's deterministic matcher (no judge); a side with no findings leaves that
 * ratio out. `pass`: valid, complete, no reviewer failed, and with a reference the outcome agrees.
 */
export const reviewScorer: Scorer<ReviewInputValue, ReviewReference> = {
  version: REVIEW_SCORER_VERSION,
  reference: ReviewReference,
  async score(_input, output, ctx): Promise<Verdict> {
    const parsed = ReviewOutput.safeParse(output)
    if (!parsed.success) {
      const scores: Record<string, number> = { valid: 0, complete: 0, angleSuccess: 0, decided: 0, located: 0 }
      if (ctx.reference)
        Object.assign(scores, { outcomeAgreement: 0, ...(ctx.reference.blocking.length ? { recall: 0 } : {}) })
      return {
        scores,
        pass: false,
        feedback: output === null ? 'the run failed' : 'the output is not REVIEW_OUTPUT v2',
      }
    }
    const review = parsed.data
    const findings = [...review.blocking, ...review.improvements]
    const located = findings.filter((f) => f.file.trim() && f.file !== PIPELINE && f.line !== undefined).length
    const angleSuccess = 1 - failedShare(review)
    const complete = incomplete(review) ? 0 : 1
    const scores: Record<string, number> = {
      valid: 1,
      complete,
      angleSuccess,
      decided: review.outcome === 'needs-human' ? 0 : 1,
      located: findings.length ? located / findings.length : 1,
    }
    const problems: string[] = []
    if (!complete) problems.push('no synthesized verdict')
    if (angleSuccess < 1) problems.push('reviewers failed')
    if (ctx.reference) {
      const { reference } = ctx
      scores.outcomeAgreement = review.outcome === reference.outcome ? 1 : 0
      const match = await matchFindings(reference.blocking, review.blocking)
      if (match.reference > 0) scores.recall = match.matched / match.reference
      if (match.candidate > 0) scores.precision = match.matched / match.candidate
      if (!scores.outcomeAgreement) problems.push(`outcome ${review.outcome}, expected ${reference.outcome}`)
    }
    const pass = complete === 1 && angleSuccess === 1 && (scores.outcomeAgreement ?? 1) === 1
    return { scores, pass, ...(problems.length ? { feedback: problems.join('; ') } : {}) }
  },
}

/** The reference of a recorded review case: its blocking findings and outcome. */
export function reviewReference(legacy: {
  outcome: ReviewReference['outcome']
  findings: { severity: string; file: string; line?: number; message: string }[]
}): Json {
  return {
    outcome: legacy.outcome,
    blocking: legacy.findings
      .filter((f) => f.severity === 'blocking')
      .map((f) => ({ file: f.file, line: f.line ?? null, message: f.message })),
  }
}

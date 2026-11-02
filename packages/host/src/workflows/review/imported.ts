import { defineWorkflow } from '@agent-workflows/runtime'
import { z } from 'zod'
import type { HostWorkflow } from '../../operations.ts'
import { type ReviewResult, REVIEW_SCHEMA_VERSION, ReviewOutput } from './schema.ts'
import { reviewScorer } from './scorer.ts'

export const IMPORTED_REVIEW_ID = 'review.imported'
export const IMPORTED_REVIEW_VERSION = '2026-11-02.1'

/**
 * One finding of an external reviewer (`docs/review-v2.md` §Arms, the native `/code-review` row), in the judge's own
 * vocabulary: `important` blocks a merge, `nit` and `pre-existing` do not.
 */
export const ImportedFinding = z
  .object({
    file: z.string().min(1).describe('Path of the file the finding is about'),
    line: z.int().positive().optional().describe('First line, when the reviewer named one'),
    endLine: z.int().positive().optional().describe('Last line of a range; needs `line`'),
    message: z.string().min(1).describe('What the issue is'),
    tag: z.enum(['important', 'nit', 'pre-existing']),
  })
  .strict()
  .refine((f) => f.endLine === undefined || (f.line !== undefined && f.endLine >= f.line), {
    message: '`endLine` needs a `line` and must not precede it',
    path: ['endLine'],
  })
export type ImportedFinding = z.infer<typeof ImportedFinding>

export const ImportedReviewInput = z
  .object({
    caseId: z.string().min(1).describe('The ground-truth case the findings are for'),
    label: z.string().min(1).describe('The external arm, e.g. "native-code-review-high"'),
    findings: z.array(ImportedFinding),
  })
  .strict()

/**
 * The findings as a REVIEW_OUTPUT v2 the review scorer reads like any other arm's. The scorer keeps only `file`,
 * `line` and `message`, so a line range is carried in the message, where the judge sees it.
 */
export function importedReview(input: z.output<typeof ImportedReviewInput>): ReviewResult {
  const entry = (f: ImportedFinding) => ({
    file: f.file,
    ...(f.line === undefined ? {} : { line: f.line }),
    message:
      f.endLine !== undefined && f.endLine !== f.line ? `${f.message} (lines ${f.line}-${f.endLine})` : f.message,
    angle: input.label,
  })
  const blocking = input.findings.filter((f) => f.tag === 'important').map(entry)
  const improvements = input.findings.filter((f) => f.tag !== 'important').map(entry)
  return {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    outcome: blocking.length > 0 ? 'actionable' : 'clean',
    blocking,
    improvements,
    discussions: [],
    testGaps: [],
    summary: `Imported ${input.findings.length} findings from ${input.label}`,
  }
}

/**
 * `review.imported`: no model call. It turns a finding list that an external reviewer wrote for one ground-truth case
 * into a review output, so `agw eval import` scores it with the review scorer (same version, same judge) like every
 * arm. Internal: only `eval.import` starts it.
 */
export function createImportedReviewWorkflow(): HostWorkflow {
  const workflow = defineWorkflow({
    id: IMPORTED_REVIEW_ID,
    version: IMPORTED_REVIEW_VERSION,
    input: ImportedReviewInput,
    output: ReviewOutput,
    // The scorer reads the output and the reference only; its input type is the review's, this workflow's is its own.
    scorer: reviewScorer as never,
    async run(ctx, input) {
      return await ctx.step('build', () => importedReview(input))
    },
  })
  return {
    workflow,
    summary: 'An external reviewer’s findings for one ground-truth case, as a review output (eval import)',
    internal: true,
  }
}

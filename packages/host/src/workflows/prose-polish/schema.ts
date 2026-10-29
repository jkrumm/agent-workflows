import { z } from 'zod'
import { ProseReviewInput, ProseReviewOutput } from '../prose/schema.ts'

/** The same fields as `prose`: a draft, where it is read, and the optional audience, register and context. */
export const ProsePolishInput = ProseReviewInput
export type ProsePolishInputValue = z.output<typeof ProsePolishInput>

const reviewed = ProseReviewOutput.shape

/** Agent-gateway's prose job answer, minus its raw usage columns: one `cost` for the writer and the reviewer together. */
export const ProsePolishOutput = z.object({
  kept: z.enum(['rewrite', 'original']),
  text: z
    .string()
    .describe('The text to write: the judged (trimmed) rewrite when it is kept, else the original exactly as given'),
  reason: z.string().optional().describe('Why the original was kept, when it was: the keep gate, or the writer'),
  language: reviewed.language,
  format: reviewed.format,
  mediumNote: reviewed.mediumNote,
  lint: z.object({
    before: z.number().int().nonnegative(),
    after: z.number().int().nonnegative().describe('The rewrite’s findings when it was kept, else the original’s'),
    findings: reviewed.lint.shape.findings.describe('The findings that remain in `text`'),
  }),
  review: reviewed.review,
  visualSuggestions: reviewed.visualSuggestions,
  models: z.object({ writer: z.string(), reviewer: z.string() }),
  cost: z.number().nullable().describe('USD for the reviewer and the writer together; null when neither was priced'),
})
export type ProsePolishOutputValue = z.output<typeof ProsePolishOutput>

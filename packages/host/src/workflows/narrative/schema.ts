import { MAX_PAGE_CHARS, NARRATIVE_LIMITS, NARRATIVE_SECTIONS } from '@agent-workflows/capabilities'
import { z } from 'zod'
import { BOOTSTRAP_COMMIT_LIMIT, BOOTSTRAP_DAYS } from './gather.ts'

export { NARRATIVE_SECTIONS }

const SINCE_FORMAT = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/

/** A date, a time without an offset (UTC) or a full ISO timestamp, as a UTC ISO string; anything else is an issue. */
const SinceSchema = z
  .string()
  .max(100)
  .transform((value, ctx) => {
    const match = SINCE_FORMAT.exec(value)
    const parsed = match
      ? Date.parse(value.includes('T') ? (match[1] ? value : `${value}Z`) : `${value}T00:00:00Z`)
      : Number.NaN
    if (Number.isNaN(parsed)) {
      ctx.addIssue({
        code: 'custom',
        message: 'since must be an ISO date or timestamp, e.g. 2026-10-01 or 2026-10-01T00:00:00Z',
      })
      return z.NEVER
    }
    return new Date(parsed).toISOString()
  })

/** agent-gateway's `NARRATIVE_INPUT` minus the free `model` override (the model is the `narrative` route's). */
export const NarrativeInput = z
  .object({
    cwd: z.string().min(1).max(1_000).describe('Absolute path to the target repo.'),
    project: z.string().min(1).max(200).describe('Vault page name for this project, e.g. "weatherorb".'),
    previousPage: z
      .string()
      .max(MAX_PAGE_CHARS)
      .nullable()
      .default(null)
      .describe(
        'Full markdown of the existing page, including frontmatter, or null on a first run (bootstrap from project history).',
      ),
    since: SinceSchema.nullable()
      .default(null)
      .describe(
        'ISO timestamp or date: only commits and session prose strictly after this count. A date alone is midnight and a ' +
          'time without an offset is UTC; the value is normalised to a UTC timestamp. Anything unparseable is refused, not ' +
          'silently read as "no sessions". null bootstraps from history: ' +
          `the last ${BOOTSTRAP_COMMIT_LIMIT} commits or ${BOOTSTRAP_DAYS} days, whichever is smaller.`,
      ),
    polish: z
      .boolean()
      .default(true)
      .describe(
        'Run the rendered page through the `prose-polish` workflow (lint, cross-lab review, rewrite, keep gate, medium vault) ' +
          'before returning it; frontmatter is kept verbatim. false skips it: faster and cheaper, the page is exactly what ' +
          "the worker's sections render to. A failing or declined polish never fails the run.",
      ),
  })
  .strict()
export type NarrativeInputValue = z.output<typeof NarrativeInput>

export const NarrativeProse = z.object({
  status: z
    .enum(['polished', 'declined', 'errored'])
    .describe(
      'polished: the rewrite replaced the body. declined: the original body came back (keep gate, changed headings, ' +
        'nothing to polish). errored: the polish failed or refused the input.',
    ),
  kept: z.enum(['rewrite', 'original']),
  keptReason: z
    .string()
    .optional()
    .describe('Why the unpolished page came back: the keep gate’s reason, or the polish error.'),
  costUsd: z.number().nullable().describe('Polish writer + reviewer cost; null when unknown.'),
})
export type NarrativeProseValue = z.output<typeof NarrativeProse>

/** agent-gateway's `NARRATIVE_OUTPUT` minus `backend` (the platform has one backend). */
export const NarrativeOutput = z.object({
  project: z.string(),
  changed: z.boolean(),
  reason: z.string().max(NARRATIVE_LIMITS.reasonChars).describe("Why the page did or didn't change."),
  summary: z
    .string()
    .max(NARRATIVE_LIMITS.summaryChars)
    .nullable()
    .describe('The delta in one sentence, for a briefing. Null when unchanged.'),
  page: z
    .string()
    .nullable()
    .describe(
      'Full markdown incl. frontmatter, ready for the vault; the body is the polished rewrite when `prose.status` is ' +
        '`polished`. Null when unchanged. The workflow never writes it anywhere: the caller does.',
    ),
  sections: NARRATIVE_SECTIONS.nullable().describe(
    "The worker's structured data, unpolished: never rewritten by the polish.",
  ),
  inputs: z.object({
    commits: z.number().describe('Commits included in the prompt, after the 30 KB cap.'),
    sessions: z.number().describe('Session transcripts included in the prompt, after the cap.'),
    sinceUsed: z.string().describe('The effective ISO cutoff actually applied: the bootstrap floor when since=null.'),
  }),
  model: z.string().describe('Worker model id actually used.'),
  prose: NarrativeProse.optional().describe(
    'Outcome of the polish of `page`. Absent when `polish` was false or nothing changed.',
  ),
})
export type NarrativeOutputValue = z.output<typeof NarrativeOutput>

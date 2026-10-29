import { MAX_PAGE_CHARS, NARRATIVE_LIMITS, NARRATIVE_SECTIONS } from '@agent-workflows/capabilities'
import { z } from 'zod'
import { BOOTSTRAP_COMMIT_LIMIT, BOOTSTRAP_DAYS } from './gather.ts'

export { NARRATIVE_SECTIONS }

/** agent-gateway's `NARRATIVE_INPUT` minus the free `model` override (the model is the `narrative` route's). */
export const NarrativeInput = z
  .object({
    cwd: z.string().min(1).describe('Absolute path to the target repo.'),
    project: z.string().min(1).max(200).describe('Vault page name for this project, e.g. "weatherorb".'),
    previousPage: z
      .string()
      .max(MAX_PAGE_CHARS)
      .nullable()
      .default(null)
      .describe(
        'Full markdown of the existing page, including frontmatter, or null on a first run (bootstrap from project history).',
      ),
    since: z
      .string()
      .max(100)
      .nullable()
      .default(null)
      .describe(
        'ISO timestamp: only commits and session prose strictly after this count. null bootstraps from history: ' +
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

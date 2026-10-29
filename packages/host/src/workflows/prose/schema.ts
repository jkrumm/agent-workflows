import {
  MAX_PROSE_BRIEF_CHARS as MAX_BRIEF_CHARS,
  MAX_PROSE_CONTEXT_CHARS as MAX_CONTEXT_CHARS,
  MAX_PROSE_TEXT_CHARS as MAX_TEXT_CHARS,
  PROSE_FORMATS as FORMATS,
  PROSE_LANGUAGES as LANGUAGES,
  PROSE_MEDIUMS as MEDIUMS,
  PROSE_REGISTERS as REGISTERS,
} from '@agent-workflows/capabilities'
import { z } from 'zod'

export { MAX_TEXT_CHARS }

const notBlank = (text: string) => text.trim() !== ''

const medium = z
  .enum(MEDIUMS)
  .describe('Where the text will be read: article, vault, landing, ui, chat, docs or briefing.')
const language = z.enum(['en', 'de', 'auto']).default('auto')

/** `prose.review` input: agent-gateway's `PROSE_INPUT` minus the writer fields (`model`, `reviewModel`). */
export const ProseReviewInput = z
  .object({
    text: z
      .string()
      .max(MAX_TEXT_CHARS)
      .refine(notBlank, { message: 'text must not be empty or whitespace only' })
      .describe('The draft to improve. Fenced code is kept as written; the words around it are rewritten.'),
    medium,
    language: language.describe('Language of the draft. `auto` detects it by stopword count.'),
    register: z
      .enum(REGISTERS)
      .optional()
      .describe(
        'Reader register: peer-technical (a fellow engineer), broad (any reader) or personal. ' +
          'Defaults from `medium` (article/vault/docs → peer-technical, briefing/landing/ui → broad, chat → personal).',
      ),
    brief: z
      .string()
      .max(MAX_BRIEF_CHARS)
      .optional()
      .describe("Optional audience or goal, e.g. 'the on-call engineer deciding whether to roll back'."),
    verdictFirst: z
      .boolean()
      .default(true)
      .describe(
        'Lead with the conclusion (default). false: the author deliberately builds criteria → candidates → verdict; ' +
          'the writer keeps the section order and hoists no recommendation, and the reviewer returns no verdict_first score.',
      ),
    context: z
      .string()
      .max(MAX_CONTEXT_CHARS)
      .optional()
      .describe(
        'Optional outline or TLDR of the surrounding document, for consistency only: shown to the reviewer and the ' +
          'writer as read-only data, never rewritten or quoted into the output.',
      ),
  })
  .strict()
export type ProseReviewInputValue = z.output<typeof ProseReviewInput>

const Finding = z.object({ rule: z.string(), line: z.number().int(), excerpt: z.string() })
const Scores = z.object({
  verdict_first: z.number().optional(),
  structure: z.number(),
  no_repetition: z.number(),
  concision: z.number(),
  precision: z.number(),
  clarity: z.number(),
  visual_fit: z.number(),
  naturalness: z.number(),
  engagement: z.number(),
})

export const ProseReviewOutput = z.object({
  language: z.enum(LANGUAGES),
  format: z.enum(FORMATS),
  mediumNote: z
    .string()
    .describe('One line on what the chosen `medium` changes (the same table the writer brief uses)'),
  lint: z.object({
    findings: z.array(Finding),
    counts: z.record(z.string(), z.number().int()).describe('Findings per rule'),
  }),
  review: z.object({
    scores: Scores,
    notes: z.array(z.object({ criterion: z.string(), note: z.string() })),
  }),
  visualSuggestions: z.array(z.object({ kind: z.string(), shows: z.string(), where: z.string() })),
  reviewer: z.string().describe('The model that answered the review'),
  voicePath: z.string().describe('The voice guide the calling session loads before it rewrites'),
  writerBrief: z
    .string()
    .describe('The instruction block the calling session rewrites from: rules, rubric and the fenced data'),
})
export type ProseReviewOutputValue = z.output<typeof ProseReviewOutput>

/** `prose.gate` input: the original, the calling session's rewrite and how the text is read. */
export const ProseGateInput = z
  .object({
    original: z
      .string()
      .max(MAX_TEXT_CHARS)
      .refine(notBlank, { message: 'original must not be empty or whitespace only' })
      .describe('The draft as it was'),
    rewrite: z
      .string()
      .max(MAX_TEXT_CHARS * 2)
      .describe('The rewrite to judge; an empty one is valid and keeps the original'),
    language: language.describe('Language of the draft. `auto` detects it from the original.'),
  })
  .strict()
export type ProseGateInputValue = z.output<typeof ProseGateInput>

const LintTally = z.object({
  count: z.number().int().nonnegative(),
  byRule: z.record(z.string(), z.number().int()),
})

export const ProseGateOutput = z.object({
  kept: z.enum(['rewrite', 'original']),
  text: z
    .string()
    .describe('The text to write: the judged (trimmed) rewrite when it is kept, else the original exactly as given'),
  reason: z.string().optional().describe('Why the original was kept, when it was'),
  language: z.enum(LANGUAGES),
  format: z.enum(FORMATS),
  lint: z.object({ before: LintTally, after: LintTally }),
})
export type ProseGateOutputValue = z.output<typeof ProseGateOutput>

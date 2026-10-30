import { z } from 'zod'

export const DEPTHS = ['quick', 'standard', 'deep'] as const
export type Depth = (typeof DEPTHS)[number]

export const ResearchInput = z
  .object({
    query: z.string().min(3).describe('The research question'),
    depth: z.enum(DEPTHS).default('standard').describe('quick: one fact; standard: a few sources; deep: a survey'),
    context: z
      .string()
      .min(1)
      .max(20_000)
      .optional()
      .describe('Background the caller already knows: treated as established, never re-searched, never cited'),
    contextRuns: z
      .array(z.string().min(1))
      .max(6)
      .optional()
      .describe(
        'Ids of finished research runs on related questions (parallel runs of one task): their reports are background, their sources citable, and where they contradict each other or this question the answer says so and settles it against a primary source',
      ),
    followUp: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Id of a finished research run to continue: the query is then a new question about it, researched on top of the run's report",
      ),
  })
  .strict()
export type ResearchInputValue = z.output<typeof ResearchInput>

export const Confidence = z.enum(['high', 'medium', 'low'])

export const Citation = z.object({ claim: z.string(), url: z.string(), confidence: Confidence })
export const Unverified = z.object({ topic: z.string(), url: z.string().max(2048).nullable(), reason: z.string() })

/** What an agent submits: research-gateway's `SubmittedReport`. Status, warnings and grounding are derived in code. */
export const Draft = z.object({
  report: z.string().min(1),
  citations: z.array(Citation).default([]),
  sources: z.array(z.string()).default([]),
  unverified: z.array(Unverified).default([]),
})
export type Draft = z.output<typeof Draft>

/**
 * Evidence counted in code, never asserted by a model. `citations` is every citation the agent submitted before the
 * grounding rule (which drops ungrounded ones, so the final list can be shorter); `grounded` how many of them cite a
 * URL the run retrieved or saw as a search result (a follow-up also counts the earlier run's retrieved pages).
 * `pagesRetrieved` and `pagesFailed` are this run's own.
 */
export const Grounding = z.object({
  citations: z.number().int().nonnegative(),
  grounded: z.number().int().nonnegative(),
  pagesRetrieved: z.number().int().nonnegative(),
  pagesFailed: z.number().int().nonnegative(),
})
export type Grounding = z.output<typeof Grounding>

/** A page that turned the reader away (bot challenge, 403, login wall): the caller can open it in a real browser and feed the text back as `context`. */
export const Blocked = z.object({ url: z.string(), reason: z.string() })

/** Tool calls the agent made through the platform's tool gate, by tool. */
export const ToolCounts = z.record(z.string(), z.number().int().nonnegative())

/**
 * research-gateway's `ResearchReport` (`src/agent/schema.ts`), so callers of `/research` keep working, plus the
 * code-counted `grounding` and the agent's tool counts.
 */
export const ResearchOutput = z.object({
  report: z.string(),
  citations: z.array(Citation),
  sources: z.array(z.string()),
  unverified: z.array(Unverified),
  status: z.enum(['ok', 'partial']),
  warnings: z.array(z.string()),
  grounding: Grounding,
  tools: ToolCounts.optional(),
  blocked: z.array(Blocked).default([]),
})
export type ResearchResult = z.output<typeof ResearchOutput>

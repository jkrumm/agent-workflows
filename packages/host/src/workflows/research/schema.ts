import { z } from 'zod'

export const DEPTHS = ['quick', 'standard', 'deep'] as const
export type Depth = (typeof DEPTHS)[number]

/**
 * The comparison's arms (Wave 6, concept P3): `engine` is research-gateway's code-led pipeline over its REST API,
 * `agent` one OpenCode agent with the platform's web tools, `pilot` an OpenCode agent that drives the engine's quick
 * jobs as a tool. `design` and `profile` are removed again once the comparison has decided (concept §0, no shim).
 */
export const DESIGNS = ['engine', 'agent', 'pilot'] as const
export type Design = (typeof DESIGNS)[number]
/** Concept D4: `yolo` allows broadly, `focused` is the opt-in quality lever (fewer tools, a narrower directive). */
export const PROFILES = ['yolo', 'focused'] as const
export type Profile = (typeof PROFILES)[number]

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
    design: z.enum(DESIGNS).default('engine').describe('Comparison arm (Wave 6 only): engine, agent or pilot'),
    profile: z
      .enum(PROFILES)
      .default('yolo')
      .describe('Comparison arm (Wave 6 only): yolo or focused; engine ignores it'),
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
 * Evidence counted in code, never asserted by a model. `citations` is every citation the run produced before any
 * gate (the engine drops ungrounded ones, so its final list can be shorter); `grounded` how many of them cite a URL
 * the run retrieved or saw as a search result.
 */
export const Grounding = z.object({
  source: z.enum(['engine', 'tools']),
  citations: z.number().int().nonnegative(),
  grounded: z.number().int().nonnegative(),
  pagesRetrieved: z.number().int().nonnegative(),
  pagesFailed: z.number().int().nonnegative(),
})
export type Grounding = z.output<typeof Grounding>

/** Tool calls an agent made through the platform's tool gate, by tool. Absent for the engine. */
export const ToolCounts = z.record(z.string(), z.number().int().nonnegative())

/**
 * research-gateway's `ResearchReport` (`src/agent/schema.ts`), so callers of `/research` keep working, plus the
 * code-counted `grounding` and the arm that produced it.
 */
export const ResearchOutput = z.object({
  report: z.string(),
  citations: z.array(Citation),
  sources: z.array(z.string()),
  unverified: z.array(Unverified),
  status: z.enum(['ok', 'partial']),
  warnings: z.array(z.string()),
  grounding: Grounding,
  arm: z.object({ design: z.enum(DESIGNS), profile: z.enum(PROFILES).nullable() }),
  tools: ToolCounts.optional(),
  /** The engine's own job id and spend (`cost.totalUsd`), for the engine and pilot arms. */
  engine: z.object({ jobs: z.array(z.string()), costUsd: z.number().nullable() }).optional(),
})
export type ResearchResult = z.output<typeof ResearchOutput>

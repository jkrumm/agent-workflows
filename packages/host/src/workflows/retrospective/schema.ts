import { z } from 'zod'

export const DEFAULT_WINDOW_DAYS = 7
export const DEFAULT_SAMPLE = 20

export const RETRO_INPUT = z
  .object({
    workflow: z.string().min(1).describe('The workflow to look back on (one that runs agents), e.g. review'),
    window: z.number().int().min(1).max(90).default(DEFAULT_WINDOW_DAYS).describe('Days back from now'),
    sample: z.number().int().min(1).max(100).default(DEFAULT_SAMPLE).describe('Finished runs read, failed ones first'),
    fileIssues: z
      .boolean()
      .default(false)
      .describe('File each proposal as a GitHub issue in this repo (deduped by title); default only reports'),
  })
  .strict()

export const PROPOSAL_KINDS = ['capability', 'agents-md', 'skill', 'cli'] as const
export const CONFIDENCES = ['low', 'medium', 'high'] as const

/** What the agent answers. Everything in it is checked again in code before it is stored or filed. */
export const RETRO_ANALYSIS = z.object({
  proposals: z
    .array(
      z.object({
        kind: z
          .enum(PROPOSAL_KINDS)
          .describe('capability: code the agent keeps writing; agents-md | skill: a recurring mistake; cli: tool pain'),
        target: z
          .string()
          .min(1)
          .describe('An agent name, or a repo-relative path inside this repo (agents/…, packages/…, docs/…)'),
        title: z.string().min(8).max(100).describe('One line naming the change, no paths or repo names'),
        change: z.string().min(1).max(1500).describe('The change proposed and why, in plain text'),
        evidence: z.array(z.string()).min(1).describe('Run ids from the sample that show it'),
        confidence: z.enum(CONFIDENCES),
      }),
    )
    .max(10),
  learnings: z
    .array(
      z.object({
        agent: z.string().min(1).describe('The agent that should know this on its next run'),
        fact: z.string().min(1).describe('One self-contained observation, at most 400 characters'),
        evidence: z.array(z.string()).min(1).describe('Run ids from the sample that show it'),
      }),
    )
    .max(10),
})

export type RetroAnalysis = z.output<typeof RETRO_ANALYSIS>
export type RetroInput = z.output<typeof RETRO_INPUT>

const Proposal = z.object({
  kind: z.enum(PROPOSAL_KINDS),
  target: z.string(),
  title: z.string(),
  change: z.string(),
  evidence: z.array(z.string()),
  confidence: z.enum(CONFIDENCES),
})

export const RETRO_OUTPUT = z.object({
  workflow: z.string(),
  windowDays: z.number().int(),
  /** Runs the agent saw. 0 means no agent step ran. */
  sampled: z.number().int(),
  proposals: z.array(Proposal),
  learnings: z.array(
    z.object({
      agent: z.string(),
      fact: z.string(),
      evidence: z.array(z.string()),
      /** The stored (proposed) learning's id; null when an identical live fact already existed. */
      learningId: z.number().int().nullable(),
    }),
  ),
  /** One entry per proposal when `fileIssues` was on. */
  issues: z.array(
    z.object({
      title: z.string(),
      status: z.enum(['filed', 'duplicate', 'refused']),
      url: z.string().optional(),
      reason: z.string().optional(),
    }),
  ),
  /** Answers checked away in code: unknown evidence, an agent the workflow does not run, a bad target. */
  dropped: z.array(z.string()),
})

export type RetroOutput = z.output<typeof RETRO_OUTPUT>

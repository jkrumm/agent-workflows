import { z } from 'zod'

export const DEFAULT_WINDOW_DAYS = 7
export const DEFAULT_SAMPLE = 20

const nullable = <T extends z.ZodType>(schema: T) => schema.nullable().default(null)

/** A fixture run, as `sample.ts` reads one from the journal; what a case leaves out is null (steps: `toolCalls` 0, `tools` none). */
const FIXTURE_RUN = z.object({
  runId: z.string().regex(/^[\w-]{8,64}$/),
  status: z.enum(['done', 'failed']),
  fingerprint: nullable(z.string()),
  wallMs: nullable(z.number()),
  cost: nullable(z.number()),
  toolCalls: nullable(z.number()),
  friction: nullable(z.json()),
  errorKind: nullable(z.string()),
  error: nullable(z.string()),
  steps: z.array(
    z.object({
      stepId: z.string(),
      kind: z.string(),
      status: z.string(),
      model: nullable(z.string()),
      toolCalls: z.number().default(0),
      tools: z
        .array(
          z.object({
            tool: z.string(),
            calls: z.number(),
            failed: z.number().default(0),
            repeats: z.number().default(0),
          }),
        )
        .default([]),
      cost: nullable(z.number()),
      errorKind: nullable(z.string()),
      error: nullable(z.string()),
      output: nullable(z.string()),
    }),
  ),
})

export const RETRO_INPUT = z
  .object({
    fixture: z
      .object({ runs: z.array(FIXTURE_RUN).min(1).max(100) })
      .optional()
      .describe(
        'Eval only: analyze these runs instead of sampling the journal; stores no learning and files no signal',
      ),
    workflow: z.string().min(1).describe('The workflow to look back on (one that runs agents), e.g. review'),
    window: z.number().int().min(1).max(90).default(DEFAULT_WINDOW_DAYS).describe('Days back from now'),
    sample: z.number().int().min(1).max(100).default(DEFAULT_SAMPLE).describe('Finished runs read, failed ones first'),
    fileSignals: z
      .boolean()
      .default(false)
      .describe(
        'File the best-evidenced proposals (at most 3) as factory signals for this repo, triage dedupes them; default only reports',
      ),
  })
  .strict()

export const PROPOSAL_KINDS = ['capability', 'agents-md', 'skill', 'cli'] as const
const CONFIDENCES = ['low', 'medium', 'high'] as const

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
          .describe(
            'A path in this repository (agents/<name>/AGENTS.md, packages/…, docs/…) or an agent name. A signal is filed only for a path that exists',
          ),
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
      /** The learning this fact is on file as (new or already there; see `outcome`); null for a fixture, which stores nothing. */
      learningId: z.number().int().nullable(),
      /** new: stored; repeat: seen again, recorded; activated: seen in a second week, now read back; known: nothing changed. */
      outcome: z.enum(['new', 'repeat', 'activated', 'known']),
    }),
  ),
  /** What the learnings rule did after this run's facts were stored (all zero for a fixture). */
  tidy: z.object({
    merged: z.number().int(),
    activated: z.array(z.number().int()),
    retired: z.array(z.number().int()),
  }),
  /** One entry per proposal when `fileSignals` was on. */
  signals: z.array(
    z.object({
      /** The proposal hash (16 hex) the signal's marker carries. */
      hash: z.string(),
      title: z.string().optional(),
      /** capped: past the per-run limit, not filed; duplicate: the same proposal twice in this run; failed: the factory refused it. */
      status: z.enum(['filed', 'duplicate', 'refused', 'capped', 'failed']),
      reason: z.string().optional(),
    }),
  ),
  /** Answers checked away in code: unknown evidence, an agent the workflow does not run, a bad target. */
  dropped: z.array(z.string()),
})

export type RetroOutput = z.output<typeof RETRO_OUTPUT>

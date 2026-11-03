// Review v4 contracts: the reviewer agent's reply (`docs/spikes/review-v4/reviewer.md` §Reply), REVIEW_OUTPUT v4 and the
// operations' inputs and outputs.
import { z } from 'zod'
import { ACCOUNT_ID_PATTERN } from '../fleet/quota.ts'
import { TIERS } from './route.ts'

export const REVIEW_OUTPUT_VERSION = 4
export const TAGS = ['important', 'nit', 'pre-existing'] as const
export const CLASSES = ['intent', 'domain', 'duplication', 'architecture', 'bug', 'security'] as const
export const DISPOSITIONS = ['open', 'fixed', 'wrong', 'intentional', 'irrelevant'] as const
export const JOB_STATES = ['prepared', 'submitted', 'abandoned'] as const
export const OUTCOMES = ['clean', 'actionable', 'needs-human'] as const
export type Tag = (typeof TAGS)[number]
export type FindingClass = (typeof CLASSES)[number]
export type Disposition = (typeof DISPOSITIONS)[number]
export type Outcome = (typeof OUTCOMES)[number]

const TIER = z.enum(TIERS)
const RAISE = z.enum(['light', 'standard', 'deep'])
/** An empty string from the agent reads as absent. */
const optionalText = z
  .string()
  .nullish()
  .transform((s) => (s?.trim() ? s : undefined))

/** One finding as the reviewer replies it; unknown fields are dropped. */
export const ReplyFinding = z.object({
  id: optionalText.describe('Only with stillOpen: the id of the prior finding still present'),
  tag: z.enum(TAGS),
  class: z.enum(CLASSES),
  file: z.string().min(1),
  line: z
    .number()
    .int()
    .nullish()
    .transform((n) => (n && n > 0 ? n : null)),
  existing: optionalText,
  message: z.string().min(1),
  failureScenario: z.string().default(''),
  fix: optionalText,
  otherInstances: z.array(z.string()).nullish(),
  votes: optionalText,
  stillOpen: z.boolean().nullish(),
})
export type ReplyFindingValue = z.output<typeof ReplyFinding>

export const ReviewerReply = z.object({
  intent: z.string().default(''),
  files: z.array(z.string()),
  findings: z.array(ReplyFinding).default([]),
  checked: z.array(z.string()).default([]),
  stepBack: z.string().nullish(),
})
export type ReviewerReplyValue = z.output<typeof ReviewerReply>

const SEAT = z.object({
  model: z.literal('sonnet'),
  effort: z.enum(['low', 'medium', 'high']),
  vote: z.number().optional(),
})

export const OutputFinding = z.object({
  id: z.string(),
  tag: z.enum(TAGS),
  class: z.enum(CLASSES),
  file: z.string(),
  line: z.number().int().nullable(),
  existing: z.string().optional(),
  message: z.string(),
  failureScenario: z.string(),
  fix: z.string().optional(),
  otherInstances: z.array(z.string()).optional(),
  votes: z.string().optional(),
  stillOpen: z.literal(true).optional(),
})
export type OutputFindingValue = z.output<typeof OutputFinding>

/** REVIEW_OUTPUT v4: `outcome`, `summary`, `stepBack` and `tier` are code's, never the reply's. */
export const ReviewOutputV4 = z.object({
  schemaVersion: z.literal(REVIEW_OUTPUT_VERSION),
  jobId: z.string(),
  thread: z.string(),
  round: z.number().int(),
  tier: TIER,
  seat: SEAT.nullable(),
  rule: z.string(),
  account: z.string().nullable(),
  intent: z.string().describe("The reviewer's one line on what the change was asked to do"),
  outcome: z.enum(OUTCOMES),
  summary: z.string().describe('Count first: "2 important, 1 nit." or "Nothing needs fixing."'),
  findings: z.array(OutputFinding),
  checked: z.array(z.string()),
  stepBack: z.string().nullable(),
  files: z.array(z.string()),
  dropped: z.object({
    repeats: z.number().int().describe('Findings the thread already holds'),
    nits: z.number().int().describe('Nits past the REVIEW.md cap'),
  }),
  base: z.string(),
  diffBase: z.string(),
  head: z.string(),
})
export type ReviewOutputV4Value = z.output<typeof ReviewOutputV4>

const CWD = z
  .string()
  .refine((cwd) => cwd.startsWith('/'), { message: 'cwd must be an absolute path' })
  .describe('Absolute path inside the git work tree')

export const PrepareInput = z
  .object({
    cwd: CWD,
    scope: z
      .string()
      .optional()
      .describe(
        '"uncommitted" (default; a snapshot commit, the work tree untouched), "head" (the last commit), a ref (merge-base(ref, HEAD)..HEAD) or "<a>..<b>". Omit with pr or branch',
      ),
    pr: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Pull request number on origin; reviewed against origin's default branch"),
    branch: z.string().optional().describe("Remote branch on origin; reviewed against origin's default branch"),
    context: z.string().optional().describe('What the change was asked to do: the brief, the plan step, the PR body'),
    min: RAISE.optional().describe('Raise the routed tier to at least this one (never lowers it)'),
    thread: z.string().min(1).max(200).optional().describe('Thread key; default pr:<n>, branch:<b> or the base commit'),
    account: z
      .string()
      .regex(new RegExp(ACCOUNT_ID_PATTERN))
      .optional()
      .describe("The caller's Max account: judged against the review ceiling"),
  })
  .strict()
export type PrepareInputValue = z.output<typeof PrepareInput>

const DECISION = {
  tier: TIER,
  seat: SEAT.nullable(),
  rule: z.string(),
  decidedBy: z.enum(['rule', 'default', 'caller', 'classifier']),
}

export const PrepareOutput = z.object({
  status: z.enum(['ready', 'skipped', 'held', 'needs-human']),
  reason: z.string().optional().describe('held and needs-human: why'),
  jobId: z.string().optional(),
  thread: z.string(),
  round: z.number().int(),
  tier: TIER.optional(),
  seat: SEAT.nullable().optional(),
  rule: z.string().optional(),
  decidedBy: DECISION.decidedBy.optional(),
  base: z.string(),
  diffBase: z.string().optional(),
  head: z.string(),
  jobDir: z.string().optional(),
  worktree: z.string().optional(),
  files: z.array(z.string()).optional(),
  account: z.string().nullable(),
  ceiling: z
    .enum(['ok', 'held', 'unknown', 'unjudged', 'factory'])
    .optional()
    .describe(
      'unjudged: no account given; unknown: no quota reading; factory: the factory judges it (hidden transport)',
    ),
  prompt: z.string().optional().describe('The reviewer agent prompt line'),
})
export type PrepareOutputValue = z.output<typeof PrepareOutput>

/** `request` is `prepare` for the hidden transport: the factory picks the account, so there is none to give. */
export const RequestInput = PrepareInput.omit({ account: true }).strict()
export type RequestInputValue = z.output<typeof RequestInput>

export const RequestOutput = PrepareOutput.extend({
  status: z.enum(['requested', 'skipped', 'needs-human']),
  spawnKey: z.string().optional().describe("The factory session's key: review-<jobId>-a1"),
  spawn: z.unknown().optional().describe("The factory's spawn status, a hold reason included when it is queued"),
})
export type RequestOutputValue = z.output<typeof RequestOutput>

export const SubmitInput = z
  .object({
    jobId: z.string().min(1).describe('The job from prepare'),
    attempt: z.number().int().positive().describe('The reviewer attempt; a submit is idempotent per (job, attempt)'),
    reply: z.string().min(1).describe("The reviewer agent's JSON reply"),
    account: z
      .string()
      .regex(new RegExp(ACCOUNT_ID_PATTERN))
      .optional()
      .describe("The account a hidden job's session ran on; sets the job's account only when it has none"),
  })
  .strict()

export const DisposeInput = z
  .object({
    jobId: z.string().min(1).describe('A job of the finding thread'),
    findingId: z.string().min(1).describe('The finding id'),
    disposition: z.enum(DISPOSITIONS).describe('What happened to the finding'),
    reason: z.string().optional().describe('Why (wrong, intentional, irrelevant)'),
  })
  .strict()

export const FindingRecord = z.object({
  id: z.string(),
  jobId: z.string(),
  lastJobId: z.string(),
  round: z.number().int(),
  tag: z.enum(TAGS),
  class: z.enum(CLASSES),
  file: z.string(),
  line: z.number().int().nullable(),
  message: z.string(),
  failureScenario: z.string(),
  fix: z.string().nullable(),
  disposition: z.enum(DISPOSITIONS),
  reason: z.string().nullable(),
  disposedAt: z.string().nullable(),
})
export type FindingRecordValue = z.output<typeof FindingRecord>

export const StatusInput = z
  .object({
    jobId: z.string().min(1).optional().describe('A job: its state and its thread findings'),
    cwd: CWD.optional().describe('Without a job: the newest jobs of the repo at this path'),
  })
  .strict()

export const JobSummary = z.object({
  id: z.string(),
  state: z.enum(JOB_STATES),
  thread: z.string(),
  round: z.number().int(),
  tier: TIER,
  outcome: z.enum(OUTCOMES).nullable(),
  openImportant: z.number().int().describe('Open important findings of the thread'),
  ageS: z.number().int(),
})

export const StatusOutput = z.object({
  job: z
    .object({
      id: z.string(),
      state: z.enum(JOB_STATES),
      repo: z.string(),
      thread: z.string(),
      round: z.number().int(),
      tier: TIER,
      seat: SEAT.nullable(),
      account: z.string().nullable(),
      transport: z.enum(['in-session', 'hidden']),
      createdAt: z.string(),
      submittedAt: z.string().nullable(),
      jobDir: z.string(),
      worktree: z.string(),
      outcome: z.enum(OUTCOMES).nullable(),
      output: ReviewOutputV4.nullable().describe('REVIEW_OUTPUT v4 once submitted'),
    })
    .optional(),
  findings: z.array(FindingRecord).optional(),
  jobs: z.array(JobSummary).optional(),
})

export const RouteInput = z
  .object({
    cwd: CWD,
    base: z.string().min(1).describe('Base ref'),
    head: z.string().min(1).describe('Head ref'),
    min: RAISE.optional().describe('Raise the tier to at least this one'),
  })
  .strict()

export const RouteOutput = z.object({
  ...DECISION,
  files: z.number().int(),
  codeFiles: z.number().int(),
  codeLines: z.number().int(),
  prodLines: z.number().int(),
  packages: z.array(z.string()),
  config: z.object({ none: z.array(z.string()), sensitive: z.array(z.string()), nits: z.number().int() }),
  changes: z.array(z.object({ path: z.string(), added: z.number().int(), removed: z.number().int() })),
  warning: z.string().optional(),
})

export const CoveredInput = z
  .object({
    cwd: CWD,
    range: z.string().min(1).describe('<a>..<b>: every first-parent commit after a up to b'),
  })
  .strict()

export const CoveredOutput = z.object({
  covered: z.boolean(),
  commits: z.array(
    z.object({
      sha: z.string(),
      subject: z.string(),
      required: TIER,
      rule: z.string(),
      coveredBy: z.string().nullable(),
      /** Set when a job reviewed the commit at its tier but its thread still has open important findings. */
      reason: z.literal('open-important').optional(),
      findings: z.array(z.string()).optional(),
    }),
  ),
  uncovered: z.array(z.string()),
})
export type CoveredOutputValue = z.output<typeof CoveredOutput>

/** A caller's mistake or a refused state: the operations answer it as BAD_REQUEST with this message. */
export class ReviewError extends Error {
  override name = 'ReviewError'
}

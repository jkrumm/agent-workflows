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

const CRITERION_STATUSES = ['met', 'not-met', 'unclear'] as const

/** One acceptance criterion of the brief and what the reviewer found; stored, never gating. */
const Criterion = z.object({
  item: z.string().min(1),
  status: z.enum(CRITERION_STATUSES),
  evidence: z.string().default(''),
})

export const ReviewerReply = z.object({
  intent: z.string().default(''),
  files: z.array(z.string()),
  findings: z.array(ReplyFinding).default([]),
  checked: z.array(z.string()).default([]),
  stepBack: z.string().nullish(),
  criteria: z.array(Criterion).optional(),
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
  lineValid: z.boolean().optional().describe('Code: the line exists in the file (absent: no line, or unknown)'),
  anchored: z.boolean().optional().describe('Code: the line is within 3 lines of a changed line (absent: unknown)'),
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
  criteria: z.array(Criterion).optional().describe("The brief's acceptance criteria, when the reviewer judged them"),
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
    thread: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe(
        'Thread key, or the id of an existing thread of the repo; default pr:<n>, branch:<b> or the base commit',
      ),
    account: z
      .string()
      .regex(new RegExp(ACCOUNT_ID_PATTERN))
      .optional()
      .describe("The caller's Max account: recorded on the job with its quota reading"),
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
  reason: z.string().optional().describe('held (the deep cap) and needs-human: why'),
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
    .enum(['ok', 'unknown', 'unjudged'])
    .optional()
    .describe('The quota reading recorded on the job. ok: a reading; unknown: none; unjudged: no account given'),
  prompt: z.string().optional().describe('The reviewer agent prompt line'),
})
export type PrepareOutputValue = z.output<typeof PrepareOutput>

export const CancelInput = z.object({ jobId: z.string().min(1).describe('A prepared job') }).strict()

export const CancelOutput = z.object({ status: z.literal('cancelled'), jobId: z.string() })

export const SubmitInput = z
  .object({
    jobId: z.string().min(1).describe('The job from prepare'),
    attempt: z.number().int().positive().describe('The reviewer attempt; a submit is idempotent per (job, attempt)'),
    reply: z.string().min(1).describe("The reviewer agent's JSON reply"),
    account: z
      .string()
      .regex(new RegExp(ACCOUNT_ID_PATTERN))
      .optional()
      .describe("The account the reviewer session ran on; sets the job's account only when it has none"),
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
  threadKey: z.string().optional().describe('The key the thread was started with (absent on older jobs)'),
  round: z.number().int(),
  tier: TIER,
  transport: z.enum(['in-session', 'hidden']),
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
      threadKey: z.string().optional().describe('The key the thread was started with (absent on older jobs)'),
      round: z.number().int(),
      tier: TIER,
      seat: SEAT.nullable(),
      account: z.string().nullable(),
      transport: z.enum(['in-session', 'hidden']),
      reviewerPrompt: z.string().nullable().describe('Fingerprint of the reviewer agent file at prepare'),
      verifierPrompt: z.string().nullable().describe('Fingerprint of the review-verifier agent file at prepare'),
      ceiling: z
        .enum(['ok', 'unknown', 'unjudged'])
        .nullable()
        .describe('The quota reading at prepare (null: older job)'),
      quotaFiveHour: z.number().nullable().describe("The account's 5-hour window in percent at prepare"),
      quotaSevenDay: z.number().nullable().describe("The account's 7-day window in percent at prepare"),
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

const STATS_BY = ['tier', 'rule', 'prompt', 'repo'] as const

export const StatsInput = z
  .object({
    since: z.string().optional().describe('ISO datetime: only jobs created at or after it (default: all time)'),
    repo: z.string().min(1).optional().describe('Exact repo id (as `status` prints it)'),
    by: z.enum(STATS_BY).default('tier').describe('Group by tier, normalized rule, reviewer prompt or repo'),
    bucket: z.enum(['week']).optional().describe('ISO week, Monday 00:00 UTC; with --by = one group per week and key'),
  })
  .strict()

const DISPOSITION_COUNTS = z.object({
  open: z.number().int(),
  fixed: z.number().int(),
  wrong: z.number().int(),
  intentional: z.number().int(),
  irrelevant: z.number().int(),
})
const TAG_COUNTS = z.object({ important: z.number().int(), nit: z.number().int(), preExisting: z.number().int() })

const StatsMetrics = z.object({
  jobs: z.number().int().describe('Submitted jobs'),
  abandoned: z.number().int(),
  prepared: z.number().int().describe('In flight'),
  wallS: z.object({ p50: z.number().nullable(), max: z.number().nullable() }).describe('Submitted jobs, seconds'),
  round1: z.object({ jobs: z.number().int(), clean: z.number().int(), cleanRate: z.number().nullable() }),
  findings: TAG_COUNTS.describe('By tag, attributed to the job that first reported them'),
  dispositions: z.object({ important: DISPOSITION_COUNTS, nit: DISPOSITION_COUNTS }),
  precision: z
    .object({ important: z.number().nullable(), nit: z.number().nullable() })
    .describe('fixed / (fixed + wrong + irrelevant)'),
  anchoredShare: z.number().nullable().describe('Of findings with a known value'),
  lineValidShare: z.number().nullable().describe('Of findings with a known value'),
  deepRound2: z.object({ count: z.number().int(), share: z.number().nullable() }),
})
export type StatsMetricsValue = z.output<typeof StatsMetrics>

export const StatsOutput = z.object({
  since: z.string().nullable(),
  by: z.enum(STATS_BY),
  bucket: z.enum(['week']).optional(),
  groups: z.array(StatsMetrics.extend({ key: z.string() })),
  weeks: z
    .array(z.object({ weekStart: z.string(), groups: z.array(StatsMetrics.extend({ key: z.string() })) }))
    .optional()
    .describe('With --bucket week: ascending by weekStart (YYYY-MM-DD, Monday UTC); `groups` is then empty'),
  total: StatsMetrics,
})
export type StatsOutputValue = z.output<typeof StatsOutput>

/** A caller's mistake or a refused state: the operations answer it as BAD_REQUEST with this message. */
export class ReviewError extends Error {
  override name = 'ReviewError'
}

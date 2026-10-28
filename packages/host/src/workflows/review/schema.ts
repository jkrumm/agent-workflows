import { z } from 'zod'

export const REVIEW_DEPTHS = ['light', 'standard', 'deep'] as const
export type ReviewDepth = (typeof REVIEW_DEPTHS)[number]

/** Every angle the caller may ask for. Each is an agent `review-<angle>` under `agents/`. */
export const FLOOR_ANGLES = ['architect', 'senior-dev', 'frontend', 'backend', 'typescript', 'qa'] as const
export const ROUTER_ANGLES = [
  'security',
  'performance',
  'concurrency',
  'data-migration',
  'api-contract',
  'resilience',
] as const
export const ALL_ANGLES = [...FLOOR_ANGLES, ...ROUTER_ANGLES] as const
export type Angle = (typeof ALL_ANGLES)[number]

export const REVIEW_SCHEMA_VERSION = 2

/** A leading `-` would read as a flag once a ref reaches `git` or `fallow`; the rest is git's ref alphabet. */
const SAFE_REF = /^[a-zA-Z0-9._/~^@{}-]+$/
const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/

/** The `review` scope vocabulary: `uncommitted`, `head`, a ref or range, or a file path. Throws a message, never a type. */
export function scopeProblem(scope: string): string | null {
  if (scope === 'uncommitted' || scope === 'head') return null
  const range = splitRange(scope)
  const halves = range ? [range.from, range.to] : [scope]
  if (halves.some((half) => half.startsWith('-'))) return `a ref must not start with '-': ${scope}`
  if (!SAFE_REF.test(scope)) return `scope contains unsafe characters: ${scope}`
  return null
}

export function branchProblem(branch: string): string | null {
  if (!branch) return 'branch must not be empty'
  if (branch.length > 200) return 'branch is longer than 200 characters'
  if (!SAFE_BRANCH.test(branch)) return `branch contains unsafe characters: ${branch}`
  if (branch.includes('..')) return `branch must not contain '..': ${branch}`
  return null
}

/** `a..b` / `a...b` into its halves (either may be empty, as git allows); null for anything that is not a range. */
export function splitRange(scope: string): { from: string; to: string } | null {
  const match = /^(.*?)\.\.\.?(.*)$/.exec(scope)
  if (!match) return null
  return { from: match[1] ?? '', to: match[2] ?? '' }
}

/** A file-path scope rather than a ref or range. A dotted ref such as a `v2.0` tag reads as a path: pass `v2.0..HEAD`. */
export function isPathScope(scope: string): boolean {
  return !scope.includes('..') && (scope.startsWith('/') || scope.includes('.'))
}

export const ReviewInput = z
  .object({
    cwd: z
      .string()
      .refine((cwd) => cwd.startsWith('/'), { message: 'cwd must be an absolute path' })
      .describe('Absolute path to a git work tree to review'),
    scope: z
      .string()
      .optional()
      .describe(
        '"uncommitted" (default): staged and unstaged changes plus untracked files. "head": the last commit. A ref such as "HEAD~3" or a SHA: that ref up to HEAD. A range ("main..HEAD") or a file path also work. Omit it with `pr` or `branch`.',
      ),
    pr: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Pull request number on cwd's origin. Reviewed in a throwaway clone; cwd is never touched."),
    branch: z
      .string()
      .optional()
      .describe("Remote branch on cwd's origin. Reviewed in a throwaway clone; cwd is never touched."),
    depth: z
      .enum(REVIEW_DEPTHS)
      .optional()
      .describe(
        'light (mechanical, docs, test-only), standard (ordinary logic), deep (auth, destructive data ops, concurrency, public contracts). Wins over the router; omit to let it decide.',
      ),
    context: z
      .string()
      .optional()
      .describe('The author\'s stated intent, e.g. "add retry logic"; helps catch goal mismatches'),
    angles: z
      .array(z.string())
      .optional()
      .describe(
        `Force these angles and skip the router (architect and senior-dev always run). Known: ${ALL_ANGLES.join(', ')}`,
      ),
  })
  .strict()
  .superRefine((input, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message })
    if (input.pr !== undefined && input.branch !== undefined) issue('`pr` and `branch` are mutually exclusive')
    if ((input.pr !== undefined || input.branch !== undefined) && input.scope !== undefined) {
      issue('`scope` must be omitted when `pr` or `branch` is set: the diff is always base...head of that ref')
    }
    const problem = input.scope === undefined ? null : scopeProblem(input.scope)
    if (problem) issue(`invalid scope: ${problem}`)
    const branchIssue = input.branch === undefined ? null : branchProblem(input.branch)
    if (branchIssue) issue(`invalid branch: ${branchIssue}`)
  })

export type ReviewInputValue = z.output<typeof ReviewInput>

const Finding = z.object({
  file: z.string().describe('Relative file path from the repo root'),
  line: z.number().optional().describe('Line number, if identifiable'),
  message: z.string().describe('What the issue is, why it matters, and how to fix it'),
  angle: z.string().describe('Which reviewer caught this: an angle name, adversary, fallow, react-doctor or ocr'),
})

export const REVIEW_OUTCOMES = ['clean', 'actionable', 'needs-human'] as const
export const ESCALATION_CATEGORIES = ['product', 'data_loss', 'spend', 'other_people', 'security', 'blocker'] as const

/** What the synthesis agent returns. The verdict's `outcome` is recomputed in code, never taken from it. */
export const SynthesisOutput = z.object({
  outcome: z.enum(REVIEW_OUTCOMES),
  blocking: z.array(Finding),
  improvements: z.array(Finding),
  discussions: z.array(Finding),
  testGaps: z.array(z.string()),
  escalationCategory: z.enum(ESCALATION_CATEGORIES).optional(),
  summary: z.string(),
})
export type Synthesis = z.infer<typeof SynthesisOutput>
export type ReviewFinding = z.infer<typeof Finding>

/** Legacy `REVIEW_OUTPUT` v2, exactly: callers pin `schemaVersion` and refuse a mismatch. */
export const ReviewOutput = SynthesisOutput.extend({ schemaVersion: z.literal(REVIEW_SCHEMA_VERSION) })
export type ReviewResult = z.infer<typeof ReviewOutput>

const AngleFinding = z.object({
  severity: z.enum(['blocking', 'improvement', 'discussion']),
  file: z.string(),
  line: z.number().nullish(),
  message: z.string(),
})
export type AngleFindingValue = z.infer<typeof AngleFinding>

/** What an angle agent returns. */
export const AngleOutput = z.object({ findings: z.array(AngleFinding) })

/** An angle's (or the adversary's) outcome as the journal keeps it: Json-clean, `null` where a field is absent. */
export type AngleResult = {
  angle: string
  findings: {
    severity: 'blocking' | 'improvement' | 'discussion'
    file: string
    line: number | null
    message: string
  }[]
  failureReason: string | null
}

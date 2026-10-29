import { z } from 'zod'
import { type Depth, ReviewOutcome } from '../cases.ts'

/**
 * Everything the harness talks to is a port: the new platform (`agw`), its run journal and the judge. Production adapters live in `adapters/`; tests pass fakes.
 */

const Item = z.object({
  file: z.string(),
  line: z.number().int().nullish(),
  message: z.string(),
  angle: z.string(),
})

/** agent-gateway's `REVIEW_OUTPUT` v2, which the new `review` keeps. Loose: extra keys are ignored. */
export const ReviewOutput = z.object({
  schemaVersion: z.literal(2),
  outcome: ReviewOutcome,
  blocking: z.array(Item),
  improvements: z.array(Item),
  discussions: z.array(Item),
  testGaps: z.array(z.string()),
  escalationCategory: z.string().nullish(),
  summary: z.string(),
})
export type ReviewOutput = z.infer<typeof ReviewOutput>

export const CheckOutput = z.object({
  passed: z.boolean(),
  steps: z.array(z.object({ name: z.string(), passed: z.boolean(), errors: z.array(z.string()).optional() })),
  summary: z.string(),
})
export type CheckOutput = z.infer<typeof CheckOutput>

/** What one run cost; `costExact` is `false` when part of it was matched by time window or left unpriced. */
export interface Spend {
  costUsd: number | null
  costExact: boolean
  wallMs: number | null
}

export interface ReviewRequest {
  cwd: string
  /** Omitted: the router picks the depth. */
  depth?: z.infer<typeof Depth>
  context?: string
}

export interface ReviewRun {
  output: ReviewOutput
  spend: Spend
  /** The new platform's run id. */
  runId?: string
}

export interface ReviewRunner {
  review(request: ReviewRequest): Promise<ReviewRun>
}

export interface CheckRequest {
  cwd: string
  commands?: string[]
}

export interface CheckRun {
  output: CheckOutput
  spend: Spend
  runId?: string
}

export interface CheckRunner {
  check(request: CheckRequest): Promise<CheckRun>
}

/** A finding as the matcher sees it: where, and what it says. */
export interface Located {
  file: string
  line?: number | null
  message: string
}

/** Decides whether two findings name the same defect; the diff is all it may read. Blinded: no side labels. */
export interface Judge {
  sameDefect(pair: { a: Located; b: Located; diff: string }): Promise<boolean>
}

/** The new platform's journal row for a run (`"$AGW_PG_SCHEMA".runs`), read-only. */
export interface RunCost {
  costUsd: number | null
  wallMs: number | null
  tokensInput: number
  tokensOutput: number
  tokensCacheRead: number
  unpricedCalls: number
}

export interface RunJournal {
  /** `null` while the row is missing or the run has not ended. */
  runCost(runId: string): Promise<RunCost | null>
}

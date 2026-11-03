// What every review command runs on, built once by `createReviewService`.
import { join } from 'node:path'
import type { Exec } from '../process.ts'
import type { ReviewPorts } from './clone.ts'
import type { ReviewLedger } from './ledger.ts'
import type { GitRunner } from './route.ts'

export type QuotaReading = { fiveHour: number | null; sevenDay: number | null }

export interface ReviewContext {
  ledger: ReviewLedger
  git: GitRunner
  /** For the git calls that need an environment (the snapshot's temporary index, the worktree clone). */
  exec: Exec
  /** The clone helpers (pr/branch) run on these. */
  clonePorts: ReviewPorts
  stateDir: string
  quota?: (account: string) => Promise<QuotaReading | null>
  now: () => Date
  env: Record<string, string | undefined>
}

export const JOBS_DIR = 'review-jobs'
export const jobsRoot = (ctx: Pick<ReviewContext, 'stateDir'>) => join(ctx.stateDir, JOBS_DIR)

// Review v4, agw's side: prepare | submit | dispose | status | route | covered | stats over the review ledger. No LLM call
// anywhere here; the reviewer agent runs in the caller's session. README.md.
import { createExec } from '../process.ts'
import type { ReviewContext, QuotaReading } from './context.ts'
import { covered } from './covered.ts'
import { findingRecord, type ReviewPool, reviewLedger } from './ledger.ts'
import { prepare, removeWorktree } from './prepare.ts'
import { repoIdentity, resolveRoot } from './repo.ts'
import { type GitRunner, routeRange } from './route.ts'
import { type FindingRecordValue, ReviewError, type ReviewOutputV4Value } from './schema.ts'
import { computeStats } from './stats.ts'
import { submit } from './submit.ts'
import type { z } from 'zod'
import type {
  CancelInput,
  CancelOutput,
  CoveredOutput,
  DisposeInput,
  PrepareInput,
  PrepareOutput,
  RouteInput,
  RouteOutput,
  StatusInput,
  StatsInput,
  StatsOutput,
  StatusOutput,
} from './schema.ts'

export { reviewOperations } from './operations.ts'
export { ReviewError } from './schema.ts'
export type { QuotaReading } from './context.ts'

export interface ReviewServicePorts {
  pool: ReviewPool
  schema: string
  /** Job dirs live under `<stateDir>/review-jobs/`, pr/branch clones under `<stateDir>/review-clones/`. */
  stateDir: string
  git: GitRunner
  /** The account's Max quota in percent; absent or null: the ceiling is `unknown`. Recorded on the job, never a hold. */
  quota?: (account: string) => Promise<QuotaReading | null>
  now?: () => Date
  /** The process environment: helper allowlist, network vars for pr/branch fetches, `AGW_REVIEW_DEEP_CAP`. */
  env?: Record<string, string | undefined>
}

export interface ReviewService {
  prepare(input: z.output<typeof PrepareInput>): Promise<z.output<typeof PrepareOutput>>
  cancel(input: z.output<typeof CancelInput>): Promise<z.output<typeof CancelOutput>>
  submit(input: { jobId: string; attempt: number; reply: string; account?: string }): Promise<ReviewOutputV4Value>
  dispose(input: z.output<typeof DisposeInput>): Promise<FindingRecordValue>
  status(input: z.output<typeof StatusInput>): Promise<z.output<typeof StatusOutput>>
  route(input: z.output<typeof RouteInput>): Promise<z.output<typeof RouteOutput>>
  covered(input: { cwd: string; range: string }): Promise<z.output<typeof CoveredOutput>>
  stats(input: z.input<typeof StatsInput>): Promise<z.output<typeof StatsOutput>>
}

const RECENT_JOBS = 10

const threadKeyOf = (job: { scope: Record<string, unknown> }) =>
  typeof job.scope.threadKey === 'string' ? { threadKey: job.scope.threadKey } : {}

export function createReviewService(ports: ReviewServicePorts): ReviewService {
  const env = ports.env ?? process.env
  const now = ports.now ?? (() => new Date())
  const exec = createExec(env)
  const ctx: ReviewContext = {
    ledger: reviewLedger(ports.pool, ports.schema),
    git: ports.git,
    exec,
    clonePorts: { exec, env, stateDir: ports.stateDir, now: () => now().getTime() },
    stateDir: ports.stateDir,
    quota: ports.quota,
    now,
    env,
  }
  const { ledger } = ctx
  const abandonJob = async (job: { id: string; jobDir: string; worktree: string }) => {
    await ledger.abandon(job.id)
    if (job.jobDir && job.worktree) removeWorktree(ctx, job.jobDir, job.worktree)
  }

  return {
    prepare: (input) => prepare(ctx, input),

    async cancel(input) {
      const job = await ledger.job(input.jobId)
      if (!job) throw new ReviewError(`unknown job ${input.jobId}`)
      if (job.state !== 'prepared')
        throw new ReviewError(`job ${job.id} is ${job.state}, only a prepared job can be cancelled`)
      await abandonJob(job)
      return { status: 'cancelled', jobId: job.id }
    },
    submit: (input) => submit(ctx, input),
    covered: (input) => covered(ctx, input),

    async dispose(input) {
      const job = await ledger.job(input.jobId)
      if (!job) throw new ReviewError(`unknown job ${input.jobId}`)
      const finding = await ledger.finding(input.findingId)
      if (!finding || finding.repo !== job.repo || finding.thread !== job.thread) {
        throw new ReviewError(`finding ${input.findingId} is not in the thread of job ${input.jobId}`)
      }
      return findingRecord(await ledger.dispose(finding.id, input.disposition, input.reason ?? null, now()))
    },

    async status(input) {
      if (input.jobId) {
        const job = await ledger.job(input.jobId)
        if (!job) throw new ReviewError(`unknown job ${input.jobId}`)
        const findings = await ledger.threadFindings(job.repo, job.thread)
        return {
          job: {
            id: job.id,
            state: job.state,
            repo: job.repo,
            thread: job.thread,
            ...threadKeyOf(job),
            round: job.round,
            tier: job.tier,
            seat: job.seat,
            account: job.account,
            transport: job.transport,
            reviewerPrompt: job.reviewerPrompt,
            verifierPrompt: job.verifierPrompt,
            ceiling: job.ceiling,
            quotaFiveHour: job.quotaFiveHour,
            quotaSevenDay: job.quotaSevenDay,
            createdAt: job.createdAt.toISOString(),
            submittedAt: job.submittedAt?.toISOString() ?? null,
            jobDir: job.jobDir,
            worktree: job.worktree,
            outcome: job.output?.outcome ?? null,
            output: job.output,
          },
          findings: findings.map(findingRecord),
        }
      }
      if (!input.cwd) throw new ReviewError('give a job id or --cwd')
      const repo = await repoIdentity(ports.git, await resolveRoot(ports.git, input.cwd))
      const at = now().getTime()
      const jobs = await ledger.recentJobs(repo, RECENT_JOBS)
      return {
        jobs: jobs.map((j) => ({
          id: j.id,
          state: j.state,
          thread: j.thread,
          ...threadKeyOf(j),
          round: j.round,
          tier: j.tier,
          transport: j.transport,
          outcome: j.output?.outcome ?? null,
          openImportant: j.openImportant,
          ageS: Math.max(0, Math.round((at - j.createdAt.getTime()) / 1000)),
        })),
      }
    },

    async stats(input) {
      const since = input.since === undefined ? null : new Date(input.since)
      if (since !== null && Number.isNaN(since.getTime())) {
        throw new ReviewError(`since must be an ISO datetime, got "${input.since}"`)
      }
      const rows = await ledger.statsRows({ since, repo: input.repo ?? null })
      return computeStats({ ...rows, by: input.by ?? 'tier', since: since?.toISOString() ?? null })
    },

    async route(input) {
      for (const ref of [input.base, input.head]) {
        if (ref.startsWith('-')) throw new ReviewError(`a ref must not start with '-': ${ref}`)
      }
      const root = await resolveRoot(ports.git, input.cwd)
      try {
        return await routeRange({ git: ports.git, repo: root, base: input.base, head: input.head, min: input.min })
      } catch (error) {
        throw new ReviewError(error instanceof Error ? error.message : String(error))
      }
    },
  }
}

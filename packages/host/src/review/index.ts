// Review v4, agw's side: prepare | submit | dispose | status | route | covered | stats over the review ledger. No LLM call
// anywhere here; the reviewer agent runs in the caller's session. README.md.
import { createExec } from '../process.ts'
import { parseSince, SINCE_HINT } from '../since.ts'
import type { ReviewContext, QuotaReading } from './context.ts'
import { covered } from './covered.ts'
import { findingRecord, type ReviewPool, reviewLedger } from './ledger.ts'
import { prepare, removeWorktree } from './prepare.ts'
import { repoIdentity, resolveRoot } from './repo.ts'
import { type GitRunner, routeRange } from './route.ts'
import { DISPOSITIONS, type FindingRecordValue, ReviewError, type ReviewOutputV4Value } from './schema.ts'
import { computeStats } from './stats.ts'
import { submit } from './submit.ts'
import type { z } from 'zod'
import type {
  CancelInput,
  CancelOutput,
  CoveredOutput,
  DisposeInput,
  DisposeOutput,
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
  dispose(input: z.output<typeof DisposeInput>): Promise<z.output<typeof DisposeOutput>>
  status(input: z.output<typeof StatusInput>): Promise<z.output<typeof StatusOutput>>
  route(input: z.output<typeof RouteInput>): Promise<z.output<typeof RouteOutput>>
  covered(input: { cwd: string; range: string }): Promise<z.output<typeof CoveredOutput>>
  stats(input: z.input<typeof StatsInput>): Promise<z.output<typeof StatsOutput>>
}

const RECENT_JOBS = 10
/** A thread whose fix loop stopped is named for this long, newest first, so an old branch does not crowd it. */
const STALLED_DAYS = 14
const STALLED_LIMIT = 10

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
    async submit(input) {
      return submit(ctx, input)
    },
    covered: (input) => covered(ctx, input),

    async dispose(input) {
      const job = await ledger.job(input.jobId)
      if (!job) throw new ReviewError(`unknown job ${input.jobId}`)
      const reason = input.reason ?? null
      if (input.allOpen !== undefined) {
        if (input.findingId !== undefined || input.disposition !== undefined) {
          throw new ReviewError('give finding ids and a disposition, or --all-open <disposition>, not both')
        }
        if (input.allOpen === 'open') throw new ReviewError('--all-open open changes nothing: the findings are open')
        const open = (await ledger.threadFindings(job.repo, job.thread)).filter((f) => f.disposition === 'open')
        const disposed = await ledger.disposeMany(
          open.map((f) => f.id),
          input.allOpen,
          reason,
          now(),
        )
        return { disposed: disposed.map(findingRecord) }
      }
      if (input.findingId === undefined || input.disposition === undefined) {
        throw new ReviewError(
          `give <findingId>[,<findingId>...] and a disposition (${DISPOSITIONS.join('|')}), or --all-open <disposition>`,
        )
      }
      const ids = [
        ...new Set(
          input.findingId
            .split(',')
            .map((id) => id.trim())
            .filter(Boolean),
        ),
      ]
      if (ids.length === 0) throw new ReviewError('no finding id given')
      const found = await Promise.all(ids.map((id) => ledger.finding(id)))
      ids.forEach((id, i) => {
        const finding = found[i]
        if (!finding || finding.repo !== job.repo || finding.thread !== job.thread) {
          throw new ReviewError(`finding ${id} is not in the thread of job ${input.jobId}`)
        }
      })
      const disposed = (await ledger.disposeMany(ids, input.disposition, reason, now())).map(findingRecord)
      return ids.length === 1 && !input.findingId.includes(',') ? (disposed[0] as FindingRecordValue) : { disposed }
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
      const [jobs, stalled] = await Promise.all([
        ledger.recentJobs(repo, RECENT_JOBS),
        ledger.stalledThreads(repo, new Date(at - STALLED_DAYS * 86_400_000), STALLED_LIMIT),
      ])
      return {
        stalled: stalled.map((j) => ({
          thread: j.thread,
          ...threadKeyOf(j),
          jobId: j.id,
          round: j.round,
          tier: j.tier,
          openImportant: j.openImportant,
          ageS: Math.max(0, Math.round((at - (j.submittedAt ?? j.createdAt).getTime()) / 1000)),
        })),
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
      const since = input.since === undefined ? null : parseSince(input.since, now().getTime())
      if (input.since !== undefined && since === null) {
        throw new ReviewError(`since must be ${SINCE_HINT}, got "${input.since}"`)
      }
      const rows = await ledger.statsRows({ since, repo: input.repo ?? null })
      return computeStats({
        ...rows,
        by: input.by ?? 'tier',
        bucket: input.bucket,
        since: since?.toISOString() ?? null,
      })
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

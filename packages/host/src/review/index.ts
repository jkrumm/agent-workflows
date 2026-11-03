// Review v4, agw's side: prepare | submit | dispose | status | route | covered over the review ledger. No LLM call
// anywhere here; the reviewer agent runs in the caller's session (or a factory session on the hidden transport). README.md.
import { commandRunner, fleetConfig, type RunCommand } from '../fleet/factory.ts'
import { createExec } from '../process.ts'
import type { ReviewContext, QuotaReading } from './context.ts'
import { covered } from './covered.ts'
import { findingRecord, type ReviewPool, reviewLedger } from './ledger.ts'
import { prepare, removeWorktree } from './prepare.ts'
import { repoIdentity, resolveRoot } from './repo.ts'
import { type GitRunner, routeRange } from './route.ts'
import { type FindingRecordValue, ReviewError, type ReviewOutputV4Value } from './schema.ts'
import { submit } from './submit.ts'
import type { z } from 'zod'
import type {
  CancelInput,
  CancelOutput,
  CoveredOutput,
  DisposeInput,
  PrepareInput,
  PrepareOutput,
  RequestInput,
  RequestOutput,
  RouteInput,
  RouteOutput,
  StatusInput,
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
  /** The account's Max quota in percent; absent or null: the ceiling is `unknown`, never held. */
  quota?: (account: string) => Promise<QuotaReading | null>
  now?: () => Date
  /** The process environment: helper allowlist, network vars for pr/branch fetches, `AGW_REVIEW_DEEP_CAP`. */
  env?: Record<string, string | undefined>
  /** Runs the factory CLI for `request` (tests); default: a bounded child with `FACTORY_TOKEN`/`FACTORY_URL` passed on. */
  run?: RunCommand
}

export interface ReviewService {
  prepare(input: z.output<typeof PrepareInput>): Promise<z.output<typeof PrepareOutput>>
  request(input: z.output<typeof RequestInput>): Promise<z.output<typeof RequestOutput>>
  cancel(input: z.output<typeof CancelInput>): Promise<z.output<typeof CancelOutput>>
  submit(input: { jobId: string; attempt: number; reply: string; account?: string }): Promise<ReviewOutputV4Value>
  dispose(input: z.output<typeof DisposeInput>): Promise<FindingRecordValue>
  status(input: z.output<typeof StatusInput>): Promise<z.output<typeof StatusOutput>>
  route(input: z.output<typeof RouteInput>): Promise<z.output<typeof RouteOutput>>
  covered(input: { cwd: string; range: string }): Promise<z.output<typeof CoveredOutput>>
}

const RECENT_JOBS = 10
const SPAWN_TIMEOUT_MS = 60_000
/** The factory CLI's exit codes: 4 not_found, 5 conflict (`spawn cancel` on a claimed or started spawn). */
const FACTORY_NOT_FOUND = 4
const FACTORY_CONFLICT = 5

/** The factory's answer to `spawn create`: its JSON, else the first line it printed. */
const parseSpawn = (stdout: string): unknown => {
  try {
    return JSON.parse(stdout)
  } catch {
    return stdout.trim().split('\n')[0] ?? ''
  }
}

/** `FACTORY_TOKEN`/`FACTORY_URL` pass through to the factory CLI. */
const factoryEnv = (env: Record<string, string | undefined>): Record<string, string> => {
  const extraEnv: Record<string, string> = {}
  for (const name of ['FACTORY_TOKEN', 'FACTORY_URL']) {
    const value = env[name]
    if (value) extraEnv[name] = value
  }
  return extraEnv
}

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
  const run = ports.run ?? commandRunner(env)

  return {
    prepare: (input) => prepare(ctx, input),

    async request(input) {
      const prepared = await prepare(ctx, input, 'hidden')
      if (prepared.status !== 'ready') return { ...prepared, status: prepared.status as 'skipped' | 'needs-human' }
      const { jobId, tier, seat, jobDir, worktree } = prepared
      if (!jobId || !tier || !jobDir || !worktree) throw new Error('prepare answered ready without a job')
      const job = await ledger.job(jobId)
      if (!job) throw new Error(`job ${jobId} vanished after prepare`)
      const spawnKey = `review-${jobId}-a1`
      const result = await run(
        [
          fleetConfig(env).factoryBin,
          'spawn',
          'create',
          spawnKey,
          '--repo',
          job.root,
          '--role',
          'reviewer',
          '--placement',
          'hidden',
          '--review-job',
          jobId,
          '--review-tier',
          tier,
          ...(seat ? ['--effort', seat.effort] : []),
          '--prompt',
          prepared.prompt ?? '',
          '--format',
          'json',
        ],
        { timeoutMs: SPAWN_TIMEOUT_MS, extraEnv: factoryEnv(env) },
      )
      if (result.exitCode !== 0) {
        await ledger.abandon(jobId)
        removeWorktree(ctx, jobDir, worktree)
        const why = result.timedOut
          ? `timed out after ${SPAWN_TIMEOUT_MS / 1000} s`
          : (result.stderr.trim() || result.stdout.trim() || result.error || `exit ${result.exitCode}`).split('\n')[0]
        throw new ReviewError(`the factory could not start the review session ${spawnKey}: ${why}`)
      }
      return {
        status: 'requested',
        jobId,
        thread: prepared.thread,
        round: prepared.round,
        base: prepared.base,
        head: prepared.head,
        account: null,
        tier,
        seat,
        ceiling: 'factory',
        spawnKey,
        spawn: parseSpawn(result.stdout),
      }
    },

    async cancel(input) {
      const job = await ledger.job(input.jobId)
      if (!job) throw new ReviewError(`unknown job ${input.jobId}`)
      if (job.state !== 'prepared')
        throw new ReviewError(`job ${job.id} is ${job.state}, only a prepared job can be cancelled`)
      if (job.transport !== 'hidden')
        throw new ReviewError(`job ${job.id} is an in-session job, only a hidden one can be cancelled`)
      const spawns: unknown[] = []
      let failedSpawn: unknown
      // a1 is the first spawn, a2 the factory's retry; a key that never existed answers not_found (exit 4)
      for (const attempt of [1, 2]) {
        const spawnKey = `review-${job.id}-a${attempt}`
        const result = await run([fleetConfig(env).factoryBin, 'spawn', 'cancel', spawnKey, '--format', 'json'], {
          timeoutMs: SPAWN_TIMEOUT_MS,
          extraEnv: factoryEnv(env),
        })
        const spawn = parseSpawn(result.stdout)
        if (result.exitCode === 0) spawns.push(spawn)
        else if (result.exitCode === FACTORY_CONFLICT) {
          // a spawn that ended `failed` (409 "spawn <key> is failed") cannot run any more; a1 failed hands over to a2
          if (!/ is failed:/.test(`${result.stderr}\n${result.stdout}`))
            return { status: 'running', jobId: job.id, spawn }
          failedSpawn = spawn
        } else if (result.exitCode !== FACTORY_NOT_FOUND) {
          const why = result.timedOut
            ? `timed out after ${SPAWN_TIMEOUT_MS / 1000} s`
            : (result.stderr.trim() || result.stdout.trim() || result.error || `exit ${result.exitCode}`).split('\n')[0]
          throw new ReviewError(`the factory could not cancel ${spawnKey}: ${why}`)
        }
      }
      await ledger.abandon(job.id)
      if (job.jobDir && job.worktree) removeWorktree(ctx, job.jobDir, job.worktree)
      if (spawns.length === 0 && failedSpawn !== undefined)
        return { status: 'failed', jobId: job.id, spawn: failedSpawn }
      return { status: 'cancelled', jobId: job.id, spawns }
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
            round: job.round,
            tier: job.tier,
            seat: job.seat,
            account: job.account,
            transport: job.transport,
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
          round: j.round,
          tier: j.tier,
          outcome: j.output?.outcome ?? null,
          openImportant: j.openImportant,
          ageS: Math.max(0, Math.round((at - j.createdAt.getTime()) / 1000)),
        })),
      }
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

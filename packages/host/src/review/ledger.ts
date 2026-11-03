// The review ledger (`review_jobs`, `review_findings`, migration 0017): the only SQL of review v4.
import type { Pool, PoolClient } from 'pg'
import type { RouteDecision, Seat, Tier } from './route.ts'
import type { Disposition, FindingClass, FindingRecordValue, ReviewOutputV4Value, Tag } from './schema.ts'

export type ReviewPool = Pick<Pool, 'query' | 'connect'>
type Query = Pick<PoolClient, 'query'>

export type JobState = 'prepared' | 'submitted' | 'abandoned'

export interface Job {
  id: string
  repo: string
  root: string
  thread: string
  round: number
  scope: Record<string, unknown>
  base: string
  diffBase: string
  head: string
  headTree: string
  tier: Tier
  seat: Seat | null
  rule: string
  decidedBy: RouteDecision['decidedBy']
  route: Record<string, unknown>
  account: string | null
  intent: string
  reviewConfig: { none: string[]; sensitive: string[]; nits: number }
  files: string[]
  jobDir: string
  worktree: string
  state: JobState
  attempt: number | null
  output: ReviewOutputV4Value | null
  createdAt: Date
  submittedAt: Date | null
}

export interface Finding {
  id: string
  repo: string
  thread: string
  jobId: string
  lastJobId: string
  round: number
  tag: Tag
  class: FindingClass
  file: string
  line: number | null
  existing: string | null
  message: string
  failureScenario: string
  fix: string | null
  otherInstances: string[]
  votes: string | null
  disposition: Disposition
  reason: string | null
  disposedAt: Date | null
  createdAt: Date
}

type Row = Record<string, unknown>

const toJob = (r: Row): Job => ({
  id: r.id as string,
  repo: r.repo as string,
  root: r.root as string,
  thread: r.thread as string,
  round: r.round as number,
  scope: r.scope as Record<string, unknown>,
  base: r.base as string,
  diffBase: r.diff_base as string,
  head: r.head as string,
  headTree: r.head_tree as string,
  tier: r.tier as Tier,
  seat: (r.seat as Seat | null) ?? null,
  rule: r.rule as string,
  decidedBy: r.decided_by as Job['decidedBy'],
  route: r.route as Record<string, unknown>,
  account: (r.account as string | null) ?? null,
  intent: r.intent as string,
  reviewConfig: r.review_config as Job['reviewConfig'],
  files: r.files as string[],
  jobDir: r.job_dir as string,
  worktree: r.worktree as string,
  state: r.state as JobState,
  attempt: (r.attempt as number | null) ?? null,
  output: (r.output as ReviewOutputV4Value | null) ?? null,
  createdAt: r.created_at as Date,
  submittedAt: (r.submitted_at as Date | null) ?? null,
})

const toFinding = (r: Row): Finding => ({
  id: r.id as string,
  repo: r.repo as string,
  thread: r.thread as string,
  jobId: r.job_id as string,
  lastJobId: r.last_job_id as string,
  round: r.round as number,
  tag: r.tag as Tag,
  class: r.class as FindingClass,
  file: r.file as string,
  line: (r.line as number | null) ?? null,
  existing: (r.existing as string | null) ?? null,
  message: r.message as string,
  failureScenario: r.failure_scenario as string,
  fix: (r.fix as string | null) ?? null,
  otherInstances: (r.other_instances as string[] | null) ?? [],
  votes: (r.votes as string | null) ?? null,
  disposition: r.disposition as Disposition,
  reason: (r.reason as string | null) ?? null,
  disposedAt: (r.disposed_at as Date | null) ?? null,
  createdAt: r.created_at as Date,
})

/** The wire shape of a finding with its disposition (status, dispose). */
export const findingRecord = (f: Finding): FindingRecordValue => ({
  id: f.id,
  jobId: f.jobId,
  lastJobId: f.lastJobId,
  round: f.round,
  tag: f.tag,
  class: f.class,
  file: f.file,
  line: f.line,
  message: f.message,
  failureScenario: f.failureScenario,
  fix: f.fix,
  disposition: f.disposition,
  reason: f.reason,
  disposedAt: f.disposedAt?.toISOString() ?? null,
})

export type NewJob = Omit<Job, 'state' | 'attempt' | 'output' | 'createdAt' | 'submittedAt'>
export type NewFinding = Omit<Finding, 'disposition' | 'reason' | 'disposedAt' | 'createdAt'>

export function reviewLedger(pool: ReviewPool, schema: string) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error(`invalid schema name "${schema}"`)
  const jobs = `"${schema}".review_jobs`
  const findings = `"${schema}".review_findings`
  const lockThread = (q: Query, thread: string) =>
    q.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [`agw-review-thread:${thread}`])

  async function transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect()
    try {
      await client.query('begin')
      const result = await work(client)
      await client.query('commit')
      return result
    } catch (error) {
      await client.query('rollback').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }

  return {
    transaction,

    async job(id: string, q: Query = pool, forUpdate = false): Promise<Job | null> {
      const { rows } = await q.query(`select * from ${jobs} where id = $1${forUpdate ? ' for update' : ''}`, [id])
      return rows[0] ? toJob(rows[0]) : null
    },

    async lastSubmitted(repo: string, thread: string): Promise<Job | null> {
      const { rows } = await pool.query(
        `select * from ${jobs} where repo = $1 and thread = $2 and state = 'submitted'
          order by round desc, submitted_at desc limit 1`,
        [repo, thread],
      )
      return rows[0] ? toJob(rows[0]) : null
    },

    /** Deep jobs of `account` (null: its own bucket) since `since`, not abandoned, other threads' prepared ones included. */
    async deepCount(account: string | null, since: Date, exceptPreparedOf: string): Promise<number> {
      const { rows } = await pool.query(
        `select count(*)::int as n from ${jobs}
          where account is not distinct from $1 and tier = 'deep' and created_at >= $2 and state <> 'abandoned'
            and not (state = 'prepared' and thread = $3)`,
        [account, since, exceptPreparedOf],
      )
      return rows[0].n as number
    },

    /** Abandons the thread's unsubmitted jobs (a re-prepare restarts the round) and inserts the new one. */
    async insertJob(job: NewJob): Promise<string[]> {
      return transaction(async (client) => {
        await lockThread(client, job.thread)
        const { rows } = await client.query(
          `update ${jobs} set state = 'abandoned' where repo = $1 and thread = $2 and state = 'prepared' returning id`,
          [job.repo, job.thread],
        )
        await client.query(
          `insert into ${jobs} (id, repo, root, thread, round, scope, base, diff_base, head, head_tree, tier, seat, rule,
             decided_by, route, account, intent, review_config, files, job_dir, worktree)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)`,
          [
            job.id,
            job.repo,
            job.root,
            job.thread,
            job.round,
            JSON.stringify(job.scope),
            job.base,
            job.diffBase,
            job.head,
            job.headTree,
            job.tier,
            job.seat === null ? null : JSON.stringify(job.seat),
            job.rule,
            job.decidedBy,
            JSON.stringify(job.route),
            job.account,
            job.intent,
            JSON.stringify(job.reviewConfig),
            JSON.stringify(job.files),
            job.jobDir,
            job.worktree,
          ],
        )
        return rows.map((r) => r.id as string)
      })
    },

    /** Findings in `repo` on any of `paths`, newest first. */
    async findingsOn(repo: string, paths: string[], limit: number): Promise<Finding[]> {
      if (paths.length === 0) return []
      const { rows } = await pool.query(
        `select * from ${findings} where repo = $1 and file = any($2::text[]) order by created_at desc, id desc limit $3`,
        [repo, paths, limit],
      )
      return rows.map(toFinding)
    },

    async threadFindings(repo: string, thread: string, q: Query = pool): Promise<Finding[]> {
      const { rows } = await q.query(
        `select * from ${findings} where repo = $1 and thread = $2 order by created_at, id`,
        [repo, thread],
      )
      return rows.map(toFinding)
    },

    lockThread,

    async insertFinding(q: Query, f: NewFinding): Promise<void> {
      await q.query(
        `insert into ${findings} (id, repo, thread, job_id, last_job_id, round, tag, class, file, line, existing, message,
           failure_scenario, fix, other_instances, votes)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [
          f.id,
          f.repo,
          f.thread,
          f.jobId,
          f.lastJobId,
          f.round,
          f.tag,
          f.class,
          f.file,
          f.line,
          f.existing,
          f.message,
          f.failureScenario,
          f.fix,
          JSON.stringify(f.otherInstances),
          f.votes,
        ],
      )
    },

    /** A round reported the finding again; `reopen` also puts a `fixed` one back to `open`. */
    async touchFinding(q: Query, id: string, jobId: string, reopen = false): Promise<void> {
      if (!reopen) {
        await q.query(`update ${findings} set last_job_id = $2 where id = $1`, [id, jobId])
        return
      }
      await q.query(
        `update ${findings} set last_job_id = $2, disposition = 'open', reason = $3, disposed_at = null where id = $1`,
        [id, jobId, `reopened by ${jobId}`],
      )
    },

    async markSubmitted(q: Query, id: string, attempt: number, output: ReviewOutputV4Value, at: Date): Promise<void> {
      await q.query(
        `update ${jobs} set state = 'submitted', attempt = $2, output = $3, submitted_at = $4 where id = $1`,
        [id, attempt, JSON.stringify(output), at],
      )
    },

    async finding(id: string): Promise<Finding | null> {
      const { rows } = await pool.query(`select * from ${findings} where id = $1`, [id])
      return rows[0] ? toFinding(rows[0]) : null
    },

    /** Sets the disposition; a repeat with the same disposition and reason changes nothing. */
    async dispose(id: string, disposition: Disposition, reason: string | null, at: Date): Promise<Finding> {
      const { rows } = await pool.query(
        `update ${findings} set disposition = $2, reason = $3, disposed_at = $4
          where id = $1 and (disposition <> $2 or reason is distinct from $3) returning *`,
        [id, disposition, reason, at],
      )
      if (rows[0]) return toFinding(rows[0])
      const unchanged = await pool.query(`select * from ${findings} where id = $1`, [id])
      return toFinding(unchanged.rows[0])
    },

    /** The newest jobs of `repo`, with the thread's open important findings. */
    async recentJobs(repo: string, limit: number): Promise<(Job & { openImportant: number })[]> {
      const { rows } = await pool.query(
        `select j.*, (select count(*)::int from ${findings} f
                       where f.repo = j.repo and f.thread = j.thread and f.tag = 'important' and f.disposition = 'open')
                     as open_important
           from ${jobs} j where j.repo = $1 order by j.created_at desc, j.id desc limit $2`,
        [repo, limit],
      )
      return rows.map((r) => ({ ...toJob(r), openImportant: r.open_important as number }))
    },

    async submittedSince(repo: string, since: Date): Promise<Job[]> {
      const { rows } = await pool.query(
        `select * from ${jobs} where repo = $1 and state = 'submitted' and created_at >= $2 order by created_at`,
        [repo, since],
      )
      return rows.map(toJob)
    },

    /** The ids of the open important findings of these threads, by thread. */
    async openImportant(repo: string, threads: string[]): Promise<Map<string, string[]>> {
      const open = new Map<string, string[]>()
      if (threads.length === 0) return open
      const { rows } = await pool.query(
        `select thread, id from ${findings}
          where repo = $1 and thread = any($2::text[]) and tag = 'important' and disposition = 'open' order by id`,
        [repo, threads],
      )
      for (const r of rows as { thread: string; id: string }[])
        open.set(r.thread, [...(open.get(r.thread) ?? []), r.id])
      return open
    },

    /** Every submitted (thread, round, tier) of these threads: a thread's cover tier is the max up to a round. */
    async threadTiers(repo: string, threads: string[]): Promise<{ thread: string; round: number; tier: Tier }[]> {
      if (threads.length === 0) return []
      const { rows } = await pool.query(
        `select thread, round, tier from ${jobs} where repo = $1 and state = 'submitted' and thread = any($2::text[])`,
        [repo, threads],
      )
      return rows as { thread: string; round: number; tier: Tier }[]
    },
  }
}

export type ReviewLedger = ReturnType<typeof reviewLedger>

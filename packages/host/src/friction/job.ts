import { FRICTION_COUNTERS, type FrictionCounter, type JournalDb } from '@agent-workflows/middleware'
import type { Logger } from '@agent-workflows/runtime'
import { type GhPort, issueNumber } from './gh.ts'
import type { FrictionSettings } from './settings.ts'

/** Run ids listed per issue; the counts above them cover the rest. */
const EVIDENCE_RUNS = 20

export type WorkflowFriction = {
  workflow: string
  runs: number
  /** Runs with any counter at or above its limit. */
  withFriction: number
  rate: number
  /** Per counter: runs at or above its limit, and the counter summed over the runs looked at. */
  counters: Record<FrictionCounter, { runs: number; sum: number }>
  /** Newest first, at most `EVIDENCE_RUNS`. */
  runIds: string[]
  /** Set when only runs that finished after the previous issue was closed were looked at. */
  since?: string
}

export type JobResult = {
  followUps: number
  /** Runs whose counters were recounted because an earlier count was incomplete. */
  recounted: number
  workflows: WorkflowFriction[]
  issues: { workflow: string; title: string; url?: string; existing?: true }[]
}

type Deps = {
  db: Pick<JournalDb, 'pool' | 'runs'>
  settings: FrictionSettings
  gh: GhPort
  logger: Logger
  now?: () => Date
  /** Aborts the database and `gh` calls: shutdown and a deploy rollback never wait for a job. */
  signal?: AbortSignal
  /** Recounts one run's friction from the agent host (`frictionRecounter`); without it incomplete runs stay as they are. */
  recount?: (runId: string, options?: { retry?: boolean }) => Promise<void>
}

/** An intent row younger than this belongs to a tick that is still filing; only an older one is a crash to resolve. */
const INTENT_GRACE_MS = 5 * 60_000

/** Incomplete runs recounted per job run: a restart of the agent server must not turn one tick into a flood of reads. */
export const RECOUNT_CAP = 20

/** The stable title of a workflow's friction issue. */
export const issueTitle = (workflow: string) => `Friction: ${workflow} above threshold`

/**
 * The purpose a user's own call carries (`DEFAULT_PURPOSE` of the HTTP door). Rates and follow-ups look at user
 * traffic only: `build` (the fleet), `verify` (smoke pings) and `eval` runs are not asks.
 */
const USER_PURPOSE = 'prod'

/** `promise`, or a rejection with the signal's reason as soon as it aborts (the query itself runs on to its timeout). */
async function abortable<T>(signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
  if (!signal) return run()
  signal.throwIfAborted()
  const pending = run()
  pending.catch(() => {})
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    pending.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      },
    )
  })
}

/** The job's own table (migration 0006): the issues it filed, so it never scans a repository to find its own again. */
const issuesTable = (db: Pick<JournalDb, 'runs'>) => db.runs.replace(/\.runs$/, '.friction_issues')

type IssueRecord = { id: string; number: number | null; filed_at: Date; closed_at: Date | null }

/**
 * Recounts runs of the window whose earlier count was incomplete (the agent server did not answer in full), at most
 * `RECOUNT_CAP` per run of the job, before any rate is computed. Runs with the fewest attempts go first (newest first
 * among equals), so a run that keeps failing cannot hold the head of the cap; after `MAX_RECOUNT_ATTEMPTS` the recounter
 * marks it `'gave-up'` and the query no longer returns it.
 */
async function recountIncomplete(deps: Deps): Promise<number> {
  const { db, settings, recount, logger } = deps
  if (!recount) return 0
  const { rows } = await abortable(deps.signal, () =>
    db.pool.query<{ id: string }>(
      `select id from ${db.runs}
       where purpose = '${USER_PURPOSE}' and parent_id is null and status in ('done', 'failed')
         and post_hooks_at is not null and finished_at > now() - make_interval(days => $1)
         and friction->>'incomplete' = 'true'
       order by coalesce((friction->>'recountAttempts')::int, 0), finished_at desc limit ${RECOUNT_CAP}`,
      [settings.windowDays],
    ),
  )
  let done = 0
  for (const { id } of rows) {
    deps.signal?.throwIfAborted()
    try {
      await recount(id, { retry: true })
      done++
    } catch (err) {
      if (deps.signal?.aborted) throw err
      logger.warn('friction job: a run could not be recounted; it stays flagged', {
        runId: id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return done
}

/**
 * Marks `followUps` on runs the user asked again about within `followUpMinutes`. The earlier run must have ended
 * `done` (a failure that is run again is a retry, not a follow-up) and be a user call (`purpose = 'prod'`). The later
 * one must be a top-level user call of the same workflow with the same `cwd` and `scope` input, created after the
 * earlier one finished, and must not be a cancelled run or one refused at admission or on its input (those are not the
 * user asking for something). Done here, once a day, not inline: the earlier run has long been recorded when the
 * follow-up arrives. Idempotent (a marked run is skipped). Workflows whose input has no `cwd` have no follow-up signal.
 * (No supporting index: the candidate rows are one week of `prod` runs and the `exists` probe filters by workflow;
 * fine at today's run volume. Revisit with an index on `(workflow, created_at)` if the daily update gets slow.)
 */
export async function markFollowUps(deps: Deps): Promise<number> {
  const { db, settings } = deps
  const { rowCount } = await abortable(deps.signal, () =>
    db.pool.query(
      `update ${db.runs} r set friction = jsonb_set(coalesce(r.friction, '{"v":1}'::jsonb), '{followUps}', '1'::jsonb)
       where r.purpose = '${USER_PURPOSE}' and r.parent_id is null and r.status = 'done'
         and r.post_hooks_at is not null and r.finished_at > now() - make_interval(days => $1)
         and r.input->>'cwd' is not null
         and coalesce((r.friction->>'followUps')::int, 0) = 0
         and exists (
           select 1 from ${db.runs} n
           where n.workflow = r.workflow and n.id <> r.id and n.parent_id is null and n.purpose = '${USER_PURPOSE}'
             and n.status <> 'cancelled' and coalesce(n.error_kind, '') not in ('admission_refused', 'invalid_input')
             and n.input->>'cwd' = r.input->>'cwd'
             and coalesce(n.input->>'scope', '') = coalesce(r.input->>'scope', '')
             and n.created_at > r.finished_at
             and n.created_at <= r.finished_at + make_interval(secs => $2::float8 * 60))`,
      [settings.windowDays, settings.followUpMinutes],
    ),
  )
  return rowCount ?? 0
}

type RunRow = { workflow: string; id: string; friction: Record<string, unknown> | null; finished_at: Date }

/**
 * Finished top-level user runs of the window with a delivered record. Reads the counters of the friction document only
 * (not its per-session detail): no input, output or path ever leaves SQL. Fan-out children are left out (part of their parent's run); today's workflows run
 * their agents in the top-level run, so nothing is lost.
 */
async function loadRuns(deps: Deps): Promise<RunRow[]> {
  const { db, settings } = deps
  const { rows } = await abortable(deps.signal, () =>
    db.pool.query<RunRow>(
      `select workflow, id, friction - 'sessions' - 'events' as friction, finished_at from ${db.runs}
       where purpose = '${USER_PURPOSE}' and parent_id is null and status in ('done', 'failed')
         and post_hooks_at is not null and finished_at > now() - make_interval(days => $1)
       order by created_at desc`,
      [settings.windowDays],
    ),
  )
  return rows
}

/** The counters of one workflow's runs, only those that finished after `since` when given. */
function statsOf(
  workflow: string,
  rows: readonly RunRow[],
  settings: FrictionSettings,
  since?: Date,
): WorkflowFriction {
  const runs = since ? rows.filter((r) => r.finished_at > since) : rows
  const value = (row: RunRow, counter: FrictionCounter) => {
    const n = Number(row.friction?.[counter] ?? 0)
    return Number.isFinite(n) ? n : 0
  }
  const over = (row: RunRow, counter: FrictionCounter) => {
    const limit = settings.limits[counter]
    return limit !== null && value(row, counter) >= limit
  }
  const counters = Object.fromEntries(
    FRICTION_COUNTERS.map((c) => [
      c,
      { runs: runs.filter((r) => over(r, c)).length, sum: runs.reduce((n, r) => n + value(r, c), 0) },
    ]),
  ) as WorkflowFriction['counters']
  const flagged = runs.filter((r) => FRICTION_COUNTERS.some((c) => over(r, c)))
  return {
    workflow,
    runs: runs.length,
    withFriction: flagged.length,
    rate: runs.length === 0 ? 0 : flagged.length / runs.length,
    counters,
    runIds: flagged.slice(0, EVIDENCE_RUNS).map((r) => r.id),
    ...(since ? { since: since.toISOString() } : {}),
  }
}

const breaches = (stats: WorkflowFriction, settings: FrictionSettings) =>
  stats.runs >= settings.minRuns && stats.runs > 0 && stats.rate >= settings.rate

const byWorkflow = (rows: readonly RunRow[]) => {
  const groups = new Map<string, RunRow[]>()
  for (const row of rows) groups.set(row.workflow, [...(groups.get(row.workflow) ?? []), row])
  return groups
}

/** Counters per workflow over the window. `sinceOf` narrows a workflow to the runs that finished after a date. */
export async function workflowFriction(
  deps: Deps,
  sinceOf: (workflow: string) => Date | undefined = () => undefined,
): Promise<WorkflowFriction[]> {
  const groups = byWorkflow(await loadRuns(deps))
  return [...groups].map(([workflow, rows]) => statsOf(workflow, rows, deps.settings, sinceOf(workflow)))
}

/**
 * The issue text: counts, rates, limits and run ids, nothing else. This repository is public and the runs review
 * private repositories, so no input, output, path, repository name, prompt or transcript is ever read into it.
 */
export function issueBody(stats: WorkflowFriction, settings: FrictionSettings, now: Date, previous?: number): string {
  const percent = (n: number) => `${Math.round(n * 1000) / 10}%`
  // `previous` is the number of an issue that was closed. A removed one has no number to point at.
  const since = stats.since
    ? previous
      ? `finished since ${stats.since.slice(0, 10)}, when the previous issue (#${previous}) was closed`
      : `finished since ${stats.since.slice(0, 10)}, after the previous issue was removed`
    : null
  const lines = [
    since
      ? `Workflow \`${stats.workflow}\`: ${stats.withFriction} of ${stats.runs} top-level user runs (${percent(stats.rate)}) ${since}, had friction; the threshold is ${percent(settings.rate)} with at least ${settings.minRuns} runs.`
      : `Workflow \`${stats.workflow}\`: ${stats.withFriction} of ${stats.runs} top-level user runs (${percent(stats.rate)}) in the last ${settings.windowDays} days up to ${now.toISOString().slice(0, 10)} had friction; the threshold is ${percent(settings.rate)} with at least ${settings.minRuns} runs.`,
    '',
    '| Counter | Limit per run | Runs at or above | Sum over the runs |',
    '|-|-|-|-|',
    ...FRICTION_COUNTERS.map(
      (c) => `| \`${c}\` | ${settings.limits[c] ?? 'off'} | ${stats.counters[c].runs} | ${stats.counters[c].sum} |`,
    ),
    '',
    `Runs with friction (newest first${stats.withFriction > stats.runIds.length ? `, ${stats.runIds.length} of ${stats.withFriction}` : ''}), by id in \`runs\`; their \`friction\` column holds the per-run counters:`,
    '',
    ...stats.runIds.map((id) => `- \`${id}\``),
    '',
    'Counters and their meaning: `packages/middleware/README.md`, section Friction. Opened by the daily friction job. While this issue is open the job files nothing more for the workflow and does not update it. After it is closed, a new issue follows only if runs that finished after the close breach again.',
  ]
  return lines.join('\n')
}

/**
 * The daily job (concept §7 tier 1): recount incomplete runs, mark follow-ups, then per workflow over the window; a
 * rate of runs with friction at or above `settings.rate` (with `minRuns` runs) files ONE issue and records it in
 * `friction_issues`. While that issue is open (looked up by its number, never by scanning the repository) the workflow
 * is skipped; an issue seen reopened clears its close. Once it is closed, the workflow is looked at again over the runs
 * that finished after the close only (a deleted issue: after it was filed), so the same runs never file the same
 * breach twice. An open issue is neither commented on nor edited.
 *
 * Filing is not atomic with recording, so an intent row (no number) is written before `gh issue create` and completed
 * after it. A later tick that finds an intent without a number looks for the issue by its exact title (created since the
 * intent) before it files anything again.
 */
export async function runFrictionJob(deps: Deps): Promise<JobResult> {
  const { settings, gh, logger, db, signal } = deps
  const now = (deps.now ?? (() => new Date()))()
  const recounted = await recountIncomplete(deps)
  const followUps = await markFollowUps(deps)
  const rows = await loadRuns(deps)
  const groups = byWorkflow(rows)
  const result: JobResult = {
    followUps,
    recounted,
    workflows: [...groups].map(([workflow, group]) => statsOf(workflow, group, settings)),
    issues: [],
  }
  const repo = settings.repo
  if (!repo) {
    logger.warn('friction job: AGW_FRICTION_REPO is unset; counters and follow-ups are recorded, no issue is opened')
    return result
  }
  const table = issuesTable(db)
  const query = <T extends Record<string, unknown>>(text: string, params: unknown[]) =>
    abortable(signal, () => db.pool.query<T>(text, params))
  const latest = async (workflow: string): Promise<IssueRecord | undefined> =>
    (
      await query<IssueRecord>(
        `select id, number, filed_at, closed_at from ${table} where repo = $1 and workflow = $2
         order by filed_at desc, id desc limit 1`,
        [repo, workflow],
      )
    ).rows[0]

  for (const [workflow, group] of groups) {
    const title = issueTitle(workflow)
    try {
      let record = await latest(workflow)
      // An intent without a number: a crash between `gh issue create` and the record. The issue may exist.
      if (record && record.number === null) {
        if (Date.now() - record.filed_at.getTime() < INTENT_GRACE_MS) {
          // Fresh: another tick is probably between `gh issue create` and the record. Leave it its time.
          logger.warn('friction job: another run is filing this workflow; skipped', { workflow })
          result.issues.push({ workflow, title, existing: true })
          continue
        }
        const slack = record.filed_at.getTime() - 60_000
        const found = (await gh.findIssuesByTitle(repo, title, signal)).find(
          (issue) => new Date(issue.createdAt).getTime() >= slack,
        )
        if (found) {
          await query(`update ${table} set number = $2, url = $3 where id = $1`, [record.id, found.number, found.url])
        } else {
          await query(`delete from ${table} where id = $1`, [record.id])
        }
        record = await latest(workflow)
      }
      let stats = statsOf(workflow, group, settings, record?.closed_at ?? undefined)
      if (!breaches(stats, settings)) continue

      let previousClosed: number | undefined
      if (record?.number != null) {
        // Even a closed record is asked about: the issue may have been reopened since.
        const state = await gh.issueState(repo, record.number, signal)
        if (state.state === 'open') {
          if (record.closed_at) await query(`update ${table} set closed_at = null where id = $1`, [record.id])
          result.issues.push({ workflow, title, existing: true })
          continue
        }
        previousClosed = state.state === 'closed' ? record.number : undefined // a removed issue has no number to point at
        if (!record.closed_at) {
          // Closed since the last look: from now on only runs that finished after the close count. A deleted issue has
          // no close time: its evidence starts when it was filed.
          const closedAt = state.state === 'closed' && state.closedAt ? new Date(state.closedAt) : record.filed_at
          await query(`update ${table} set closed_at = $2 where id = $1`, [record.id, closedAt])
          stats = statsOf(workflow, group, settings, closedAt)
          if (!breaches(stats, settings)) continue
        }
      }

      // At most one intent per workflow (a partial unique index): a second one means another tick is filing it.
      let intentId: string | undefined
      try {
        intentId = (
          await query<{ id: string }>(`insert into ${table} (repo, workflow) values ($1, $2) returning id`, [
            repo,
            workflow,
          ])
        ).rows[0]?.id
      } catch (err) {
        if ((err as { code?: string }).code !== '23505') throw err
        logger.warn('friction job: another run is filing this workflow; skipped', { workflow })
        result.issues.push({ workflow, title, existing: true })
        continue
      }
      const url = await gh.createIssue(repo, title, issueBody(stats, settings, now, previousClosed), signal)
      try {
        await query(`update ${table} set number = $2, url = $3 where id = $1`, [intentId, issueNumber(url), url])
      } catch (err) {
        // The intent stays: the next tick finds the issue by its title and completes the row instead of filing again.
        logger.error('friction job: an issue was filed but could not be recorded; the next run completes the record', {
          workflow,
          url,
          error: err instanceof Error ? err.message : String(err),
        })
      }
      result.issues.push({ workflow, title, url })
    } catch (err) {
      if (signal?.aborted) throw err
      // Includes a state that could not be read (no `gh`, an unreachable repository): skipped this tick, never refiled.
      logger.error('friction job: could not check or open the issue; skipped this run', {
        workflow,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return result
}

const DAY_MS = 24 * 3_600_000
const FIRST_DELAY_MS = 10 * 60_000
const CLOSE_WAIT_MS = 10_000

/** Runs the job on a daily timer (first run after a short delay, so a deploy does not hit `gh` at boot). */
export function startFrictionJob(
  deps: Omit<Deps, 'signal'> & { intervalMs?: number; firstDelayMs?: number; closeWaitMs?: number },
): { close(): Promise<void> } {
  const controller = new AbortController()
  let running: Promise<void> | null = null
  const tick = () => {
    if (running) return
    running = runFrictionJob({ ...deps, signal: controller.signal })
      .then((result) => {
        // Only what was filed: a breach whose issue is still open needs no action and no log line.
        const filed = result.issues.filter((issue) => issue.url)
        if (filed.length > 0) deps.logger.warn('friction job: issues opened', { issues: filed })
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return // shutting down
        deps.logger.error('friction job failed', { error: err instanceof Error ? err.message : String(err) })
      })
      .finally(() => {
        running = null
      })
  }
  let timer: ReturnType<typeof setInterval> | undefined
  const first = setTimeout(() => {
    tick()
    timer = setInterval(tick, deps.intervalMs ?? DAY_MS)
    timer.unref?.()
  }, deps.firstDelayMs ?? FIRST_DELAY_MS)
  first.unref?.()
  return {
    /** Stops the timers, aborts the job's calls and waits for it a bounded time: shutdown never blocks on a job. */
    async close() {
      clearTimeout(first)
      if (timer) clearInterval(timer)
      controller.abort(new Error('friction job closed'))
      let cap: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        running,
        new Promise<void>((resolve) => {
          cap = setTimeout(resolve, deps.closeWaitMs ?? CLOSE_WAIT_MS)
        }),
      ])
      clearTimeout(cap)
    },
  }
}

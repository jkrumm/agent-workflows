import { IdempotencyConflict, type Logger, type Runtime } from '@agent-workflows/runtime'
import type { HostWorkflow } from '../../operations.ts'
import type { JournalReader } from './sample.ts'
import { DEFAULT_SAMPLE, DEFAULT_WINDOW_DAYS } from './schema.ts'

const DAY_MS = 86_400_000
export const RETRO_PURPOSE = 'retro'

/** ISO 8601 week of a date in UTC: `2026-W44`. The year is the ISO week-year, not the calendar year. */
export function isoWeek(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  const day = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - day) // the Thursday of this week decides the year
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1)
  const week = Math.ceil(((d.getTime() - yearStart) / DAY_MS + 1) / 7)
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

export const retroKey = (workflow: string, date: Date) => `retro:${workflow}:${isoWeek(date)}`

/** Failed retrospectives of one week retried under `<key>:retry-<n>`; a lifecycle bound on re-starts, not an agent cap. */
export const MAX_WEEKLY_RETRIES = 3

/**
 * The key to start for a week, or null. No run yet: the base key. Any run still going or done: none (a cancelled one
 * was stopped on purpose). Only failed runs: the next retry key, up to {@link MAX_WEEKLY_RETRIES}.
 */
export function nextKey(base: string, existing: readonly { key: string; status: string }[]): string | null {
  if (existing.length === 0) return base
  if (existing.some((run) => run.status !== 'failed')) return null
  const retries = existing.filter((run) => run.key !== base).length
  return retries >= MAX_WEEKLY_RETRIES ? null : `${base}:retry-${retries + 1}`
}

export interface RetroScheduleOptions {
  runtime: Pick<Runtime, 'start'>
  retrospective: HostWorkflow
  journal: JournalReader
  /** The workflows that run agents (the retrospective itself excluded). */
  workflows: readonly string[]
  fileIssues: boolean
  logger: Pick<Logger, 'warn' | 'error'>
  now?: () => Date
  /** Checked before each workflow: a stopped schedule starts nothing more. */
  stopped?: () => boolean
}

/**
 * One tick: for each workflow that had finished runs in the last {@link DEFAULT_WINDOW_DAYS} days, start its
 * retrospective under `retro:<workflow>:<ISO week>`. The journal's `(workflow, idempotency_key)` constraint makes it
 * exactly once per workflow and week however often the tick or the host restarts; the first tick of a new week is the
 * one that starts it, so a host that was down on Monday catches up. Returns the runs started by this tick.
 */
export async function tickRetrospectives(
  options: RetroScheduleOptions,
): Promise<{ workflow: string; runId: string; key: string }[]> {
  const now = options.now?.() ?? new Date()
  const since = new Date(now.getTime() - DEFAULT_WINDOW_DAYS * DAY_MS)
  const started: { workflow: string; runId: string; key: string }[] = []
  for (const workflow of options.workflows) {
    if (options.stopped?.()) break
    try {
      if ((await options.journal.countFinished({ workflow, since })) === 0) continue
      const key = nextKey(retroKey(workflow, now), await options.journal.weekRuns(retroKey(workflow, now)))
      if (!key) continue
      const input = { workflow, window: DEFAULT_WINDOW_DAYS, sample: DEFAULT_SAMPLE, fileIssues: options.fileIssues }
      const { runId } = await options.runtime.start(options.retrospective.workflow, input, {
        purpose: RETRO_PURPOSE,
        idempotencyKey: key,
      })
      started.push({ workflow, runId, key })
    } catch (error) {
      // The key was used with other input (fileIssues flipped mid-week): that week's run stands.
      if (error instanceof IdempotencyConflict) continue
      options.logger.error('weekly retrospective failed to start', {
        workflow,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return started
}

/**
 * Ticks on an interval (default hourly) and once at start. `stop` ends the timer and resolves once a tick in flight has
 * finished, so the pool and the runtime it uses can be closed after it.
 */
export function startRetroSchedule(options: Omit<RetroScheduleOptions, 'stopped'> & { intervalMs?: number }): {
  stop(): Promise<void>
} {
  let current: Promise<void> | null = null
  let stopped = false
  const tick = () => {
    if (current || stopped) return
    current = tickRetrospectives({ ...options, stopped: () => stopped })
      .then(() => {})
      .catch((error: unknown) =>
        options.logger.error('retrospective tick failed', {
          error: error instanceof Error ? error.message : String(error),
        }),
      )
      .finally(() => {
        current = null
      })
  }
  const timer = setInterval(tick, options.intervalMs ?? 3_600_000)
  timer.unref?.()
  tick()
  return {
    async stop() {
      stopped = true
      clearInterval(timer)
      await current
    },
  }
}

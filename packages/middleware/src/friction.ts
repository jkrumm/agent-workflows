import type { Logger, Middleware } from '@agent-workflows/runtime'
import { errorMessage, type JournalDb, withRetry } from './db.ts'

/** Per-session counters an agent host derives from the session's own messages. */
export type SessionCounters = {
  toolErrors: number
  repeatToolCalls: number
  nudges: number
  /** Nudges that were due (a call reached its 3rd, 5th or 8th repeat) and are not in the session: failed, given up, or too late. */
  nudgesMissed: number
}

/** What a source reports for one step: its sessions, and whether every probe it needed answered. */
export type StepSessions = {
  /** One entry per session the step's key ever opened: every attempt, every provider-balance fallback. */
  sessions: ({ session: string } & SessionCounters)[]
  /** True when a probe failed, so later generations or a fallback may be missing from `sessions`. */
  incomplete: boolean
}

/** What the platform asks an agent host for at `runPost`: the counters of every session a step opened. */
export type FrictionSource = {
  stepSessions(step: { runId: string; stepId: string }): Promise<StepSessions>
}

/**
 * Why a failed step counts toward `schemaReasks` / `overBudget`. Keyed `<stepId>#<attempt>` (or `run#wallet`), read
 * from the journal at `runPost`, so a re-delivery writes the same entries.
 */
export type FrictionEvent = 'invalid_output' | 'budget'

/**
 * `runs.friction` (concept §7 tier 1), version 1. The counters are the run's totals; `sessions` (per step id, per
 * session id) and `events` are what they are summed from, replaced as a whole at every `runPost`.
 */
export type Friction = {
  v: 1
  /** Tool parts that ended in `error`, summed over every session the run's agent steps opened. */
  toolErrors: number
  /** The highest number of identical tool calls (same tool, same canonical input) in any one session. */
  repeatToolCalls: number
  /** Repeat-tool nudges the host sent (at the 3rd, 5th and 8th identical call). */
  nudges: number
  /** Repeat-tool nudges that were due and never landed. Informational: not a threshold counter. */
  nudgesMissed: number
  /**
   * Agent steps whose last attempt failed `invalid_output`, once each, whatever re-asks follow. An earlier attempt
   * that a retry overcame is not visible to any hook (the journal keeps only the last attempt of a step).
   */
  schemaReasks: number
  /** Runs the wallet gate refused, plus steps the runaway cap failed. */
  overBudget: number
  /** 1 when the user had to ask again (see the host's threshold job); set there, never inline. */
  followUps: number
  /**
   * `true` while the host could not answer completely: the session counters may be short until the daily job recounts.
   * `'gave-up'` after `MAX_RECOUNT_ATTEMPTS` recounts that still could not: the job leaves the run alone.
   */
  incomplete?: true | 'gave-up'
  /** Recounts by the daily job that still left the run incomplete. */
  recountAttempts?: number
  sessions?: Record<string, Record<string, SessionCounters>>
  events?: Record<string, FrictionEvent>
}

/** The counters a threshold applies to. `nudgesMissed` is a diagnostic, not a limit. */
export const FRICTION_COUNTERS = [
  'toolErrors',
  'repeatToolCalls',
  'nudges',
  'schemaReasks',
  'overBudget',
  'followUps',
] as const
export type FrictionCounter = (typeof FRICTION_COUNTERS)[number]

/** The message prefixes of the two money rules (`@agent-workflows/limits`); the host's tests pin them to the real ones. */
export const WALLET_REFUSAL_PREFIX = 'wallet gate:'
export const RUNAWAY_CAP_PREFIX = 'runaway cap:'

/** Session probes in flight at once across a run's agent steps. */
export const PROBE_CONCURRENCY = 4

/** Daily recounts of an incomplete run before it is marked `'gave-up'` and left alone. */
export const MAX_RECOUNT_ATTEMPTS = 3

/** The totals of a stored document; `followUps` is kept as the job set it. */
export function totalsOf(doc: Partial<Friction> | null | undefined): Friction {
  const sessions = Object.values(doc?.sessions ?? {}).flatMap((step) => Object.values(step))
  const events = Object.values(doc?.events ?? {})
  return {
    v: 1,
    toolErrors: sessions.reduce((n, s) => n + s.toolErrors, 0),
    repeatToolCalls: Math.max(0, ...sessions.map((s) => s.repeatToolCalls)),
    nudges: sessions.reduce((n, s) => n + s.nudges, 0),
    nudgesMissed: sessions.reduce((n, s) => n + (s.nudgesMissed ?? 0), 0),
    schemaReasks: events.filter((e) => e === 'invalid_output').length,
    overBudget: events.filter((e) => e === 'budget').length,
    followUps: doc?.followUps ?? 0,
    ...(doc?.incomplete ? { incomplete: doc.incomplete } : {}),
    ...(doc?.recountAttempts ? { recountAttempts: doc.recountAttempts } : {}),
    ...(doc?.sessions ? { sessions: doc.sessions } : {}),
    ...(doc?.events ? { events: doc.events } : {}),
  }
}

/** The event a failed step stands for, or null; read from a step row. */
export function stepEvent(step: {
  kind: string
  status: string
  errorKind: string | null | undefined
  message: string | null | undefined
}): FrictionEvent | null {
  if (step.status !== 'failed') return null
  if (step.kind === 'agent' && step.errorKind === 'invalid_output') return 'invalid_output'
  if (step.errorKind === 'middleware' && step.message?.startsWith(RUNAWAY_CAP_PREFIX)) return 'budget'
  return null
}

/** True for a run the wallet gate refused at admission (read from the run row's `error_kind` and `error`). */
export function walletRefusal(run: { errorKind: string | null; error: string | null }): boolean {
  return run.errorKind === 'admission_refused' && (run.error?.startsWith(WALLET_REFUSAL_PREFIX) ?? false)
}

type StepRow = {
  step_id: string
  kind: string
  status: string
  attempts: number
  error: string | null
  error_kind: string | null
}

/** `fn` over `items`, at most `limit` at a time. */
async function mapLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const worker = async () => {
    while (next < items.length) await fn(items[next++] as T)
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

/** The counters of one run, recomputed from the journal and the host. */
export type FrictionRecounter = {
  /**
   * Recomputes `runs.friction` of a finished run. Idempotent; never throws for a probe that fails (it marks
   * `incomplete`). `retry` is the daily job asking again: a result that is still incomplete counts one attempt, and
   * after `MAX_RECOUNT_ATTEMPTS` the run is marked `'gave-up'`.
   */
  recount(runId: string, options?: { retry?: boolean }): Promise<void>
}

/**
 * Two entries of the same session, the kept one and a newer partial one. Tool errors, the repeat count and the nudges
 * only grow with the session, so the larger is the fuller. `nudgesMissed` can fall (a late note that landed makes an
 * earlier miss disappear), so it comes from the newest answer.
 */
const fuller = (kept: SessionCounters, newest: SessionCounters): SessionCounters => ({
  toolErrors: Math.max(kept.toolErrors, newest.toolErrors),
  repeatToolCalls: Math.max(kept.repeatToolCalls, newest.repeatToolCalls),
  nudges: Math.max(kept.nudges, newest.nudges),
  nudgesMissed: newest.nudgesMissed ?? 0,
})

/**
 * Friction counters, no LLM (concept §7): a true recompute. The sessions of every agent step come from the host (all
 * attempts, fallbacks), the events from the journaled step rows and the run's own outcome, both read together under
 * the run row's lock, and the document is replaced, not merged, so nothing stale survives and nothing counts twice.
 *
 * A host that cannot answer completely never costs a count and never fails the run's hooks: the step that was only
 * partly answered, or not at all, keeps what an earlier answer wrote (per session the fuller entry wins), and the
 * document says `incomplete: true`. The daily friction job recounts such runs (bounded per tick) before it computes
 * rates, so a restart of the agent server delays a count, it does not erase one.
 */
export function frictionRecounter(options: {
  db: JournalDb
  logger: Logger
  source?: FrictionSource
}): FrictionRecounter {
  const { db, logger, source } = options

  return {
    async recount(runId, recountOptions = {}) {
      // Outside the transaction: host reads can be slow and must not hold the run row.
      const { rows: agentSteps } = await withRetry(() =>
        db.pool.query<{ step_id: string }>(`select step_id from ${db.steps} where run_id = $1 and kind = 'agent'`, [
          runId,
        ]),
      )
      const fresh = new Map<string, { sessions: Record<string, SessionCounters>; incomplete: boolean }>()
      if (source) {
        await mapLimit(agentSteps, PROBE_CONCURRENCY, async ({ step_id }) => {
          try {
            const found = await source.stepSessions({ runId, stepId: step_id })
            fresh.set(step_id, {
              sessions: Object.fromEntries(found.sessions.map(({ session, ...counters }) => [session, counters])),
              incomplete: found.incomplete,
            })
          } catch (err) {
            logger.warn('friction: session counters not read; the step keeps its earlier counters', {
              runId,
              stepId: step_id,
              error: errorMessage(err),
            })
          }
        })
      }

      const missing = await withRetry(async () => {
        const client = await db.pool.connect()
        try {
          await client.query('begin')
          const { rows } = await client.query<{
            friction: Partial<Friction> | null
            error: string | null
            error_kind: string | null
          }>(`select friction, error, error_kind from ${db.runs} where id = $1 for update`, [runId])
          const run = rows[0]
          if (!run) {
            await client.query('rollback')
            return true
          }
          const { rows: steps } = await client.query<StepRow>(
            `select step_id, kind, status, attempts, error, error_kind from ${db.steps} where run_id = $1`,
            [runId],
          )
          const previous = run.friction ?? { v: 1 }
          const events: Record<string, FrictionEvent> = {}
          const sessions: Record<string, Record<string, SessionCounters>> = {}
          let incomplete = false
          for (const step of steps) {
            const event = stepEvent({
              kind: step.kind,
              status: step.status,
              errorKind: step.error_kind,
              message: step.error,
            })
            if (event) events[`${step.step_id}#${step.attempts}`] = event
            if (step.kind !== 'agent') continue
            const answered = fresh.get(step.step_id)
            const kept = previous.sessions?.[step.step_id]
            if (answered && !answered.incomplete) {
              sessions[step.step_id] = answered.sessions // complete: replaces
              continue
            }
            // Not answered, or answered partly: the earlier entries stay, the fuller entry of a session wins.
            if (source) incomplete = true
            const merged: Record<string, SessionCounters> = { ...kept }
            for (const [id, counters] of Object.entries(answered?.sessions ?? {})) {
              const before = merged[id]
              merged[id] = before ? fuller(before, counters) : counters
            }
            if (Object.keys(merged).length > 0) sessions[step.step_id] = merged
          }
          if (walletRefusal({ errorKind: run.error_kind, error: run.error })) events['run#wallet'] = 'budget'
          const attempts = (previous.recountAttempts ?? 0) + (incomplete && recountOptions.retry ? 1 : 0)
          const doc = totalsOf({
            sessions,
            events,
            followUps: previous.followUps,
            ...(incomplete
              ? {
                  incomplete: attempts >= MAX_RECOUNT_ATTEMPTS ? ('gave-up' as const) : (true as const),
                  recountAttempts: attempts,
                }
              : {}),
          })
          await client.query(`update ${db.runs} set friction = $2::jsonb where id = $1`, [runId, JSON.stringify(doc)])
          await client.query('commit')
          return false
        } catch (err) {
          await client.query('rollback').catch(() => {})
          throw err
        } finally {
          client.release()
        }
      })
      if (missing) logger.error('friction: run row not found', { runId })
    },
  }
}

/** The platform middleware: `runPost` counts the run. Must come before `recordMiddleware`, which reads the document. */
export function frictionMiddleware(options: { db: JournalDb; logger: Logger; source?: FrictionSource }): Middleware {
  const recounter = frictionRecounter(options)
  return { name: 'friction', runPost: (args) => recounter.recount(args.runId) }
}

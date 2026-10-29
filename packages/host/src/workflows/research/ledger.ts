import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'

/** One call through the tool gate, as evidence: what it read and saw, whether it worked, which engine job it ran. */
export type LedgerEntry = {
  runId: string
  stepId: string
  tool: string
  argsDigest: string
  ok: boolean
  retrieved: string[]
  seen: string[]
  engineJob?: string
  /** With `engineJob`: the cost the engine reported for the job (null: unknown). */
  engineCostUsd?: number | null
  error?: string
}

/**
 * Where the gate's calls go (migrations 0007, 0008). Append-only: `read` never consumes, so a retried or resumed step
 * reads the same calls. A call's cost is booked on the run itself; an engine job's row carries the cost the engine
 * reported (the evidence of the run's engine spend), and the ledger decides which row books the job: once per run,
 * step and job, atomically.
 */
export interface ToolLedger {
  /**
   * Appends the call. For an engine job it claims the job's booking under `claim` (a token the caller keeps across its
   * retries of this write) and answers whether this call holds it: true for the first row of the job in this step, and
   * for a retry whose earlier write landed. Without an engine job it answers false.
   */
  append(entry: LedgerEntry, claim?: string): Promise<boolean>
  read(runId: string, stepId: string): Promise<LedgerEntry[]>
}

/** A fresh booking token for one call's writes. */
export const bookingClaim = () => randomUUID()

type Row = {
  tool: string
  args_digest: string
  ok: boolean
  retrieved: string[]
  seen: string[]
  engine_job: string | null
  engine_cost: string | null
  error: string | null
}

export function pgToolLedger(pool: Pick<Pool, 'query'>, schema: string): ToolLedger {
  const table = `"${schema}".research_tool_calls`
  const insert = (e: LedgerEntry, bookedBy: string | null, onConflict = '') =>
    pool.query(
      `insert into ${table} (run_id, step_id, tool, args_digest, ok, retrieved, seen, engine_job, engine_cost, error, booked_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ${onConflict} returning id`,
      [
        e.runId,
        e.stepId,
        e.tool,
        e.argsDigest,
        e.ok,
        JSON.stringify(e.retrieved),
        JSON.stringify(e.seen),
        e.engineJob ?? null,
        e.engineCostUsd ?? null,
        e.error ?? null,
        bookedBy,
      ],
    )
  return {
    async append(e, claim) {
      if (!e.engineJob || !claim) {
        await insert(e, null)
        return false
      }
      const claimed = await insert(
        e,
        claim,
        'on conflict (run_id, step_id, engine_job) where booked_by is not null do nothing',
      )
      if (claimed.rowCount) return true
      // Another row holds the booking: ours from a write acknowledged too late (already in), or another call's.
      const { rows } = await pool.query<{ booked_by: string }>(
        `select booked_by from ${table} where run_id = $1 and step_id = $2 and engine_job = $3 and booked_by is not null`,
        [e.runId, e.stepId, e.engineJob],
      )
      if (rows[0]?.booked_by === claim) return true
      await insert(e, null)
      return false
    },
    async read(runId, stepId) {
      const { rows } = await pool.query<Row>(
        `select tool, args_digest, ok, retrieved, seen, engine_job, engine_cost, error
           from ${table} where run_id = $1 and step_id = $2 order by id`,
        [runId, stepId],
      )
      return rows.map((r) => ({
        runId,
        stepId,
        tool: r.tool,
        argsDigest: r.args_digest,
        ok: r.ok,
        retrieved: r.retrieved,
        seen: r.seen,
        ...(r.engine_job === null
          ? {}
          : { engineJob: r.engine_job, engineCostUsd: r.engine_cost === null ? null : Number(r.engine_cost) }),
        ...(r.error === null ? {} : { error: r.error }),
      }))
    },
  }
}

/** A host without a database (tests, a dev host): the same contract in memory, per process. */
export function memoryToolLedger(): ToolLedger {
  const entries: LedgerEntry[] = []
  const bookings = new Map<string, string>()
  return {
    async append(e, claim) {
      entries.push(structuredClone(e))
      if (!e.engineJob || !claim) return false
      const job = `${e.runId}\0${e.stepId}\0${e.engineJob}`
      if (!bookings.has(job)) bookings.set(job, claim)
      return bookings.get(job) === claim
    },
    async read(runId, stepId) {
      return entries.filter((e) => e.runId === runId && e.stepId === stepId).map((e) => structuredClone(e))
    },
  }
}

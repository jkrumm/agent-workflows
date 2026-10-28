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
 * Where the gate's calls go (migration 0007). Append-only: `read` never consumes, so a retried or resumed step reads the
 * same calls. A call's cost is booked on the run itself; an engine job's row carries the cost the engine reported, the
 * one source of the run's engine spend and of whether a job was already booked.
 */
export interface ToolLedger {
  append(entry: LedgerEntry): Promise<void>
  read(runId: string, stepId: string): Promise<LedgerEntry[]>
}

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
  return {
    async append(e) {
      await pool.query(
        `insert into ${table} (run_id, step_id, tool, args_digest, ok, retrieved, seen, engine_job, engine_cost, error)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
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
        ],
      )
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
  return {
    async append(e) {
      entries.push(structuredClone(e))
    },
    async read(runId, stepId) {
      return entries.filter((e) => e.runId === runId && e.stepId === stepId).map((e) => structuredClone(e))
    },
  }
}

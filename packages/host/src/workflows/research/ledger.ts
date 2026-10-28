import type { Usage } from '@agent-workflows/runtime'
import type { Pool } from 'pg'

/** One call through the tool gate, as it is recorded. */
export type LedgerEntry = {
  runId: string
  stepId: string
  tool: string
  argsDigest: string
  ok: boolean
  retrieved: string[]
  seen: string[]
  usage: Usage[]
  engineJob?: string
  /** The engine's own reported cost of `engineJob`; null when it reported none (never 0 for unknown). */
  engineCostUsd?: number | null
  error?: string
}

/**
 * Where the gate's calls go (concept: the platform is the system of record). Append-only: `read` never consumes, so a
 * retried or resumed `evidence` step reads the same calls. An engine job is booked once per run: a second entry with
 * the same `engineJob` (a repeated question that adopted the job) is not stored.
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
  usage: Usage[]
  engine_job: string | null
  engine_cost: string | null
  error: string | null
}

export function pgToolLedger(pool: Pick<Pool, 'query'>, schema: string): ToolLedger {
  const table = `"${schema}".research_tool_calls`
  return {
    async append(e) {
      await pool.query(
        `insert into ${table} (run_id, step_id, tool, args_digest, ok, retrieved, seen, usage, engine_job, engine_cost, error)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         on conflict (run_id, engine_job) where engine_job is not null do nothing`,
        [
          e.runId,
          e.stepId,
          e.tool,
          e.argsDigest,
          e.ok,
          JSON.stringify(e.retrieved),
          JSON.stringify(e.seen),
          JSON.stringify(e.usage),
          e.engineJob ?? null,
          e.engineCostUsd ?? null,
          e.error ?? null,
        ],
      )
    },
    async read(runId, stepId) {
      const { rows } = await pool.query<Row>(
        `select tool, args_digest, ok, retrieved, seen, usage, engine_job, engine_cost, error
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
        usage: r.usage,
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
      if (e.engineJob && entries.some((x) => x.runId === e.runId && x.engineJob === e.engineJob)) return
      entries.push(structuredClone(e))
    },
    async read(runId, stepId) {
      return entries.filter((e) => e.runId === runId && e.stepId === stepId).map((e) => structuredClone(e))
    },
  }
}

import type { Pool } from 'pg'

/** One call through the tool gate, as evidence: what it read and saw, and whether it worked. */
export type LedgerEntry = {
  runId: string
  stepId: string
  tool: string
  argsDigest: string
  ok: boolean
  retrieved: string[]
  seen: string[]
  error?: string
}

/** A research run as a follow-up reads it: its status and workflow, its question, and the report it answered with. */
export type FinishedRun = {
  workflow: string
  status: string
  input: unknown
  output: unknown
}

/**
 * Where the gate's calls go (migrations 0007, 0009). Append-only: `read` never consumes, so a retried or resumed step
 * reads the same calls. A call's cost is booked on the run itself; the row is only its evidence. The same store reads
 * a run's record for a follow-up, because it already holds the host's journal connection.
 */
export interface ToolLedger {
  append(entry: LedgerEntry): Promise<void>
  read(runId: string, stepId: string): Promise<LedgerEntry[]>
  /** The run's record, or null when no such run exists (or the host has no journal). */
  run(runId: string): Promise<FinishedRun | null>
}

type Row = {
  tool: string
  args_digest: string
  ok: boolean
  retrieved: string[]
  seen: string[]
  error: string | null
}

export function pgToolLedger(pool: Pick<Pool, 'query'>, schema: string): ToolLedger {
  const table = `"${schema}".research_tool_calls`
  return {
    async append(e) {
      await pool.query(
        `insert into ${table} (run_id, step_id, tool, args_digest, ok, retrieved, seen, error)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          e.runId,
          e.stepId,
          e.tool,
          e.argsDigest,
          e.ok,
          JSON.stringify(e.retrieved),
          JSON.stringify(e.seen),
          e.error ?? null,
        ],
      )
    },
    async read(runId, stepId) {
      const { rows } = await pool.query<Row>(
        `select tool, args_digest, ok, retrieved, seen, error
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
        ...(r.error === null ? {} : { error: r.error }),
      }))
    },
    async run(runId) {
      const { rows } = await pool.query<FinishedRun>(
        `select workflow, status, input, output from "${schema}".runs where id = $1`,
        [runId],
      )
      return rows[0] ?? null
    },
  }
}

/** A host without a database (tests, a dev host): the same contract in memory, per process, with no journal to read. */
export function memoryToolLedger(): ToolLedger {
  const entries: LedgerEntry[] = []
  return {
    async append(e) {
      entries.push(structuredClone(e))
    },
    async read(runId, stepId) {
      return entries.filter((e) => e.runId === runId && e.stepId === stepId).map((e) => structuredClone(e))
    },
    async run() {
      return null
    },
  }
}

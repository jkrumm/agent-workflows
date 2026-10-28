import type { Pool } from 'pg'

export type RunStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled'

/** The run state body of the host contract: workflow start, run status, run wait, run cancel. */
export type RunState = {
  runId: string
  workflowId: string
  status: RunStatus
  output?: unknown
  error?: { kind: string; message: string }
}

export const isTerminal = (status: RunStatus) => status === 'done' || status === 'failed' || status === 'cancelled'

/** Read side of the journal. The runtime owns every write; the host only reads state for the HTTP bodies. */
export interface RunStore {
  get(runId: string): Promise<RunState | null>
  /** Resolves when Postgres answers. */
  ping(): Promise<void>
}

const SCHEMA_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

type Row = {
  id: string
  workflow: string
  status: RunStatus
  output: unknown
  error: string | null
  error_kind: string | null
}

export function pgRunStore({ pool, schema = 'agw' }: { pool: Pool; schema?: string }): RunStore {
  if (!SCHEMA_NAME.test(schema)) throw new Error(`invalid journal schema name "${schema}"`)
  const runs = `"${schema}".runs`
  return {
    async get(runId) {
      const { rows } = await pool.query<Row>(
        `select id, workflow, status, output, error, error_kind from ${runs} where id = $1`,
        [runId],
      )
      const row = rows[0]
      if (!row) return null
      return {
        runId: row.id,
        workflowId: row.workflow,
        status: row.status,
        ...(row.status === 'done' && row.output !== null ? { output: row.output } : {}),
        ...(row.error_kind ? { error: { kind: row.error_kind, message: row.error ?? '' } } : {}),
      }
    },
    async ping() {
      await pool.query('select 1')
    },
  }
}

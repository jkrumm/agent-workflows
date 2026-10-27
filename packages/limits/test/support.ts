import type { Pool } from 'pg'
import type { Metrics } from '../src/index.ts'

export { captureLogger, freshSchema, inspector, PG_URL, testRuntime, until } from '../../runtime/test/support/pg.ts'

/** Inserts finished runs of `workflow` straight into the journal (two statements): usage on each run's first step. */
export async function seedRuns(
  pool: Pool,
  schema: string,
  workflow: string,
  runs: Metrics[],
  { status = 'done', ageDays = 1 }: { status?: 'done' | 'failed'; ageDays?: number } = {},
) {
  const rows = runs.map((m) => ({ id: `seed-${crypto.randomUUID()}`, ...m }))
  await pool.query(
    `insert into "${schema}".runs
       (id, workflow, root_id, status, purpose, input, input_hash, lock_key, version_started, started_at, finished_at)
     select r.id, $2, r.id, $3, 'test', '{}', 'seed', 0, 'v1',
       now() - $4 * interval '1 day', now() - $4 * interval '1 day' + r."wallMs" * interval '1 millisecond'
     from jsonb_to_recordset($1::jsonb) as r(id text, "wallMs" float8)`,
    [JSON.stringify(rows), workflow, status, ageDays],
  )
  await pool.query(
    `insert into "${schema}".steps
       (run_id, step_id, kind, status, attempts, cost, tokens_input, started_at, attempt_started_at, finished_at)
     select r.id, 's' || n, 'code', 'done', 1,
       case when n = 0 then r.cost else 0 end, case when n = 0 then r.tokens else 0 end,
       run.started_at, run.started_at, run.finished_at
     from jsonb_to_recordset($1::jsonb) as r(id text, cost numeric, tokens bigint, steps int)
     join "${schema}".runs run on run.id = r.id,
       generate_series(0, r.steps - 1) as n`,
    [JSON.stringify(rows)],
  )
}

/** Postgres `percentile_cont`: linear interpolation between the closest ranks. */
export function p95(values: number[]): number {
  const xs = [...values].sort((a, b) => a - b)
  const pos = 0.95 * (xs.length - 1)
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  const a = xs[lo] ?? 0
  const b = xs[hi] ?? 0
  return a + (b - a) * (pos - lo)
}

export function costUsage(cost: number, tokens = 0) {
  return { tokens: { input: tokens, output: 0, cacheRead: 0, reasoning: 0 }, cost }
}

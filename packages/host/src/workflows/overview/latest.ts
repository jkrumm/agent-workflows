import type { Pool } from 'pg'

/**
 * The output of the newest completed `overview` run (eval runs excluded), or null when none exists: the cache behind
 * `agw agents`. Read through the process's own journal pool; the run output is a JSON column.
 */
export function pgLatestOverview(pool: Pick<Pool, 'query'>, schema: string): () => Promise<unknown> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error(`invalid schema name "${schema}"`)
  const sql = `select output from "${schema}".runs
    where workflow = 'overview' and parent_id is null and status = 'done' and purpose <> 'eval' and output is not null
    order by finished_at desc limit 1`
  return async () => {
    const { rows } = await pool.query<{ output: unknown }>(sql)
    return rows[0]?.output ?? null
  }
}

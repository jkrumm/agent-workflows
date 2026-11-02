import type { Pool } from 'pg'

/** The `label` step of an `eval.mine` run, priced: what it cost for all the candidates it labelled. */
export type LabelStepCost = { runId: string; cost: number }

/**
 * The cost of the `label` step of the newest `eval.mine` runs among `runIds`, newest first, steps with an unknown cost
 * (null) left out; a free step (0) counts. Read through the host's read pool: labelling runs inside the `eval.mine`
 * run (`eval.label` is called in process), so no `eval.label` run exists to read.
 */
export function pgLabelStepCosts(
  pool: Pick<Pool, 'query'>,
  schema: string,
): (options: { runIds: string[]; limit: number }) => Promise<LabelStepCost[]> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error(`invalid schema name "${schema}"`)
  const sql = `select r.id, s.cost::text as cost from "${schema}".runs r
    join "${schema}".steps s on s.run_id = r.id and s.step_id = 'label'
    where r.workflow = 'eval.mine' and r.id = r.root_id and r.id = any($1) and s.cost is not null
    order by coalesce(s.finished_at, r.created_at) desc, r.id limit $2`
  return async ({ runIds, limit }) => {
    if (runIds.length === 0) return []
    const { rows } = await pool.query<{ id: string; cost: string }>(sql, [runIds, limit])
    return rows.map((row) => ({ runId: row.id, cost: Number(row.cost) }))
  }
}

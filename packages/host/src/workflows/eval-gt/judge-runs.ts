import type { Pool } from 'pg'

/** One `cap.eval.judge` run below an eval run: the judge's input and, once done, its answer (both unvalidated JSON). */
export interface JudgeRun {
  runId: string
  /** The eval run it sits under. */
  evalRunId: string
  input: unknown
  output: unknown
}

/** What the owner pack reads of the journal; production is Postgres, tests pass a fake. */
export interface JudgeRunReader {
  /** Done `cap.eval.judge` runs that are descendants of any of `evalRunIds`, oldest first. */
  judgeRuns(evalRunIds: string[]): Promise<JudgeRun[]>
}

export const JUDGE_WORKFLOW = 'cap.eval.judge'

export function pgJudgeRuns(pool: Pick<Pool, 'query'>, schema: string): JudgeRunReader {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error(`invalid schema name "${schema}"`)
  const runs = `"${schema}".runs`
  return {
    async judgeRuns(evalRunIds) {
      if (evalRunIds.length === 0) return []
      const { rows } = await pool.query<{ id: string; eval_run: string; input: unknown; output: unknown }>(
        `with recursive tree as (
           select id, id as eval_run from ${runs} where id = any($1::text[])
           union all
           select r.id, t.eval_run from ${runs} r join tree t on r.parent_id = t.id)
         select r.id, t.eval_run, r.input, r.output
           from tree t join ${runs} r on r.id = t.id
          where r.workflow = $2 and r.status = 'done'
          order by r.started_at, r.id`,
        [evalRunIds, JUDGE_WORKFLOW],
      )
      return rows.map((r) => ({ runId: r.id, evalRunId: r.eval_run, input: r.input, output: r.output }))
    },
  }
}

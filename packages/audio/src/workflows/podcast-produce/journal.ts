import type { Queryable } from '../podcast/history.ts'
import type { Spent } from '../podcast/ports.ts'

// What production reads from the journal: the show's episode count (the MP3 track number), its own recorded spend
// (the output's `cost`, never summed in memory), and, for `podcast-publish`, a finished production's journaled steps.

/** A finished `podcast.produce` run as `podcast-publish` reads it back: its input and its step outputs. */
export interface ProducedRun {
  /** The `podcast.produce` run. */
  id: string
  input: unknown
  /** Step id → journaled output (`plan`, `cover`, `master`, `publish`, `brain-note`). */
  steps: Record<string, unknown>
}

export interface ProduceJournal {
  /** Finished episodes of `series` so far: done root `podcast` runs of purpose `prod` plus the imported legacy ones. */
  episodesInSeries(series: string): Promise<number>
  /** The spend recorded on this run's steps and its children's (the per-unit synth runs). */
  runCost(runId: string): Promise<Spent>
  /**
   * The spend of the whole episode `runId` belongs to: every run under its root (the room, this run, its units), as the
   * room's `produceUsd` reads it. Research runs are roots of their own and not in it, as legacy's `costUsd` was not.
   */
  episodeCost(runId: string): Promise<Spent>
  /** The newest done `podcast.produce` run that is `runId` itself or a child of the `podcast` run `runId`; else null. */
  producedRun(runId: string): Promise<ProducedRun | null>
}

export const PRODUCE_WORKFLOW_ID = 'podcast.produce'

export function postgresProduceJournal(db: Queryable, schema: string): ProduceJournal {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error(`invalid journal schema name "${schema}"`)
  const s = `"${schema}"`
  return {
    async episodesInSeries(series) {
      const { rows } = await db.query<{ n: number | string }>(
        `select (select count(*) from ${s}.runs r
                  where r.workflow = 'podcast' and r.status = 'done' and r.parent_id is null and r.purpose = 'prod'
                    and r.input->>'series' = $1)
              + (select count(*) from ${s}.podcast_episodes e where e.series = $1) as n`,
        [series],
      )
      return Number(rows[0]?.n ?? 0)
    },
    async runCost(runId) {
      const { rows } = await db.query<{ usd: number | string | null; unpriced: number | string | null }>(
        `select coalesce(sum(st.cost), 0)::float8 as usd, coalesce(sum(st.unpriced_calls), 0)::int as unpriced
           from ${s}.steps st join ${s}.runs r on r.id = st.run_id
          where r.id = $1 or r.parent_id = $1`,
        [runId],
      )
      return { usd: Number(rows[0]?.usd ?? 0), unpriced: Number(rows[0]?.unpriced ?? 0) }
    },
    async episodeCost(runId) {
      const { rows } = await db.query<{ usd: number | string | null; unpriced: number | string | null }>(
        `select coalesce(sum(st.cost), 0)::float8 as usd, coalesce(sum(st.unpriced_calls), 0)::int as unpriced
           from ${s}.steps st join ${s}.runs r on r.id = st.run_id
          where r.root_id = (select root_id from ${s}.runs where id = $1)`,
        [runId],
      )
      return { usd: Number(rows[0]?.usd ?? 0), unpriced: Number(rows[0]?.unpriced ?? 0) }
    },
    async producedRun(runId) {
      const runs = await db.query<{ id: string; input: unknown }>(
        `select id, input from ${s}.runs
          where workflow = $1 and status = 'done' and (id = $2 or parent_id = $2)
          order by created_at desc limit 1`,
        [PRODUCE_WORKFLOW_ID, runId],
      )
      const run = runs.rows[0]
      if (!run) return null
      const steps = await db.query<{ step_id: string; output: unknown }>(
        `select step_id, output from ${s}.steps where run_id = $1 and status = 'done'`,
        [run.id],
      )
      return { id: run.id, input: run.input, steps: Object.fromEntries(steps.rows.map((r) => [r.step_id, r.output])) }
    },
  }
}

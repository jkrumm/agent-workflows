import type { Pool } from 'pg'

/** One agent or code step of a sampled run, as small as it can be while still telling what happened. */
export interface SampledStep {
  stepId: string
  kind: string
  status: string
  model: string | null
  toolCalls: number
  cost: number | null
  errorKind: string | null
  error: string | null
  /** The step's output as JSON text, cut. Null when the step produced none. */
  output: string | null
}

export interface SampledRun {
  runId: string
  status: string
  fingerprint: string | null
  wallMs: number | null
  cost: number | null
  toolCalls: number | null
  /** `runs.friction` once the friction counters fill it; null before. */
  friction: unknown
  errorKind: string | null
  error: string | null
  steps: SampledStep[]
}

export interface SampleQuery {
  workflow: string
  since: Date
  limit: number
}

/** What the retrospective reads of the journal; production is Postgres, tests may pass a fake. */
export interface JournalReader {
  /** Finished (done or failed) top-level runs of the workflow since `since`, eval runs excluded. */
  sample(query: SampleQuery): Promise<SampledRun[]>
  /** How many such runs there are, for the weekly "had runs" check. */
  countFinished(query: Pick<SampleQuery, 'workflow' | 'since'>): Promise<number>
  /** The retrospective runs of one week and workflow: the base key and its `:retry-<n>` keys. */
  weekRuns(key: string): Promise<{ key: string; status: string }[]>
}

/** Run inputs are never read: they hold working directories and diffs, and the repo is public. */
const OUTPUT_PREVIEW_CHARS = 1200

type RunRow = {
  id: string
  status: string
  fingerprint: string | null
  wall_ms: number | null
  cost: string | null
  tool_calls: number | null
  friction: unknown
  error_kind: string | null
  error: string | null
}
type StepRow = {
  run_id: string
  step_id: string
  kind: string
  status: string
  model: string | null
  tool_calls: number
  cost: string | null
  error_kind: string | null
  error: string | null
  output: string | null
}

const FINISHED = `parent_id is null and status in ('done', 'failed') and purpose <> 'eval' and finished_at >= $2 and workflow = $1`

/**
 * Failed runs first (they teach the most), then the rest in a stable spread by id hash, so the sample is not just the
 * last hour. The same window and limit read the same runs.
 */
export function pgJournalReader(pool: Pick<Pool, 'query'>, schema: string): JournalReader {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error(`invalid schema name "${schema}"`)
  const runs = `"${schema}".runs`
  const steps = `"${schema}".steps`
  return {
    async sample({ workflow, since, limit }) {
      const { rows } = await pool.query<RunRow>(
        `select id, status, fingerprint, wall_ms, cost::text as cost, tool_calls, friction, error_kind, error
           from ${runs} where ${FINISHED}
          order by (status = 'failed') desc, md5(id) limit $3`,
        [workflow, since, limit],
      )
      if (rows.length === 0) return []
      const ids = rows.map((r) => r.id)
      const found = await pool.query<StepRow>(
        `select run_id, step_id, kind, status, model, tool_calls, cost::text as cost, error_kind, error,
                left(output::text, ${OUTPUT_PREVIEW_CHARS}) as output
           from ${steps} where run_id = any($1::text[]) order by started_at`,
        [ids],
      )
      const byRun = new Map<string, SampledStep[]>()
      for (const s of found.rows) {
        const list = byRun.get(s.run_id) ?? []
        list.push({
          stepId: s.step_id,
          kind: s.kind,
          status: s.status,
          model: s.model,
          toolCalls: s.tool_calls,
          cost: s.cost === null ? null : Number(s.cost),
          errorKind: s.error_kind,
          error: s.error,
          output: s.output,
        })
        byRun.set(s.run_id, list)
      }
      return rows.map((r) => ({
        runId: r.id,
        status: r.status,
        fingerprint: r.fingerprint,
        wallMs: r.wall_ms,
        cost: r.cost === null ? null : Number(r.cost),
        toolCalls: r.tool_calls,
        friction: r.friction,
        errorKind: r.error_kind,
        error: r.error,
        steps: byRun.get(r.id) ?? [],
      }))
    },
    async weekRuns(key) {
      const { rows } = await pool.query<{ key: string; status: string }>(
        `select idempotency_key as key, status from ${runs}
          where workflow = 'retrospective' and (idempotency_key = $1 or idempotency_key like $2)`,
        [key, `${key.replaceAll(/[\\%_]/g, '\\$&')}:retry-%`],
      )
      return rows
    },
    async countFinished({ workflow, since }) {
      const { rows } = await pool.query<{ n: number }>(`select count(*)::int as n from ${runs} where ${FINISHED}`, [
        workflow,
        since,
      ])
      return rows[0]?.n ?? 0
    },
  }
}

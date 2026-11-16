import type { Pool } from 'pg'

/** One tool a step called, as the host's tool gate recorded it: how often, how often it failed, how many calls repeated an earlier one's exact arguments. */
export interface SampledTool {
  tool: string
  calls: number
  failed: number
  repeats: number
}

/** One agent or code step of a sampled run, as small as it can be while still telling what happened. */
export interface SampledStep {
  stepId: string
  kind: string
  status: string
  model: string | null
  toolCalls: number
  /**
   * The tools by name, most called first. Only a step whose tools run through the host's gate leaves a record (research:
   * `research_tool_calls`); for every other step it is empty and only `toolCalls` says anything.
   */
  tools: SampledTool[]
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

type ToolRow = { run_id: string; step_id: string; tool: string; calls: number; failed: number; repeats: number }

const FINISHED = `parent_id is null and status in ('done', 'failed') and purpose <> 'eval' and finished_at >= $2 and workflow = $1`

/**
 * Failed runs first (they teach the most), then the rest in a stable spread by id hash, so the sample is not just the
 * last hour. The same window and limit read the same runs.
 */
export function pgJournalReader(pool: Pick<Pool, 'query'>, schema: string): JournalReader {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error(`invalid schema name "${schema}"`)
  const runs = `"${schema}".runs`
  const steps = `"${schema}".steps`
  const toolCalls = `"${schema}".research_tool_calls`
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
      const calls = await pool.query<ToolRow>(
        `select run_id, step_id, tool, count(*)::int as calls, (count(*) filter (where not ok))::int as failed,
                (count(*) - count(distinct args_digest))::int as repeats
           from ${toolCalls} where run_id = any($1::text[])
          group by run_id, step_id, tool order by run_id, step_id, calls desc, tool`,
        [ids],
      )
      const toolsOf = new Map<string, SampledTool[]>()
      for (const t of calls.rows) {
        const key = `${t.run_id}\n${t.step_id}`
        toolsOf.set(key, [
          ...(toolsOf.get(key) ?? []),
          { tool: t.tool, calls: t.calls, failed: t.failed, repeats: t.repeats },
        ])
      }
      const byRun = new Map<string, SampledStep[]>()
      for (const s of found.rows) {
        const list = byRun.get(s.run_id) ?? []
        list.push({
          stepId: s.step_id,
          kind: s.kind,
          status: s.status,
          model: s.model,
          toolCalls: s.tool_calls,
          tools: toolsOf.get(`${s.run_id}\n${s.step_id}`) ?? [],
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

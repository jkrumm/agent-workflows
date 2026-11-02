import type { Logger, Middleware, RunScores, TokenCounts } from '@agent-workflows/runtime'
import { type JournalDb, withRetry } from './db.ts'
import type { Friction } from './friction.ts'
import { traceIdForRun } from './ids.ts'

/** The run-level record written onto the run row at `runPost` (concept §5). */
export type RunRecord = {
  runId: string
  wallMs: number | null
  tokens: TokenCounts
  /**
   * The priced usage of the run's steps and of every descendant run's steps (by `parent_id`, each step once), so a
   * root carries its tree's total. The sum of the known costs when any step has a positive one; else null when
   * some step's cost is unknown (null) or any call was unpriced (a priced-zero call beside an unpriced one is not
   * free); else 0: every step free, and also a run with no step rows (nothing ran, nothing spent). A lower bound
   * while `unpricedCalls > 0`.
   */
  cost: number | null
  /** Unpriced calls of the run's steps and its descendants'. */
  unpricedCalls: number
  toolCalls: number
  traceId: string
  /** `runs.scores` as the run ended: the inline gate verdicts; a regression or drift score lands later (concept §6). */
  scores: RunScores | null
  /** The run's friction counters (`frictionMiddleware` runs before this one); null when none were written. */
  friction: Friction | null
}

type Sums = {
  tokens_input: string
  tokens_output: string
  tokens_cache_read: string
  tokens_cache_write: string
  tokens_reasoning: string
  cost: string | null
  unpriced_calls: string
  tool_calls: string
  wall_ms: number | null
  scores: RunScores | null
  friction: Friction | null
}

/**
 * At `runPost`: wall time (from the run row's `started_at`/`finished_at`, so every delivery computes the same; null
 * for a run that never started), the run's own steps summed (tokens, tool calls), and the trace id. `cost` and
 * `unpricedCalls` are summed over the step rows of the run and every descendant (fan-out children, parented starts
 * such as eval case runs and their judge calls, recursively by `parent_id`), each step once: they never wait on a
 * child's own record, so a child whose `runPost` lands late still counts. A root therefore carries its tree's spend;
 * a tree sum over `runs.cost` counts the root alone, or the steps. Recomputed from the step rows and overwritten each
 * time, so a re-delivered `runPost` writes the same record (and picks up a step a late child wrote since).
 */
export function recordMiddleware(options: {
  db: JournalDb
  logger: Logger
  onRecord?: (record: RunRecord) => void
}): Middleware {
  const { db } = options
  return {
    name: 'record',
    async runPost(args) {
      const traceId = traceIdForRun(args)
      const sums = await withRetry(async () => {
        const { rows } = await db.pool.query<Sums>(
          `with recursive s as (
             select coalesce(sum(tokens_input), 0) as tokens_input, coalesce(sum(tokens_output), 0) as tokens_output,
               coalesce(sum(tokens_cache_read), 0) as tokens_cache_read,
               coalesce(sum(tokens_cache_write), 0) as tokens_cache_write,
               coalesce(sum(tokens_reasoning), 0) as tokens_reasoning, coalesce(sum(tool_calls), 0) as tool_calls
             from ${db.steps} where run_id = $1
           ), tree as (
             select id from ${db.runs} where id = $1
             union all
             select c.id from ${db.runs} c join tree on c.parent_id = tree.id
           ), t as (
             select case
                 when coalesce(sum(st.cost), 0) > 0 then sum(st.cost)
                 when count(*) filter (where st.cost is null) > 0 or coalesce(sum(st.unpriced_calls), 0) > 0 then null
                 else 0 end as cost,
               coalesce(sum(st.unpriced_calls), 0) as unpriced_calls
             from ${db.steps} st join tree on st.run_id = tree.id
           )
           update ${db.runs} r set trace_id = $2,
             wall_ms = case when r.started_at is null or r.finished_at is null then null
               else greatest(0, floor(extract(epoch from (r.finished_at - r.started_at)) * 1000))::integer end,
             tokens_input = s.tokens_input, tokens_output = s.tokens_output,
             tokens_cache_read = s.tokens_cache_read, tokens_cache_write = s.tokens_cache_write,
             tokens_reasoning = s.tokens_reasoning,
             cost = t.cost, unpriced_calls = t.unpriced_calls, tool_calls = s.tool_calls,
             updated_at = now()
           from s, t where r.id = $1
           returning s.tokens_input, s.tokens_output, s.tokens_cache_read, s.tokens_cache_write, s.tokens_reasoning,
             r.cost, r.unpriced_calls, s.tool_calls, r.wall_ms, r.scores, r.friction`,
          [args.runId, traceId],
        )
        return rows[0]
      })
      if (!sums) {
        options.logger.error('run record: run row not found', { runId: args.runId })
        return
      }
      options.onRecord?.({
        runId: args.runId,
        wallMs: sums.wall_ms,
        tokens: {
          input: Number(sums.tokens_input),
          output: Number(sums.tokens_output),
          cacheRead: Number(sums.tokens_cache_read),
          cacheWrite: Number(sums.tokens_cache_write),
          reasoning: Number(sums.tokens_reasoning),
        },
        cost: sums.cost === null ? null : Number(sums.cost),
        unpricedCalls: Number(sums.unpriced_calls),
        toolCalls: Number(sums.tool_calls),
        traceId,
        scores: sums.scores,
        friction: sums.friction,
      })
    },
  }
}

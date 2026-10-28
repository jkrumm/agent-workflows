import type { Logger, Middleware, RunScores, TokenCounts } from '@agent-workflows/runtime'
import { type JournalDb, withRetry } from './db.ts'
import { traceIdForRun } from './ids.ts'

/** The run-level record written onto the run row at `runPost` (concept §5). */
export type RunRecord = {
  runId: string
  wallMs: number | null
  tokens: TokenCounts
  /** Sum of the priced usage; null when nothing was priced. A lower bound while `unpricedCalls > 0`. */
  cost: number | null
  unpricedCalls: number
  toolCalls: number
  traceId: string
  /** `runs.scores` as the run ended: the inline gate verdicts; a regression or drift score lands later (concept §6). */
  scores: RunScores | null
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
}

/**
 * At `runPost`: wall time (from the run row's `started_at`/`finished_at`, so every delivery computes the same; null
 * for a run that never started), the run's own steps summed (a fan-out's children carry their own records; sum by
 * `root_id` for a tree), unpriced and tool calls, and the trace id. Recomputed from the step rows and overwritten
 * each time, so a re-delivered `runPost` writes the same record.
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
          `with s as (
             select coalesce(sum(tokens_input), 0) as tokens_input, coalesce(sum(tokens_output), 0) as tokens_output,
               coalesce(sum(tokens_cache_read), 0) as tokens_cache_read,
               coalesce(sum(tokens_cache_write), 0) as tokens_cache_write,
               coalesce(sum(tokens_reasoning), 0) as tokens_reasoning, sum(cost) as cost,
               coalesce(sum(unpriced_calls), 0) as unpriced_calls, coalesce(sum(tool_calls), 0) as tool_calls
             from ${db.steps} where run_id = $1
           )
           update ${db.runs} r set trace_id = $2,
             wall_ms = case when r.started_at is null or r.finished_at is null then null
               else greatest(0, floor(extract(epoch from (r.finished_at - r.started_at)) * 1000))::integer end,
             tokens_input = s.tokens_input, tokens_output = s.tokens_output,
             tokens_cache_read = s.tokens_cache_read, tokens_cache_write = s.tokens_cache_write,
             tokens_reasoning = s.tokens_reasoning, cost = s.cost,
             unpriced_calls = s.unpriced_calls, tool_calls = s.tool_calls,
             updated_at = now()
           from s where r.id = $1
           returning s.*, r.wall_ms, r.scores`,
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
      })
    },
  }
}

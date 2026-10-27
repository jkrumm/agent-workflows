import { hostname } from 'node:os'
import type { Logger, ModelUsage, Tokens } from '@agent-workflows/runtime'
import { z } from 'zod'
import { errorMessage, type JournalDb } from './db.ts'
import { traceIdForRun } from './ids.ts'
import { hasPurpose } from './purpose.ts'

/** Argo's `UsageRecordInputSchema` (argo `apps/api/src/routes/usage.ts`), copied verbatim; the contract of the port. */
export const ArgoUsageRecordInput = z.object({
  source: z.string(),
  source_id: z.string(),
  grain: z.string(),
  ts: z.string().describe('ISO 8601 timestamp'),
  model: z.string().nullable(),
  model_norm: z.string().nullable(),
  project: z.string().nullable(),
  workspace: z.string().nullable().optional(),
  sub_tool: z.string().nullable(),
  machine: z.string().nullable(),
  billing: z.string(),
  account: z.string().nullable().optional(),
  outcome: z.string().default('ok'),
  input_tokens: z.number().int().default(0),
  output_tokens: z.number().int().default(0),
  cache_read_tokens: z.number().int().default(0),
  cache_write_tokens: z.number().int().default(0),
  reasoning_tokens: z.number().int().default(0),
  duration_ms: z.number().int().nullable(),
  cost_usd: z.number().nullable(),
  cost_source: z.string().default('none'),
  raw: z.unknown().nullable(),
  ingested_at: z.string().describe('Source-local ingest time, ISO 8601'),
})

export type ArgoUsageRecord = z.input<typeof ArgoUsageRecordInput>

/** Argo accepts 1–1000 records per call. */
export const ARGO_MAX_BATCH = 1000

/** The usage ingest. Throws when Argo did not accept the batch; Argo upserts on `(source, source_id, machine)`. */
export type ArgoTransport = { post(records: ArgoUsageRecord[]): Promise<void> }

/** `POST <url>/usage/records` with the bearer `API_SECRET`, as email-gateway and usage-tracker do. */
export function httpArgoTransport(options: { url: string; token: string; timeoutMs?: number }): ArgoTransport {
  const endpoint = `${options.url.replace(/\/+$/, '')}/usage/records`
  return {
    async post(records) {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ records }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
      })
      if (!res.ok) throw new Error(`argo usage ingest: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`)
    },
  }
}

/** `ARGO_URL` (base, e.g. `https://argo.<your-domain>/api`) and `ARGO_API_SECRET`; null when either is unset. */
export function argoTransportFromEnv(env: Record<string, string | undefined> = process.env): ArgoTransport | null {
  const url = env.ARGO_URL?.trim()
  const token = env.ARGO_API_SECRET?.trim()
  return url && token ? httpArgoTransport({ url, token }) : null
}

/** One finished step of a finished run, as the outbox reads it. */
export type OutboxStep = {
  runId: string
  stepId: string
  status: string
  model: string | null
  tokens: Tokens
  cost: number | null
  toolCalls: number
  unpricedCalls: number
  byModel: Record<string, ModelUsage> | null
  startedAt: Date
  finishedAt: Date | null
  sessionId: string | null
  run: {
    workflowId: string
    rootId: string
    purpose: string
    traceparent: string | null
    traceId: string | null
    fingerprint: string | null
    friction: unknown
    status: string
    errorKind: string | null
    wallMs: number | null
  }
}

export type ArgoRowOptions = { machine: string; billing?: string; workspace?: string; now?: Date }

/**
 * Raw provider counts → Argo's additive contract: `input` fresh uncached input only, `output` without reasoning
 * (Argo adds `reasoning` on top). Provider usage is not additive; skipping this double-counts reasoning and cache.
 */
export function additiveTokens(tokens: Tokens) {
  return {
    input_tokens: Math.max(0, tokens.input - tokens.cacheRead),
    output_tokens: Math.max(0, tokens.output - tokens.reasoning),
    cache_read_tokens: tokens.cacheRead,
    cache_write_tokens: 0,
    reasoning_tokens: tokens.reasoning,
  }
}

const zero = (): Tokens => ({ input: 0, output: 0, cacheRead: 0, reasoning: 0 })
const spent = (t: Tokens) => t.input + t.output + t.cacheRead + t.reasoning > 0

type ModelRow = { model: string; tokens: Tokens; cost: number | null; toolCalls: number }

/**
 * One entry per model; usage reported without a model is the step total minus the per-model split, posted as
 * `unknown` (or as the step's model when nothing was split).
 */
function perModel(step: OutboxStep): ModelRow[] {
  const rows: ModelRow[] = Object.entries(step.byModel ?? {}).map(([model, u]) => ({
    model,
    tokens: u.tokens,
    cost: u.cost,
    toolCalls: u.toolCalls,
  }))
  const tokens = zero()
  for (const key of ['input', 'output', 'cacheRead', 'reasoning'] as const) {
    tokens[key] = step.tokens[key] - rows.reduce((sum, r) => sum + r.tokens[key], 0)
  }
  const splitCost = rows.reduce((sum, r) => sum + (r.cost ?? 0), 0)
  const restCost = step.cost === null || Math.abs(step.cost - splitCost) < 1e-12 ? null : step.cost - splitCost
  const rest: ModelRow = {
    model: rows.length === 0 ? (step.model ?? 'unknown') : 'unknown',
    tokens,
    cost: rows.length === 0 ? step.cost : restCost,
    toolCalls: step.toolCalls - rows.reduce((sum, r) => sum + r.toolCalls, 0),
  }
  return [...rows, rest].filter((r) => spent(r.tokens) || (r.cost ?? 0) > 0)
}

/** One Argo `usage_record` per step and model (concept §5); none for a step that spent nothing. */
export function argoRowsForStep(step: OutboxStep, options: ArgoRowOptions): ArgoUsageRecord[] {
  const { run } = step
  if (!hasPurpose(run.purpose)) throw new Error(`run ${step.runId}: a run without a purpose cannot exist`)
  const outcome = step.status !== 'done' || run.errorKind === 'invalid_output' ? 'error' : 'ok'
  const durationMs = step.finishedAt ? Math.max(0, step.finishedAt.getTime() - step.startedAt.getTime()) : null
  const ingestedAt = (options.now ?? new Date()).toISOString()
  return perModel(step).map(({ model, ...usage }) => ({
    source: 'agent-workflows',
    source_id: `${step.runId}:${step.stepId}:${model}`,
    grain: 'step',
    ts: step.startedAt.toISOString(),
    model,
    model_norm: model,
    project: null,
    workspace: options.workspace ?? 'private',
    sub_tool: run.workflowId,
    machine: options.machine,
    billing: options.billing ?? 'iu',
    account: null,
    outcome,
    ...additiveTokens(usage.tokens),
    duration_ms: durationMs,
    cost_usd: usage.cost,
    cost_source: usage.cost === null ? 'none' : 'reported',
    raw: {
      runId: step.runId,
      stepId: step.stepId,
      rootId: run.rootId,
      purpose: run.purpose,
      fingerprint: run.fingerprint,
      traceId: run.traceId ?? traceIdForRun(run),
      sessionId: step.sessionId,
      toolCalls: usage.toolCalls,
      unpricedCalls: step.unpricedCalls,
      runOutcome: run.errorKind ?? run.status,
      runWallMs: run.wallMs,
      scores: null,
      friction: run.friction ?? null,
    },
    ingested_at: ingestedAt,
  }))
}

type OutboxRow = {
  run_id: string
  step_id: string
  status: string
  model: string | null
  tokens_input: string
  tokens_output: string
  tokens_cache_read: string
  tokens_reasoning: string
  cost: string | null
  tool_calls: number
  unpriced_calls: number
  usage_by_model: Record<string, ModelUsage> | null
  started_at: Date
  finished_at: Date | null
  session_id: string | null
  workflow: string
  root_id: string
  purpose: string
  traceparent: string | null
  trace_id: string | null
  fingerprint: string | null
  friction: unknown
  run_status: string
  run_error_kind: string | null
  wall_ms: number | null
}

function toOutboxStep(row: OutboxRow): OutboxStep {
  return {
    runId: row.run_id,
    stepId: row.step_id,
    status: row.status,
    model: row.model,
    tokens: {
      input: Number(row.tokens_input),
      output: Number(row.tokens_output),
      cacheRead: Number(row.tokens_cache_read),
      reasoning: Number(row.tokens_reasoning),
    },
    cost: row.cost === null ? null : Number(row.cost),
    toolCalls: row.tool_calls,
    unpricedCalls: row.unpriced_calls,
    byModel: row.usage_by_model,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    sessionId: row.session_id,
    run: {
      workflowId: row.workflow,
      rootId: row.root_id,
      purpose: row.purpose,
      traceparent: row.traceparent,
      traceId: row.trace_id,
      fingerprint: row.fingerprint,
      friction: row.friction,
      status: row.run_status,
      errorKind: row.run_error_kind,
      wallMs: row.wall_ms,
    },
  }
}

export type OutboxOptions = {
  db: JournalDb
  transport: ArgoTransport
  logger: Logger
  /** Argo's `machine` (part of its upsert key). Default `AGW_MACHINE`, else the host name. */
  machine?: string
  /** Default `iu` (every platform route is IU API, S2 gap 11). */
  billing?: string
  /** Steps per batch (rows can be more: one per model). Default 200. */
  batchSize?: number
  /** Backoff after a failed post: first delay, doubled per failure up to `maxMs`. Default 5 s / 5 min. */
  backoff?: { baseMs: number; maxMs: number }
  now?: () => number
}

export type FlushResult = {
  /** Argo rows accepted. */
  posted: number
  /** Steps marked synced (with rows or with nothing to post). */
  marked: number
  /** Why nothing was tried: still backing off after a failure. */
  skipped: 'backoff' | null
  error: string | null
}

/**
 * Posts finished steps of finished runs to Argo and marks them `argo_synced_at` only after Argo accepted the batch.
 * Each batch is selected `for update skip locked` and marked in the same transaction, so concurrent flushers (this
 * process or another) never post a step twice; a failed post rolls back, backs off, and the next `flush()` after
 * the delay retries the same rows. A crash after the post and before the commit re-posts them, which Argo's upsert
 * on `(source, source_id, machine)` absorbs. Steps without usage are marked without a row.
 */
export class ArgoOutbox {
  private failures = 0
  private nextAt = 0
  private inflight: Promise<FlushResult> | null = null
  private readonly machine: string
  private readonly batchSize: number
  private readonly now: () => number

  constructor(private readonly options: OutboxOptions) {
    this.machine = options.machine ?? process.env.AGW_MACHINE ?? hostname()
    this.batchSize = options.batchSize ?? 200
    this.now = options.now ?? Date.now
  }

  flush(): Promise<FlushResult> {
    this.inflight ??= this.drain().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  private async drain(): Promise<FlushResult> {
    const result: FlushResult = { posted: 0, marked: 0, skipped: null, error: null }
    if (this.now() < this.nextAt) return { ...result, skipped: 'backoff' }
    for (;;) {
      try {
        const batch = await this.batch()
        result.posted += batch.posted
        result.marked += batch.marked
        this.failures = 0
        this.nextAt = 0
        if (batch.selected < this.batchSize) return result
      } catch (err) {
        this.failures++
        const { baseMs, maxMs } = this.options.backoff ?? { baseMs: 5000, maxMs: 300_000 }
        const delay = Math.min(maxMs, baseMs * 2 ** (this.failures - 1))
        this.nextAt = this.now() + delay
        result.error = errorMessage(err)
        this.options.logger.warn('argo outbox: flush failed; retried after backoff', {
          error: result.error,
          failures: this.failures,
          retryInMs: delay,
        })
        return result
      }
    }
  }

  private async batch(): Promise<{ selected: number; posted: number; marked: number }> {
    const { db } = this.options
    const client = await db.pool.connect()
    try {
      await client.query('begin')
      const { rows } = await client.query<OutboxRow>(
        `select s.run_id, s.step_id, s.status, s.model, s.tokens_input, s.tokens_output, s.tokens_cache_read,
           s.tokens_reasoning, s.cost, s.tool_calls, s.unpriced_calls, s.usage_by_model, s.started_at,
           s.finished_at, s.handle->'handle'->>'sessionId' as session_id,
           r.workflow, r.root_id, r.purpose, r.traceparent, r.trace_id, r.fingerprint, r.friction,
           r.status as run_status, r.error_kind as run_error_kind, r.wall_ms
         from ${db.steps} s join ${db.runs} r on r.id = s.run_id
         where s.argo_synced_at is null and s.status in ('done', 'failed', 'cancelled')
           and r.status in ('done', 'failed', 'cancelled')
         order by s.finished_at, s.run_id, s.step_id
         limit $1
         for update of s skip locked`,
        [this.batchSize],
      )
      const now = new Date(this.now())
      const records = rows.flatMap((row) =>
        argoRowsForStep(toOutboxStep(row), { machine: this.machine, billing: this.options.billing, now }),
      )
      for (let i = 0; i < records.length; i += ARGO_MAX_BATCH) {
        await this.options.transport.post(records.slice(i, i + ARGO_MAX_BATCH))
      }
      if (rows.length > 0) {
        await client.query(
          `update ${db.steps} s set argo_synced_at = now()
           from unnest($1::text[], $2::text[]) as k(run_id, step_id)
           where s.run_id = k.run_id and s.step_id = k.step_id`,
          [rows.map((r) => r.run_id), rows.map((r) => r.step_id)],
        )
      }
      await client.query('commit')
      return { selected: rows.length, posted: records.length, marked: rows.length }
    } catch (err) {
      await client.query('rollback').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  }
}

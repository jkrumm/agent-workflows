import { hostname } from 'node:os'
import type { Logger, ModelUsage, TokenCounts } from '@agent-workflows/runtime'
import { z } from 'zod'
import { errorMessage, type JournalDb } from './db.ts'
import { traceIdForRun } from './ids.ts'
import { IU_KEY_IDS, type IuKeyId, isIuKeyId } from './iu-key.ts'
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
  // Not in Argo's schema yet: Argo gains `iu_key` per the usage-tracker contract ("IU keys"). Until then its zod
  // object strips it, so posting it is harmless; a missing field means `personal` on Argo's side.
  iu_key: z.enum(IU_KEY_IDS).nullable().optional(),
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

/**
 * A post Argo answered. `permanent`: Argo refused the rows themselves (400, 422), so retrying them as they are can
 * never succeed. Every other status (401/403/404 config or auth trouble, 408, 429, 5xx) and anything else a
 * transport throws (network, timeout, redirect) is transient: the rows are fine, the path to Argo is not.
 */
export class ArgoPostError extends Error {
  override name = 'ArgoPostError'
  constructor(
    message: string,
    readonly permanent: boolean,
    readonly status: number | null = null,
  ) {
    super(message)
  }
}

/** Only a row refusal is permanent; auth, routing and availability problems are transient. */
export function isRowRefusal(status: number): boolean {
  return status === 400 || status === 422
}

/** The usage ingest. Throws when Argo did not accept the batch; Argo upserts on `(source, source_id, machine)`. */
export type ArgoTransport = { post(records: ArgoUsageRecord[]): Promise<void> }

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/**
 * `POST <url>/usage/records` with the bearer `API_SECRET`, as email-gateway and usage-tracker do. Refuses a
 * non-https URL unless it is loopback: the bearer must never cross a network in clear text.
 */
export function httpArgoTransport(options: { url: string; token: string; timeoutMs?: number }): ArgoTransport {
  const base = new URL(options.url)
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && LOOPBACK.has(base.hostname))) {
    throw new Error(`ARGO_URL must be https (or http on loopback), got ${base.protocol}//${base.hostname}`)
  }
  const endpoint = `${options.url.replace(/\/+$/, '')}/usage/records`
  return {
    async post(records) {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ records }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
        // A redirect would re-send the bearer to wherever it points.
        redirect: 'error',
      })
      if (res.ok) return
      const body = (await res.text()).slice(0, 300)
      throw new ArgoPostError(`argo usage ingest: HTTP ${res.status} ${body}`, isRowRefusal(res.status), res.status)
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
  tokens: TokenCounts
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
    /** The label of the IU key the host that admitted the run held; rows stored before it read `personal`. */
    iuKey: IuKeyId
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
 * Raw provider counts → Argo's additive contract: `input` fresh uncached input only (minus cache reads and cache
 * writes), `output` without reasoning (Argo adds `reasoning` on top). Provider usage is not additive; skipping
 * this double-counts reasoning and cache.
 */
export function additiveTokens(tokens: TokenCounts) {
  return {
    input_tokens: Math.max(0, tokens.input - tokens.cacheRead - tokens.cacheWrite),
    output_tokens: Math.max(0, tokens.output - tokens.reasoning),
    cache_read_tokens: tokens.cacheRead,
    cache_write_tokens: tokens.cacheWrite,
    reasoning_tokens: tokens.reasoning,
  }
}

const BUCKETS = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'] as const
const spent = (t: TokenCounts) => BUCKETS.some((key) => t[key] > 0)
/** A sum stored before the cacheWrite bucket existed reads as 0 there. */
const counts = (t: Partial<TokenCounts>): TokenCounts => ({
  input: t.input ?? 0,
  output: t.output ?? 0,
  cacheRead: t.cacheRead ?? 0,
  cacheWrite: t.cacheWrite ?? 0,
  reasoning: t.reasoning ?? 0,
})

type ModelRow = { model: string; tokens: TokenCounts; cost: number | null; toolCalls: number }

/**
 * One entry per model; usage reported without a model is the step total minus the per-model split (each bucket
 * clamped at 0), posted as `unknown` (or as the step's model when nothing was split) only when it has tokens.
 */
function perModel(step: OutboxStep): ModelRow[] {
  const rows: ModelRow[] = Object.entries(step.byModel ?? {}).map(([model, u]) => ({
    model,
    tokens: counts(u.tokens),
    cost: u.cost,
    toolCalls: u.toolCalls,
  }))
  const tokens = counts({})
  for (const key of BUCKETS) {
    tokens[key] = Math.max(0, step.tokens[key] - rows.reduce((sum, r) => sum + r.tokens[key], 0))
  }
  const splitCost = rows.reduce((sum, r) => sum + (r.cost ?? 0), 0)
  const restCost =
    step.cost === null || Math.abs(step.cost - splitCost) <= 1e-9 * Math.abs(step.cost) ? null : step.cost - splitCost
  const rest: ModelRow = {
    model: rows.length === 0 ? (step.model ?? 'unknown') : 'unknown',
    tokens,
    cost: rows.length === 0 ? step.cost : restCost !== null && restCost > 0 ? restCost : null,
    toolCalls: Math.max(0, step.toolCalls - rows.reduce((sum, r) => sum + r.toolCalls, 0)),
  }
  const keep = (r: ModelRow) => spent(r.tokens) || (r.cost ?? 0) > 0
  const split = rows.filter(keep)
  return keep(rest) ? [...split, rest] : split
}

/** One Argo `usage_record` per step and model (concept §5); none for a step that spent nothing. */
export function argoRowsForStep(step: OutboxStep, options: ArgoRowOptions): ArgoUsageRecord[] {
  const { run } = step
  if (!hasPurpose(run.purpose)) throw new Error(`run ${step.runId}: a run without a purpose cannot exist`)
  const outcome = step.status !== 'done' || run.errorKind === 'invalid_output' ? 'error' : 'ok'
  const durationMs = step.finishedAt ? Math.max(0, step.finishedAt.getTime() - step.startedAt.getTime()) : null
  const ingestedAt = (options.now ?? new Date()).toISOString()
  const billing = options.billing ?? 'iu'
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
    billing,
    account: null,
    // Top level only: never in `raw`, never in `account` (the Max account id).
    iu_key: billing === 'iu' ? run.iuKey : null,
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
  tokens_cache_write: string
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
  iu_key: string
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
      cacheWrite: Number(row.tokens_cache_write),
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
      iuKey: isIuKeyId(row.iu_key) ? row.iu_key : 'personal',
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
  /** Its own pool (not the record's), so a slow Argo can never starve run-path writes. */
  db: JournalDb
  transport: ArgoTransport
  logger: Logger
  /**
   * Argo's `machine`, part of its upsert key `(source, source_id, machine)`: it must be stable across restarts or
   * a re-post lands as a second row. Default `AGW_MACHINE`; unset, the host name with a logged warning.
   */
  machine?: string
  /** Default `iu` (every platform route is IU API, S2 gap 11). */
  billing?: string
  /** Steps per claim. Default 200. */
  batchSize?: number
  /** Backoff after a transient failure: first delay, doubled per failure up to `maxMs`. Default 5 s / 5 min. */
  backoff?: { baseMs: number; maxMs: number }
  /** A post that has not answered by then is a transient failure. Default 30 s. */
  postTimeoutMs?: number
  /** How long a claim holds; renewed before every chunk; an expired claim (a crashed flusher) is claimable again. Default 2 min. */
  claimTtlMs?: number
  /** Records per post. Default (and Argo's maximum) 1000. */
  chunkSize?: number
  now?: () => number
}

export type FlushResult = {
  /** Argo rows accepted. */
  posted: number
  /** Steps marked synced. */
  marked: number
  /** Steps set aside with `argo_error`: a row that cannot be built or that Argo refuses (400, 422). */
  quarantined: number
  /** Why nothing was tried: still backing off after a transient failure. */
  skipped: 'backoff' | null
  /** The transient failure that stopped this flush. */
  error: string | null
}

type Claimed = { step: OutboxStep; records: ArgoUsageRecord[] }
type StepKey = { runId: string; stepId: string }

class Transient extends Error {}

const STEP_COLUMNS = `run_id, step_id, status, model, tokens_input, tokens_output, tokens_cache_read,
  tokens_cache_write, tokens_reasoning, cost, tool_calls, unpriced_calls, usage_by_model, started_at, finished_at`

/**
 * Posts the usage of finished steps to Argo once their run's record is written (`runPost` delivered). No
 * transaction spans a post:
 * 1. claim a batch in one statement (`for update skip locked`, a random `argo_claim` token and an expiry), commit;
 * 2. build and validate the rows, post them outside any transaction;
 * 3. mark the batch synced where the token still matches, in a second short statement.
 * Concurrent flushers never post the same claimed step; a crashed flusher's claim expires; a crash after the post
 * re-posts, which Argo's upsert absorbs. A transient failure releases the claim and backs off. A permanent one (a
 * row that cannot be built, fails Argo's schema or gets a 400/422) quarantines only that step (`argo_error`, logged,
 * counted); the rest keep flowing.
 */
export class ArgoOutbox {
  private failures = 0
  private nextAt = 0
  private inflight: Promise<FlushResult> | null = null
  private closed = false
  private readonly machine: string
  private readonly chunkSize: number
  private readonly batchSize: number
  private readonly postTimeoutMs: number
  private readonly claimTtlMs: number
  private readonly now: () => number

  constructor(private readonly options: OutboxOptions) {
    const machine = options.machine ?? process.env.AGW_MACHINE?.trim()
    if (!machine) {
      options.logger.warn('argo outbox: AGW_MACHINE unset; using the host name as the Argo machine id', {
        machine: hostname(),
      })
    }
    this.machine = machine || hostname()
    this.batchSize = options.batchSize ?? 200
    this.postTimeoutMs = options.postTimeoutMs ?? 30_000
    this.claimTtlMs = options.claimTtlMs ?? 120_000
    if (this.claimTtlMs <= this.postTimeoutMs * 2)
      throw new Error('argo outbox: claimTtlMs must exceed 2× postTimeoutMs')
    this.now = options.now ?? Date.now
    this.chunkSize = Math.min(ARGO_MAX_BATCH, Math.max(1, options.chunkSize ?? ARGO_MAX_BATCH))
  }

  flush(): Promise<FlushResult> {
    if (this.closed) return Promise.resolve({ posted: 0, marked: 0, quarantined: 0, skipped: null, error: 'closed' })
    this.inflight ??= this.drain().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  /** Stops new flushes and waits for the one in flight, so the pool can close under no query. */
  async close(): Promise<void> {
    this.closed = true
    await this.inflight
  }

  /**
   * Puts quarantined steps back into the outbox (all, or one run's) after the cause is fixed. Returns the count.
   */
  async requeue(filter: { runId?: string } = {}): Promise<number> {
    const { db } = this.options
    const { rowCount } = await db.pool.query(
      `update ${db.steps} set argo_error = null
       where argo_error is not null and argo_synced_at is null and ($1::text is null or run_id = $1)`,
      [filter.runId ?? null],
    )
    return rowCount ?? 0
  }

  private async drain(): Promise<FlushResult> {
    const result: FlushResult = { posted: 0, marked: 0, quarantined: 0, skipped: null, error: null }
    if (this.now() < this.nextAt) return { ...result, skipped: 'backoff' }
    for (;;) {
      const token = crypto.randomUUID()
      try {
        const steps = await this.claim(token)
        if (steps.length === 0) break
        const ready: Claimed[] = []
        for (const step of steps) {
          const built = this.build(step)
          if (typeof built === 'string') result.quarantined += await this.quarantine(token, [step], built)
          else ready.push({ step, records: built })
        }
        if (ready.length > 0) await this.send(token, ready, result)
        if (steps.length < this.batchSize) break
      } catch (err) {
        await this.release(token)
        this.failures++
        const { baseMs, maxMs } = this.options.backoff ?? { baseMs: 5000, maxMs: 300_000 }
        const delay = Math.min(maxMs, baseMs * 2 ** (this.failures - 1))
        this.nextAt = this.now() + delay
        result.error = errorMessage(err)
        // A 4xx that is not a row refusal (auth, a wrong URL) needs a human; an outage only needs time.
        const level = err instanceof ArgoPostError && err.status !== null && err.status < 500 ? 'error' : 'warn'
        this.options.logger[level]('argo outbox: flush failed; retried after backoff', {
          error: result.error,
          status: err instanceof ArgoPostError ? err.status : null,
          failures: this.failures,
          retryInMs: delay,
        })
        return result
      }
    }
    this.failures = 0
    this.nextAt = 0
    return result
  }

  private async claim(token: string): Promise<OutboxStep[]> {
    const { db } = this.options
    const { rows } = await db.pool.query<OutboxRow>(
      `with picked as (
         select s.run_id, s.step_id from ${db.steps} s join ${db.runs} r on r.id = s.run_id
         where s.argo_synced_at is null and s.argo_error is null and s.status in ('done', 'failed', 'cancelled')
           and (s.tokens_input > 0 or s.tokens_output > 0 or s.tokens_cache_read > 0 or s.tokens_cache_write > 0
             or s.tokens_reasoning > 0 or s.cost is not null)
           and (s.argo_claimed_until is null or s.argo_claimed_until < now())
           and r.status in ('done', 'failed', 'cancelled') and r.post_hooks_at is not null
         order by s.finished_at, s.run_id, s.step_id
         limit $1
         for update of s skip locked
       ), claimed as (
         update ${db.steps} s set argo_claim = $2, argo_claimed_until = now() + $3 * interval '1 millisecond'
         from picked p where s.run_id = p.run_id and s.step_id = p.step_id
         returning s.*
       )
       select ${STEP_COLUMNS.replaceAll(/(\w+)/g, 'c.$1')}, c.handle->'handle'->>'sessionId' as session_id,
         r.workflow, r.root_id, r.purpose, r.iu_key, r.traceparent, r.trace_id, r.fingerprint, r.friction,
         r.status as run_status, r.error_kind as run_error_kind, r.wall_ms
       from claimed c join ${db.runs} r on r.id = c.run_id
       order by c.finished_at, c.run_id, c.step_id`,
      [this.batchSize, token, this.claimTtlMs],
    )
    return rows.map(toOutboxStep)
  }

  /** The step's rows, validated against Argo's schema; a message when they cannot be built (permanent). */
  private build(step: OutboxStep): ArgoUsageRecord[] | string {
    try {
      const records = argoRowsForStep(step, {
        machine: this.machine,
        billing: this.options.billing,
        now: new Date(this.now()),
      })
      for (const record of records) {
        const parsed = ArgoUsageRecordInput.safeParse(record)
        if (!parsed.success) return `${record.source_id}: ${parsed.error.message.slice(0, 300)}`
      }
      return records
    } catch (err) {
      return errorMessage(err)
    }
  }

  /** Posts the batch; on a permanent refusal, step by step so only the bad ones are quarantined. */
  private async send(token: string, live: Claimed[], result: FlushResult) {
    try {
      await this.post(
        token,
        live.flatMap((c) => c.records),
      )
      await this.mark(token, live, result)
    } catch (err) {
      if (!(err instanceof ArgoPostError && err.permanent)) throw err
      for (const one of live) {
        try {
          await this.post(token, one.records)
          await this.mark(token, [one], result)
        } catch (stepErr) {
          if (!(stepErr instanceof ArgoPostError && stepErr.permanent)) throw stepErr
          result.quarantined += await this.quarantine(token, [one.step], errorMessage(stepErr))
        }
      }
    }
  }

  private async post(token: string, records: ArgoUsageRecord[]) {
    for (let i = 0; i < records.length; i += this.chunkSize) {
      if (i > 0) await this.renew(token)
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          this.options.transport.post(records.slice(i, i + this.chunkSize)),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Transient(`argo post timed out after ${this.postTimeoutMs} ms`)),
              this.postTimeoutMs,
            )
          }),
        ])
      } finally {
        clearTimeout(timer)
      }
    }
  }

  /** Extends the claim before the next chunk, so a long batch never outlives its expiry. */
  private async renew(token: string) {
    await this.options.db.pool.query(
      `update ${this.options.db.steps} set argo_claimed_until = now() + $2 * interval '1 millisecond'
       where argo_claim = $1`,
      [token, this.claimTtlMs],
    )
  }

  private async mark(token: string, done: Claimed[], result: FlushResult) {
    const keys = done.map((c) => c.step)
    const { rowCount } = await this.options.db.pool.query(
      `update ${this.options.db.steps} s set argo_synced_at = now(), argo_claim = null, argo_claimed_until = null
       from unnest($1::text[], $2::text[]) as k(run_id, step_id)
       where s.run_id = k.run_id and s.step_id = k.step_id and s.argo_claim = $3`,
      [keys.map((k) => k.runId), keys.map((k) => k.stepId), token],
    )
    result.posted += done.reduce((sum, c) => sum + c.records.length, 0)
    result.marked += rowCount ?? 0
    if ((rowCount ?? 0) < keys.length) {
      // The claim expired and another flusher took (and will post) these steps; Argo's upsert absorbs the re-post.
      this.options.logger.warn('argo outbox: claim lost before mark; those steps are posted again', {
        claimed: keys.length,
        marked: rowCount ?? 0,
      })
    }
  }

  private async quarantine(token: string, steps: StepKey[], error: string): Promise<number> {
    const { rowCount } = await this.options.db.pool.query(
      `update ${this.options.db.steps} s set argo_error = $3, argo_claim = null, argo_claimed_until = null
       from unnest($1::text[], $2::text[]) as k(run_id, step_id)
       where s.run_id = k.run_id and s.step_id = k.step_id and s.argo_claim = $4`,
      [steps.map((k) => k.runId), steps.map((k) => k.stepId), error.slice(0, 1000), token],
    )
    this.options.logger.error('argo outbox: step quarantined (permanent failure); the rest keep flowing', {
      steps: steps.map((k) => `${k.runId}:${k.stepId}`),
      error,
    })
    return rowCount ?? 0
  }

  /** Gives a failed batch back at once instead of waiting for the claim to expire. */
  private async release(token: string) {
    await this.options.db.pool
      .query(`update ${this.options.db.steps} set argo_claim = null, argo_claimed_until = null where argo_claim = $1`, [
        token,
      ])
      .catch((err: unknown) =>
        this.options.logger.warn('argo outbox: claim release failed; it expires', { error: errorMessage(err) }),
      )
  }
}

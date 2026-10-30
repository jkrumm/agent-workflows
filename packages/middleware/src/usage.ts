import { hostname } from 'node:os'
import type { Logger, ModelUsage, RunScores, TokenCounts } from '@agent-workflows/runtime'
import { DatabaseError, Pool, type PoolClient } from 'pg'
import { errorMessage, type JournalDb } from './db.ts'
import { traceIdForRun } from './ids.ts'
import type { IuKeyId } from './iu-key.ts'
import { isIuKeyId } from './iu-key.ts'
import { hasPurpose } from './purpose.ts'

/**
 * One row of `usage.records` (usage-tracker `migrations/pg/0002_sessions_records.sql`, `docs/usage-schema.md`) as the
 * platform writes it: one per finished step and model, grain `session` (a step is a whole agent loop of many requests,
 * never one message). `cost_usd`, `cost_source`, `price_id`, `session_id` and `ingested_at` are not here: the database
 * derives them (`usage.compute_cost`, the run's session row, the column default).
 */
export type UsageRow = {
  source: 'agent-workflows'
  /** `<runId>:<stepId>:<model>`; with `source` the table's unique key (machine is an attribute). */
  source_id: string
  grain: 'session'
  ts: string
  model_raw: string
  model: string
  /** The project when it is a plain SourceRoot directory slug; null otherwise. */
  repo: string | null
  project_raw: string | null
  workspace: 'work' | 'private' | null
  billing: 'api_key'
  /** The label of the IU key that paid (`personal`, `athena-team`). */
  api_key: IuKeyId
  machine: string
  outcome: 'ok' | 'error'
  lane: 'agw_workflow'
  lane_detail: { workflow: string; step: string; caller: string; purpose: string }
  run_id: string
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_5m_tokens: number
  cache_write_1h_tokens: number
  reasoning_tokens: number
  duration_ms: number | null
  /** What agw measured for this step and model; null when it could not price the usage (never a placeholder 0). */
  cost_reported_usd: number | null
  raw: Record<string, unknown>
}

/** The `usage.sessions` row of a run, derived from its records. */
export type UsageSession = {
  source_session_id: string
  lane_detail: { workflow: string; caller: string; purpose: string }
  api_key: IuKeyId
  machine: string
  model: string
  repo: string | null
  first_ts: string
  last_ts: string
}

/**
 * A write the database answered. `permanent`: it refused the rows themselves (SQLSTATE class 22 data exception, 23
 * integrity constraint), so retrying them as they are can never succeed. Everything else (a refused connection, a
 * timeout, authentication, a missing table, a deadlock) is transient: the rows are fine, the path to them is not.
 */
export class UsageWriteError extends Error {
  override name = 'UsageWriteError'
  constructor(
    message: string,
    readonly permanent: boolean,
    readonly code: string | null = null,
  ) {
    super(message)
  }
}

/** SQLSTATE classes of a row the database refuses: data exception (22) and integrity constraint violation (23). */
const isRowRefusal = (code: string): boolean => code.startsWith('22') || code.startsWith('23')
/** Authentication (28), an absent database (3D), a syntax or access error such as a missing table (42): a human fixes it. */
const needsHuman = (code: string): boolean => /^(28|3D|42)/.test(code)

/** The usage sink: throws when the database did not take the whole batch (rows and their sessions, atomically). */
export type UsageTransport = { write(rows: UsageRow[]): Promise<void>; close?(): Promise<void> }

const SOURCE = 'agent-workflows'

/** Columns `ON CONFLICT` may change on a re-post; `WHERE ... IS DISTINCT FROM` skips the update when none did. */
const RECORD_COLUMNS = [
  'grain',
  'ts',
  'session_id',
  'model_raw',
  'model',
  'repo',
  'project_raw',
  'workspace',
  'billing',
  'api_key',
  'machine',
  'outcome',
  'lane',
  'lane_detail',
  'run_id',
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_write_5m_tokens',
  'cache_write_1h_tokens',
  'reasoning_tokens',
  'duration_ms',
  'cost_reported_usd',
  'cost_usd',
  'cost_source',
  'price_id',
  'raw',
] as const

const RECORD_UPSERT = `
  insert into usage.records (source, source_id, ${RECORD_COLUMNS.join(', ')})
  select $1::text, $2::text, $3::text, $4::timestamptz,
    (select s.id from usage.sessions s where s.source = $1::text and s.source_session_id = $5::text),
    $6::text, $7::text, $8::text, $9::text, $10::text, $11::text, $12::text, $13::text, $14::text, $15::text,
    $16::jsonb, $5::text, $17::bigint, $18::bigint, $19::bigint, $20::bigint, $21::bigint, $22::bigint,
    $23::integer, $24::numeric, c.cost_usd, c.cost_source, c.price_id, $25::jsonb
  from usage.compute_cost($7::text, $4::timestamptz, $17::bigint, $18::bigint, $19::bigint, $20::bigint, $21::bigint,
    $22::bigint, 'session', $24::numeric) c
  on conflict (source, source_id) do update set
    ${RECORD_COLUMNS.map((c) => `${c} = excluded.${c}`).join(', ')}
  where (${RECORD_COLUMNS.map((c) => `usage.records.${c}`).join(', ')})
    is distinct from (${RECORD_COLUMNS.map((c) => `excluded.${c}`).join(', ')})`

const SESSION_UPSERT = `
  insert into usage.sessions (source, source_session_id, lane, lane_detail, billing, api_key, machine, model, repo, run_id,
    first_ts, last_ts)
  values ($1::text, $2::text, 'agw_workflow', $3::jsonb, 'api_key', $4::text, $5::text, $6::text, $7::text, $2::text,
    $8::timestamptz, $9::timestamptz)
  on conflict (source, source_session_id) do update set
    lane_detail = excluded.lane_detail, billing = excluded.billing, api_key = excluded.api_key,
    machine = excluded.machine, repo = excluded.repo, model = coalesce(usage.sessions.model, excluded.model),
    first_ts = least(usage.sessions.first_ts, excluded.first_ts), last_ts = greatest(usage.sessions.last_ts, excluded.last_ts)
  where (usage.sessions.lane_detail, usage.sessions.billing, usage.sessions.api_key, usage.sessions.machine,
      usage.sessions.repo, usage.sessions.model, usage.sessions.first_ts, usage.sessions.last_ts)
    is distinct from (excluded.lane_detail, excluded.billing, excluded.api_key, excluded.machine, excluded.repo,
      coalesce(usage.sessions.model, excluded.model), least(usage.sessions.first_ts, excluded.first_ts),
      greatest(usage.sessions.last_ts, excluded.last_ts))`

/** One session per run: the earliest row names the model, the first and last `ts` bound it. */
export function sessionsOf(rows: UsageRow[]): UsageSession[] {
  const byRun = new Map<string, UsageRow[]>()
  for (const row of rows) byRun.set(row.run_id, [...(byRun.get(row.run_id) ?? []), row])
  return [...byRun].map(([runId, runRows]) => {
    const sorted = [...runRows].sort((a, b) => a.ts.localeCompare(b.ts) || a.source_id.localeCompare(b.source_id))
    const first = sorted[0] as UsageRow
    return {
      source_session_id: runId,
      lane_detail: {
        workflow: first.lane_detail.workflow,
        caller: first.lane_detail.caller,
        purpose: first.lane_detail.purpose,
      },
      api_key: first.api_key,
      machine: first.machine,
      model: first.model,
      repo: first.repo,
      first_ts: first.ts,
      last_ts: (sorted.at(-1) as UsageRow).ts,
    }
  })
}

async function writeBatch(client: PoolClient, rows: UsageRow[]): Promise<void> {
  await client.query('begin')
  try {
    for (const s of sessionsOf(rows)) {
      await client.query(SESSION_UPSERT, [
        SOURCE,
        s.source_session_id,
        JSON.stringify(s.lane_detail),
        s.api_key,
        s.machine,
        s.model,
        s.repo,
        s.first_ts,
        s.last_ts,
      ])
    }
    for (const r of rows) {
      await client.query(RECORD_UPSERT, [
        r.source,
        r.source_id,
        r.grain,
        r.ts,
        r.run_id,
        r.model_raw,
        r.model,
        r.repo,
        r.project_raw,
        r.workspace,
        r.billing,
        r.api_key,
        r.machine,
        r.outcome,
        r.lane,
        JSON.stringify(r.lane_detail),
        r.input_tokens,
        r.output_tokens,
        r.cache_read_tokens,
        r.cache_write_5m_tokens,
        r.cache_write_1h_tokens,
        r.reasoning_tokens,
        r.duration_ms,
        r.cost_reported_usd,
        JSON.stringify(r.raw),
      ])
    }
    await client.query('commit')
  } catch (err) {
    await client.query('rollback').catch(() => undefined)
    throw err
  }
}

/**
 * Writes into the `usage` schema of the shared database (`USAGE_PG_URL`) on its own small pool: the `usage` role has a
 * connection limit shared with usage-tracker. One transaction per batch: the run's session first, then its records,
 * each an upsert on the table's unique key that changes nothing when nothing differs, so a re-post is free. Cost comes
 * from `usage.compute_cost` in the same statement (agw's measured cost wins as the reported one, else the price tables).
 * The connection string is never logged.
 */
export function pgUsageTransport(options: {
  connectionString: string
  logger: Logger
  /** Default 2. */
  poolSize?: number
}): UsageTransport {
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.poolSize ?? 2,
    application_name: 'agw-usage',
    connectionTimeoutMillis: 10_000,
    query_timeout: 20_000,
    statement_timeout: 20_000,
  })
  pool.on('error', (err) => options.logger.warn('usage pool: idle connection error', { error: err.message }))
  return {
    async write(rows) {
      if (rows.length === 0) return
      let client: PoolClient | undefined
      let broken = false
      try {
        client = await pool.connect()
        await writeBatch(client, rows)
      } catch (err) {
        // A database answer carries a SQLSTATE; a refused connection or a timeout is a plain system error, and the connection is dropped.
        broken = !(err instanceof DatabaseError)
        if (err instanceof DatabaseError && err.code) {
          throw new UsageWriteError(`usage write: ${err.code} ${err.message}`, isRowRefusal(err.code), err.code)
        }
        throw err
      } finally {
        client?.release(broken)
      }
    },
    close: () => pool.end(),
  }
}

/** `USAGE_PG_URL`; null when unset (the usage outbox is then off and steps wait in the journal). */
export function usageTransportFromEnv(
  logger: Logger,
  env: Record<string, string | undefined> = process.env,
): UsageTransport | null {
  const url = env.USAGE_PG_URL?.trim()
  return url ? pgUsageTransport({ connectionString: url, logger }) : null
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
    /** `runs.caller`: who admitted the run; null when the host itself started it (see {@link callerOf}). */
    caller?: string | null
    project?: string | null
    /** `work` or `private` as the caller declared it; null when it did not. */
    workspace?: string | null
    /** The label of the IU key the host that admitted the run held; rows stored before it read `personal`. */
    iuKey: IuKeyId
    traceparent: string | null
    traceId: string | null
    fingerprint: string | null
    friction: unknown
    /** `runs.scores` (inline gates, and the regression or drift score once there is one); absent reads as null. */
    scores?: unknown
    status: string
    errorKind: string | null
    wallMs: number | null
  }
}

export type UsageRowOptions = { machine: string }

/** The caller of a run no door admitted: the eval harness (`eval`, `drift`) or the host's own jobs (`host`). */
const HARNESS_PURPOSES: ReadonlySet<string> = new Set(['eval', 'drift'])

/**
 * Every door stamps `runs.caller`; a run without one was started inside the host process (retrospective, the eval
 * harness and its judge, recovery), which its purpose tells apart.
 */
export function callerOf(run: { caller?: string | null; purpose: string }): string {
  return run.caller ?? (HARNESS_PURPOSES.has(run.purpose) ? 'eval' : 'host')
}

/**
 * Raw provider counts → the additive contract of `usage.records`: `input` fresh uncached input only (minus cache reads
 * and cache writes), `output` without reasoning (`reasoning_tokens` is billed on top). Provider usage is not additive;
 * skipping this double-counts reasoning and cache. agw cannot split cache writes by TTL, so all of it is 5-minute.
 */
export function additiveTokens(tokens: TokenCounts) {
  return {
    input_tokens: Math.max(0, tokens.input - tokens.cacheRead - tokens.cacheWrite),
    output_tokens: Math.max(0, tokens.output - tokens.reasoning),
    cache_read_tokens: tokens.cacheRead,
    cache_write_5m_tokens: tokens.cacheWrite,
    cache_write_1h_tokens: 0,
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

/** A project is a SourceRoot repo only when it is a plain directory slug (no path, no leading dot). */
const REPO_SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * `usage.records.repo`: the project when it is a plain slug and the run is not declared `work` (a work project lives
 * under IuRoot, whose namespace `iu/<dir>` is usage-tracker's to name); otherwise null. The raw string stays in `project_raw`.
 */
export function repoOf(project: string | null | undefined, workspace: string | null | undefined): string | null {
  if (!project || workspace === 'work') return null
  return REPO_SLUG.test(project) ? project : null
}

/** One `usage.records` row per step and model (concept §5); none for a step that spent nothing. */
export function usageRowsForStep(step: OutboxStep, options: UsageRowOptions): UsageRow[] {
  const { run } = step
  if (!hasPurpose(run.purpose)) throw new Error(`run ${step.runId}: a run without a purpose cannot exist`)
  const outcome = step.status !== 'done' || run.errorKind === 'invalid_output' ? 'error' : 'ok'
  const durationMs = step.finishedAt ? Math.max(0, step.finishedAt.getTime() - step.startedAt.getTime()) : null
  const caller = callerOf(run)
  return perModel(step).map(({ model, ...usage }) => ({
    source: SOURCE,
    source_id: `${step.runId}:${step.stepId}:${model}`,
    grain: 'session',
    ts: step.startedAt.toISOString(),
    // agw model ids are already normalized: the raw and the normalized string are one.
    model_raw: model,
    model,
    repo: repoOf(run.project, run.workspace),
    project_raw: run.project ?? null,
    workspace: run.workspace === 'work' || run.workspace === 'private' ? run.workspace : null,
    // Every platform route is IU API; `api_key` names the key that paid, never the key.
    billing: 'api_key',
    api_key: run.iuKey,
    machine: options.machine,
    outcome,
    lane: 'agw_workflow',
    // The run has no route of its own to name (routes belong to agents); `caller` is who asked, `purpose` why.
    lane_detail: { workflow: run.workflowId, step: step.stepId, caller, purpose: run.purpose },
    run_id: step.runId,
    ...additiveTokens(usage.tokens),
    duration_ms: durationMs,
    cost_reported_usd: usage.cost,
    raw: {
      runId: step.runId,
      stepId: step.stepId,
      rootId: run.rootId,
      purpose: run.purpose,
      caller,
      fingerprint: run.fingerprint,
      traceId: run.traceId ?? traceIdForRun(run),
      sessionId: step.sessionId,
      toolCalls: usage.toolCalls,
      unpricedCalls: step.unpricedCalls,
      runOutcome: run.errorKind ?? run.status,
      runWallMs: run.wallMs,
      scores: run.scores ?? null,
      // The after-the-fact score, explicit: `scorePass` null with a `scoreError` is no verdict (never a fail).
      ...finalScoreFields(run.scores),
      friction: run.friction ?? null,
    },
  }))
}

/** `raw.scorePass` and `raw.scoreError` from `runs.scores.final`; both null before the run is scored. */
function finalScoreFields(scores: unknown): {
  scorePass: boolean | null
  scoreError: { kind: 'scorer' | 'infra'; message: string } | null
} {
  const final = (scores as RunScores | null | undefined)?.final
  if (!final) return { scorePass: null, scoreError: null }
  if (final.error !== undefined) {
    return { scorePass: null, scoreError: { kind: final.errorKind ?? 'scorer', message: final.error } }
  }
  return { scorePass: final.pass, scoreError: null }
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
  caller: string | null
  project: string | null
  workspace: string | null
  iu_key: string
  traceparent: string | null
  trace_id: string | null
  fingerprint: string | null
  friction: unknown
  scores: unknown
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
      caller: row.caller,
      project: row.project,
      workspace: row.workspace,
      iuKey: isIuKeyId(row.iu_key) ? row.iu_key : 'personal',
      traceparent: row.traceparent,
      traceId: row.trace_id,
      fingerprint: row.fingerprint,
      friction: row.friction,
      scores: row.scores,
      status: row.run_status,
      errorKind: row.run_error_kind,
      wallMs: row.wall_ms,
    },
  }
}

export type OutboxOptions = {
  /** Its own pool (not the record's), so a slow usage database can never starve run-path writes. */
  db: JournalDb
  transport: UsageTransport
  logger: Logger
  /** The row's `machine` attribute (not part of its key). Default `AGW_MACHINE`; unset, the host name with a logged warning. */
  machine?: string
  /** Steps per claim. Default 200. */
  batchSize?: number
  /** Backoff after a transient failure: first delay, doubled per failure up to `maxMs`. Default 5 s / 5 min. */
  backoff?: { baseMs: number; maxMs: number }
  /** A post that has not answered by then is a transient failure. Default 30 s. */
  postTimeoutMs?: number
  /** How long a claim holds; renewed before every chunk; an expired claim (a crashed flusher) is claimable again. Default 2 min. */
  claimTtlMs?: number
  /** Rows per write, one transaction each. Default 500. */
  chunkSize?: number
  now?: () => number
}

export type FlushResult = {
  /** Rows written. */
  posted: number
  /** Steps marked synced. */
  marked: number
  /** Steps set aside with `argo_error`: a row that cannot be built or that the database refuses (SQLSTATE 22, 23). */
  quarantined: number
  /** Why nothing was tried: still backing off after a transient failure. */
  skipped: 'backoff' | null
  /** The transient failure that stopped this flush. */
  error: string | null
}

type Claimed = { step: OutboxStep; records: UsageRow[] }
type StepKey = { runId: string; stepId: string }

class Transient extends Error {}

const STEP_COLUMNS = `run_id, step_id, status, model, tokens_input, tokens_output, tokens_cache_read,
  tokens_cache_write, tokens_reasoning, cost, tool_calls, unpriced_calls, usage_by_model, started_at, finished_at`

/**
 * Writes the usage of finished steps into `usage.records` once their run's record is written (`runPost` delivered). No
 * transaction of the journal spans a write:
 * 1. claim a batch in one statement (`for update skip locked`, a random `argo_claim` token and an expiry), commit;
 * 2. build the rows, write them outside any journal transaction;
 * 3. mark the batch synced where the token still matches, in a second short statement.
 * Concurrent flushers never write the same claimed step; a crashed flusher's claim expires; a crash after the write
 * re-writes, which the upsert absorbs. A run scored after its steps synced (regression, drift) puts them back into
 * the outbox (the runtime clears `argo_synced_at` and any claim with the score), so `raw.scores` is rewritten. A
 * transient failure releases the claim and backs off. A permanent one (a row that cannot be built or that the database
 * refuses) quarantines only that step (`argo_error`, logged, counted); the rest keep flowing. The `argo_*` column names
 * are the journal's, from before the sink moved.
 */
export class UsageOutbox {
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
      options.logger.warn('usage outbox: AGW_MACHINE unset; using the host name as the machine id', {
        machine: hostname(),
      })
    }
    this.machine = machine || hostname()
    this.batchSize = options.batchSize ?? 200
    this.postTimeoutMs = options.postTimeoutMs ?? 30_000
    this.claimTtlMs = options.claimTtlMs ?? 120_000
    if (this.claimTtlMs <= this.postTimeoutMs * 2)
      throw new Error('usage outbox: claimTtlMs must exceed 2× postTimeoutMs')
    this.now = options.now ?? Date.now
    this.chunkSize = Math.max(1, options.chunkSize ?? 500)
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
        // An answer that is no row refusal and no outage (authentication, a missing table) needs a human; an outage only needs time.
        const level = err instanceof UsageWriteError && err.code !== null && needsHuman(err.code) ? 'error' : 'warn'
        this.options.logger[level]('usage outbox: flush failed; retried after backoff', {
          error: result.error,
          code: err instanceof UsageWriteError ? err.code : null,
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
         r.workflow, r.root_id, r.purpose, r.caller, r.project, r.workspace, r.iu_key, r.traceparent, r.trace_id, r.fingerprint, r.friction, r.scores,
         r.status as run_status, r.error_kind as run_error_kind, r.wall_ms
       from claimed c join ${db.runs} r on r.id = c.run_id
       order by c.finished_at, c.run_id, c.step_id`,
      [this.batchSize, token, this.claimTtlMs],
    )
    return rows.map(toOutboxStep)
  }

  /** The step's rows; a message when they cannot be built (permanent). */
  private build(step: OutboxStep): UsageRow[] | string {
    try {
      return usageRowsForStep(step, { machine: this.machine })
    } catch (err) {
      return errorMessage(err)
    }
  }

  /** Writes the batch; on a permanent refusal, step by step so only the bad ones are quarantined. */
  private async send(token: string, live: Claimed[], result: FlushResult) {
    try {
      await this.post(
        token,
        live.flatMap((c) => c.records),
      )
      await this.mark(token, live, result)
    } catch (err) {
      if (!(err instanceof UsageWriteError && err.permanent)) throw err
      for (const one of live) {
        try {
          await this.post(token, one.records)
          await this.mark(token, [one], result)
        } catch (stepErr) {
          if (!(stepErr instanceof UsageWriteError && stepErr.permanent)) throw stepErr
          result.quarantined += await this.quarantine(token, [one.step], errorMessage(stepErr))
        }
      }
    }
  }

  private async post(token: string, records: UsageRow[]) {
    for (let i = 0; i < records.length; i += this.chunkSize) {
      if (i > 0) await this.renew(token)
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          this.options.transport.write(records.slice(i, i + this.chunkSize)),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Transient(`usage write timed out after ${this.postTimeoutMs} ms`)),
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
      // The claim expired and another flusher took (and will write) these steps; the upsert absorbs the re-write.
      this.options.logger.warn('usage outbox: claim lost before mark; those steps are written again', {
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
    this.options.logger.error('usage outbox: step quarantined (permanent failure); the rest keep flowing', {
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
        this.options.logger.warn('usage outbox: claim release failed; it expires', { error: errorMessage(err) }),
      )
  }
}

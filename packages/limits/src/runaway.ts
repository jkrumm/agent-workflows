import {
  type Logger,
  type Middleware,
  type RunPreArgs,
  type StepPostArgs,
  type StepPreArgs,
  type ToolEvent,
  WorkflowError,
} from '@agent-workflows/runtime'
import { Pool } from 'pg'
import {
  type CapBasis,
  type CapDecision,
  type Caps,
  consoleLogger,
  type DecisionSink,
  METRICS,
  type Metric,
  type Metrics,
} from './decision.ts'

/**
 * Below the sample minimum. Sized from agent-gateway's and research-gateway's runs (README §Where the numbers
 * come from): roughly 10× the worst per-tool p95 and above every maximum seen.
 */
export const DEFAULT_CEILING: Metrics = { cost: 5, tokens: 50_000_000, wallMs: 3 * 60 * 60 * 1000, steps: 500 }

/** A learned cap never drops below this, so a workflow whose p95 is tiny (a 30 ms code run) keeps headroom. */
export const DEFAULT_FLOOR: Metrics = { cost: 0.05, tokens: 100_000, wallMs: 60_000, steps: 20 }

const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/
/** After a failed history read the static ceiling applies for this long, then the read is retried. */
const FAILURE_TTL_MS = 30_000
/** Run state not touched for this long belongs to a run this process no longer drives. */
const STALE_RUN_MS = 6 * 60 * 60 * 1000

export class RunawayCapExceeded extends WorkflowError {
  override name = 'RunawayCapExceeded'
  constructor(
    readonly metric: Metric,
    readonly observed: number,
    readonly cap: number,
    readonly basis: CapBasis,
  ) {
    super(
      'middleware',
      `runaway cap: ${metric} ${format(metric, observed)} > cap ${format(metric, cap)} (${source(basis)})`,
    )
  }
}

export type RunawayCapOptions = {
  /** The runtime's connection string; the rule keeps its own small pool. */
  connectionString: string
  /** The runtime's journal schema. Default `agw`. */
  schema?: string
  /** Cap = factor × p95 of the workflow's own `done` runs. Default 10. */
  factor?: number
  /** Done runs needed before the learned cap applies; below it the static ceiling does. Default 20. */
  minSample?: number
  /** How many of the most recent done runs the p95 is taken over. Default 200. */
  window?: number
  /** How long a workflow's caps are cached. Default 10 minutes. */
  ttlMs?: number
  /** Static ceilings per workflow id, merged over `defaultCeiling`. */
  ceilings?: Record<string, Partial<Metrics>>
  defaultCeiling?: Partial<Metrics>
  floor?: Partial<Metrics>
  logger?: Logger
  onDecision?: DecisionSink
}

export type RunawayCap = Middleware & {
  /** The caps a run of this workflow gets right now (cached). */
  caps(workflowId: string): Promise<Caps>
  /** Queries sent so far: history reads and resume loads, never one per step. */
  readonly queries: number
  close(): Promise<void>
}

type RunState = { workflowId: string; startedAt: number; cost: number; tokens: number; steps: number; seenAt: number }
type CacheEntry = { expiresAt: number; caps: Promise<Caps> }

/**
 * Stops a run whose accumulated cost, tokens, wall time or step count runs far past its workflow's normal
 * (concept §4 Money, D5). Enforced in `stepPre`; `toolPre` watches wall time inside a long agent step.
 */
export function runawayCap(options: RunawayCapOptions): RunawayCap {
  const schema = options.schema ?? 'agw'
  if (!SCHEMA_NAME.test(schema)) throw new Error(`invalid journal schema name "${schema}"`)
  const factor = options.factor ?? 10
  const minSample = options.minSample ?? 20
  const window = options.window ?? 200
  const ttlMs = options.ttlMs ?? 10 * 60 * 1000
  const floor = { ...DEFAULT_FLOOR, ...options.floor }
  const defaultCeiling = { ...DEFAULT_CEILING, ...options.defaultCeiling }
  const logger = options.logger ?? consoleLogger
  const emit = options.onDecision ?? (() => {})

  const pool = new Pool({
    connectionString: options.connectionString,
    max: 2,
    connectionTimeoutMillis: 30_000,
    idleTimeoutMillis: 30_000,
    query_timeout: 30_000,
    statement_timeout: 30_000,
  })
  pool.on('error', (err) => logger.warn('runaway cap pool: idle connection error', { error: err.message }))
  let queries = 0
  const query = <R extends Record<string, unknown>>(text: string, values: unknown[]) => {
    queries++
    return pool.query<R>(text, values)
  }

  const runs = new Map<string, RunState>()
  const cache = new Map<string, CacheEntry>()
  const flagged = new Set<string>()

  function ceiling(workflowId: string): Metrics {
    return { ...defaultCeiling, ...options.ceilings?.[workflowId] }
  }

  async function readHistory(workflowId: string): Promise<Caps> {
    const { rows } = await query<{ n: number } & Metrics>(
      `with r as (
         select r.id,
           extract(epoch from (r.finished_at - r.started_at)) * 1000 as wall_ms,
           coalesce(sum(s.cost), 0) as cost,
           coalesce(sum(s.tokens_input + s.tokens_output + s.tokens_cache_read + s.tokens_reasoning), 0) as tokens,
           count(s.step_id) as steps
         from "${schema}".runs r
         left join "${schema}".steps s on s.run_id = r.id
         where r.workflow = $1 and r.status = 'done' and r.started_at is not null and r.finished_at is not null
         group by r.id
         order by r.finished_at desc
         limit $2
       )
       select count(*)::int as n,
         percentile_cont(0.95) within group (order by cost::float8) as cost,
         percentile_cont(0.95) within group (order by tokens::float8) as tokens,
         percentile_cont(0.95) within group (order by wall_ms::float8) as "wallMs",
         percentile_cont(0.95) within group (order by steps::float8) as steps
       from r`,
      [workflowId, window],
    )
    const row = rows[0]
    const sample = row?.n ?? 0
    if (!row || sample < minSample) {
      return { values: ceiling(workflowId), basis: { kind: 'static', sample, reason: 'below_sample_minimum' } }
    }
    const p95 = pick((m) => Number(row[m]))
    return {
      values: pick((m) => Math.max(factor * p95[m], floor[m])),
      basis: { kind: 'learned', sample, factor, p95 },
    }
  }

  function capsFor(workflowId: string): Promise<Caps> {
    const hit = cache.get(workflowId)
    if (hit && hit.expiresAt > Date.now()) return hit.caps
    const entry: CacheEntry = { expiresAt: Date.now() + ttlMs, caps: Promise.resolve(staticFallback(workflowId)) }
    entry.caps = readHistory(workflowId).catch((err: unknown) => {
      entry.expiresAt = Date.now() + FAILURE_TTL_MS
      logger.warn('runaway cap: history read failed; static ceiling applies', {
        workflowId,
        error: err instanceof Error ? err.message : String(err),
      })
      return staticFallback(workflowId)
    })
    cache.set(workflowId, entry)
    return entry.caps
  }

  function staticFallback(workflowId: string): Caps {
    return { values: ceiling(workflowId), basis: { kind: 'static', sample: 0, reason: 'history_unavailable' } }
  }

  /** What the run spent so far according to the journal: a resumed run counts its earlier steps. */
  async function load(runId: string, workflowId: string): Promise<RunState> {
    const state = await readSpent(runId, workflowId).catch((err: unknown) => {
      // Fail open: a journal hiccup must not fail the step. The run is counted from here on.
      logger.warn('runaway cap: could not load what the run spent; counting from now', {
        runId,
        workflowId,
        error: err instanceof Error ? err.message : String(err),
      })
      const now = Date.now()
      return { workflowId, startedAt: now, cost: 0, tokens: 0, steps: 0, seenAt: now }
    })
    runs.set(runId, state)
    return state
  }

  async function readSpent(runId: string, workflowId: string): Promise<RunState> {
    const { rows } = await query<{ started_at: Date | null; cost: number; tokens: number; steps: number }>(
      `select r.started_at,
         coalesce(sum(s.cost), 0)::float8 as cost,
         coalesce(sum(s.tokens_input + s.tokens_output + s.tokens_cache_read + s.tokens_reasoning), 0)::float8 as tokens,
         count(s.step_id)::int as steps
       from "${schema}".runs r
       left join "${schema}".steps s on s.run_id = r.id
       where r.id = $1
       group by r.id`,
      [runId],
    )
    const row = rows[0]
    return {
      workflowId,
      startedAt: row?.started_at?.getTime() ?? Date.now(),
      cost: row?.cost ?? 0,
      tokens: row?.tokens ?? 0,
      steps: row?.steps ?? 0,
      seenAt: Date.now(),
    }
  }

  function sweep(now: number) {
    for (const [runId, state] of runs) {
      if (now - state.seenAt > STALE_RUN_MS) {
        runs.delete(runId)
        flagged.delete(runId)
      }
    }
  }

  function decide(
    hook: CapDecision['hook'],
    args: { runId: string; stepId: string },
    state: RunState,
    caps: Caps,
    metrics: readonly Metric[],
  ): CapDecision {
    const observed: Metrics = {
      cost: state.cost,
      tokens: state.tokens,
      wallMs: Date.now() - state.startedAt,
      steps: state.steps,
    }
    const exceeded = metrics.find((m) => observed[m] > caps.values[m]) ?? null
    const decision: CapDecision = {
      rule: 'runaway-cap',
      hook,
      runId: args.runId,
      workflowId: state.workflowId,
      stepId: args.stepId,
      allowed: exceeded === null,
      observed,
      caps: caps.values,
      basis: caps.basis,
      exceeded,
    }
    emit(decision)
    return decision
  }

  function refuse(decision: CapDecision): RunawayCapExceeded {
    const metric = decision.exceeded as Metric
    const err = new RunawayCapExceeded(metric, decision.observed[metric], decision.caps[metric], decision.basis)
    logger.warn('runaway cap exceeded', { ...decision, message: err.message })
    return err
  }

  return {
    name: 'runaway-cap',

    async runPre(args: RunPreArgs) {
      const now = Date.now()
      sweep(now)
      if (args.resume) await load(args.runId, args.workflowId)
      else
        runs.set(args.runId, { workflowId: args.workflowId, startedAt: now, cost: 0, tokens: 0, steps: 0, seenAt: now })
      await capsFor(args.workflowId)
    },

    async stepPre(args: StepPreArgs) {
      const state = runs.get(args.runId) ?? (await load(args.runId, args.workflowId))
      state.seenAt = Date.now()
      // A replayed step already has its journal row, counted by the resume load.
      if (!args.replay) state.steps++
      const decision = decide('stepPre', args, state, await capsFor(state.workflowId), METRICS)
      if (decision.exceeded) throw refuse(decision)
    },

    async toolPre(event: ToolEvent) {
      const state = runs.get(event.runId)
      if (!state) return
      state.seenAt = Date.now()
      const decision = decide('toolPre', event, state, await capsFor(state.workflowId), ['wallMs'])
      if (!decision.exceeded) return
      const err = new RunawayCapExceeded('wallMs', decision.observed.wallMs, decision.caps.wallMs, decision.basis)
      if (!flagged.has(event.runId)) {
        flagged.add(event.runId)
        logger.warn('runaway cap exceeded', { ...decision, message: err.message })
      }
      throw err
    },

    stepPost(args: StepPostArgs) {
      const state = runs.get(args.runId)
      if (!state) return
      const { tokens, cost } = args.usage
      state.cost += cost ?? 0
      state.tokens += tokens.input + tokens.output + tokens.cacheRead + tokens.reasoning
      state.seenAt = Date.now()
    },

    runPost(args) {
      runs.delete(args.runId)
      flagged.delete(args.runId)
    },

    caps: capsFor,
    get queries() {
      return queries
    },
    close: () => pool.end(),
  }
}

function pick(value: (metric: Metric) => number): Metrics {
  return { cost: value('cost'), tokens: value('tokens'), wallMs: value('wallMs'), steps: value('steps') }
}

function format(metric: Metric, value: number): string {
  if (metric === 'cost') return `$${value.toFixed(4)}`
  if (metric === 'wallMs') return `${Math.round(value)} ms`
  return String(Math.round(value * 100) / 100)
}

function source(basis: CapBasis): string {
  return basis.kind === 'learned'
    ? `${basis.factor} × p95 of ${basis.sample} done runs`
    : `static ceiling, ${basis.sample} done runs (${basis.reason})`
}

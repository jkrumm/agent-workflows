import {
  type Logger,
  type Middleware,
  type RunPostArgs,
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
  isolatedSink,
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
/** After a failed history read the last caps (or the static ceiling) stay for this long, then the read is retried. */
const FAILURE_TTL_MS = 30_000
/** State not touched for this long belongs to a run this process no longer drives. */
const STALE_RUN_MS = 6 * 60 * 60 * 1000
const TOKENS_SQL = 's.tokens_input + s.tokens_output + s.tokens_cache_read + s.tokens_reasoning'
const TREE_METRICS = ['cost', 'tokens', 'wallMs'] as const

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
  /** How long a workflow's caps are fresh; stale caps are served while a refresh runs. Default 10 minutes. */
  ttlMs?: number
  /** Connect, query and statement timeout of the rule's own pool. Default 5 s. */
  queryTimeoutMs?: number
  /** Static ceilings per workflow id, merged over `defaultCeiling`. */
  ceilings?: Record<string, Partial<Metrics>>
  defaultCeiling?: Partial<Metrics>
  floor?: Partial<Metrics>
  logger?: Logger
  onDecision?: DecisionSink
}

export type RunawayCap = Middleware & {
  /** The caps of this workflow once a pending refresh has landed (the hooks never wait for it). */
  caps(workflowId: string): Promise<Caps>
  /** Queries sent so far: history reads and resume loads, never one per step. */
  readonly queries: number
  close(): Promise<void>
}

/** Spend of a whole root run tree: the root and every fan-out child under it. */
type RootState = {
  workflowId: string
  startedAt: number
  cost: number
  tokens: number
  unpricedCalls: number
  seenAt: number
}
type RunState = { workflowId: string; rootId: string; steps: number; seenAt: number }
type CacheEntry = { caps: Caps | null; expiresAt: number; refreshing: Promise<void> | null }

/**
 * Stops a run whose root tree's accumulated cost, tokens or wall time, or whose own step count, runs far past its
 * workflow's normal (concept §4 Money, D5). Enforced in `stepPre`; `toolPre` watches wall time inside a long agent
 * step. The hooks never wait on the journal: caps are served from cache (stale while revalidating) or the static
 * ceiling, and an unknown run is loaded in the background.
 */
export function runawayCap(options: RunawayCapOptions): RunawayCap {
  const schema = options.schema ?? 'agw'
  if (!SCHEMA_NAME.test(schema)) throw new Error(`invalid journal schema name "${schema}"`)
  const factor = options.factor ?? 10
  const minSample = options.minSample ?? 20
  const window = options.window ?? 200
  const ttlMs = options.ttlMs ?? 10 * 60 * 1000
  const timeoutMs = options.queryTimeoutMs ?? 5000
  const floor = { ...DEFAULT_FLOOR, ...options.floor }
  const defaultCeiling = { ...DEFAULT_CEILING, ...options.defaultCeiling }
  const logger = options.logger ?? consoleLogger
  const emit = isolatedSink(options.onDecision, logger)

  const pool = new Pool({
    connectionString: options.connectionString,
    max: 2,
    connectionTimeoutMillis: timeoutMs,
    idleTimeoutMillis: 30_000,
    query_timeout: timeoutMs,
    statement_timeout: timeoutMs,
  })
  pool.on('error', (err) => logger.warn('runaway cap pool: idle connection error', { error: err.message }))
  let queries = 0
  const query = <R extends Record<string, unknown>>(text: string, values: unknown[]) => {
    queries++
    return pool.query<R>(text, values)
  }

  const roots = new Map<string, RootState>()
  const runs = new Map<string, RunState>()
  const loading = new Map<string, Promise<boolean>>()
  const cache = new Map<string, CacheEntry>()
  const flagged = new Set<string>()

  function ceiling(workflowId: string): Metrics {
    return { ...defaultCeiling, ...options.ceilings?.[workflowId] }
  }

  function staticCaps(workflowId: string, reason: 'history_unavailable' | 'history_pending'): Caps {
    const basis: CapBasis = { kind: 'static', sample: 0, reason }
    return { values: ceiling(workflowId), p95: {}, basis: { tree: basis, steps: basis } }
  }

  /**
   * The latest `window` done runs are picked first, then joined: tree spend over the top-level runs (children by
   * `root_id`), step counts over all runs of the workflow. Wants an index on `runs (workflow, finished_at desc)
   * where status = 'done'` (runtime follow-up).
   */
  async function readHistory(workflowId: string): Promise<Caps> {
    const { rows } = await query<{
      n_tree: number
      n_steps: number
      cost: number | null
      tokens: number | null
      wall_ms: number | null
      steps: number | null
    }>(
      `with top as (
         select id, started_at, finished_at from "${schema}".runs
         where workflow = $1 and parent_id is null and status = 'done'
           and started_at is not null and finished_at is not null
         order by finished_at desc
         limit $2
       ), tree as (
         select t.id,
           extract(epoch from (t.finished_at - t.started_at)) * 1000 as wall_ms,
           coalesce(sum(s.cost), 0) as cost,
           coalesce(sum(${TOKENS_SQL}), 0) as tokens
         from top t
         left join "${schema}".runs c on c.root_id = t.id
         left join "${schema}".steps s on s.run_id = c.id
         group by t.id, t.started_at, t.finished_at
       ), own as (
         select id from "${schema}".runs
         where workflow = $1 and status = 'done' and finished_at is not null
         order by finished_at desc
         limit $2
       ), own_steps as (
         select o.id, count(s.step_id) as steps
         from own o
         left join "${schema}".steps s on s.run_id = o.id
         group by o.id
       )
       select
         (select count(*)::int from tree) as n_tree,
         (select percentile_cont(0.95) within group (order by cost::float8) from tree) as cost,
         (select percentile_cont(0.95) within group (order by tokens::float8) from tree) as tokens,
         (select percentile_cont(0.95) within group (order by wall_ms::float8) from tree) as wall_ms,
         (select count(*)::int from own_steps) as n_steps,
         (select percentile_cont(0.95) within group (order by steps::float8) from own_steps) as steps`,
      [workflowId, window],
    )
    const row = rows[0]
    const fallback = ceiling(workflowId)
    const values = { ...fallback }
    const p95: Partial<Metrics> = {}
    const group = (sample: number, metrics: readonly Metric[], read: (m: Metric) => number): CapBasis => {
      if (sample < minSample) return { kind: 'static', sample, reason: 'below_sample_minimum' }
      for (const m of metrics) {
        p95[m] = read(m)
        values[m] = Math.max(factor * read(m), floor[m])
      }
      return { kind: 'learned', sample, factor }
    }
    const tree = group(row?.n_tree ?? 0, TREE_METRICS, (m) => Number(m === 'wallMs' ? row?.wall_ms : row?.[m]))
    const steps = group(row?.n_steps ?? 0, ['steps'], () => Number(row?.steps))
    return { values, p95, basis: { tree, steps } }
  }

  function entryOf(workflowId: string): CacheEntry {
    let entry = cache.get(workflowId)
    if (!entry) {
      entry = { caps: null, expiresAt: 0, refreshing: null }
      cache.set(workflowId, entry)
    }
    return entry
  }

  /** Never waits: the cached caps (stale ones while a refresh runs) or the static ceiling. */
  function capsNow(workflowId: string): Caps {
    const entry = entryOf(workflowId)
    if (!entry.refreshing && entry.expiresAt <= Date.now()) refresh(workflowId, entry)
    return entry.caps ?? staticCaps(workflowId, 'history_pending')
  }

  function refresh(workflowId: string, entry: CacheEntry) {
    entry.refreshing = readHistory(workflowId)
      .then(
        (caps) => {
          entry.caps = caps
          entry.expiresAt = Date.now() + ttlMs
        },
        (err: unknown) => {
          // Keep serving the last caps; without any, the static ceiling.
          entry.caps ??= staticCaps(workflowId, 'history_unavailable')
          entry.expiresAt = Date.now() + FAILURE_TTL_MS
          logger.warn('runaway cap: history read failed; last caps or the static ceiling apply', {
            workflowId,
            error: err instanceof Error ? err.message : String(err),
          })
        },
      )
      .finally(() => {
        entry.refreshing = null
      })
  }

  /**
   * What the run and its root tree spent so far according to the journal: a resumed run counts its earlier steps,
   * and the tree its children's. Concurrent callers share one read. False when the read failed: nothing is cached,
   * so the meter is never reset and the next step tries again.
   */
  function load(runId: string, force: boolean): Promise<boolean> {
    const pending = loading.get(runId)
    if (pending) return pending
    const read: Promise<boolean> = readSpent(runId)
      .then(
        (spent) => {
          // A runPost while the read was pending ended the run: do not bring its state back.
          if (!spent || loading.get(runId) !== read) return false
          const now = Date.now()
          if (force || !runs.has(runId)) {
            runs.set(runId, { workflowId: spent.workflow, rootId: spent.root_id, steps: spent.steps, seenAt: now })
          }
          if (runId === spent.root_id || !roots.has(spent.root_id)) {
            roots.set(spent.root_id, {
              workflowId: spent.root_workflow,
              startedAt: now - (spent.active_ms ?? 0),
              cost: spent.cost,
              tokens: spent.tokens,
              unpricedCalls: spent.unpriced_calls,
              seenAt: now,
            })
          }
          return true
        },
        (err: unknown) => {
          logger.warn('runaway cap: could not load what the run spent; its steps pass unchecked until it loads', {
            runId,
            error: err instanceof Error ? err.message : String(err),
          })
          return false
        },
      )
      .finally(() => {
        if (loading.get(runId) === read) loading.delete(runId)
      })
    loading.set(runId, read)
    return read
  }

  async function readSpent(runId: string) {
    const { rows } = await query<{
      workflow: string
      root_id: string
      root_workflow: string
      steps: number
      cost: number
      tokens: number
      unpriced_calls: number
      active_ms: number | null
    }>(
      // Wall time already run, approximated from the journal (it records no liveness): root start to the last step
      // start or finish in the tree. Downtime after the last activity is not counted.
      `select r.workflow, r.root_id, root.workflow as root_workflow,
         (select count(*)::int from "${schema}".steps where run_id = r.id) as steps,
         t.cost, t.tokens, t.unpriced_calls,
         (extract(epoch from (greatest(root.started_at, t.last_activity) - root.started_at)) * 1000)::float8 as active_ms
       from "${schema}".runs r
       join "${schema}".runs root on root.id = r.root_id
       cross join lateral (
         select coalesce(sum(s.cost), 0)::float8 as cost,
           coalesce(sum(${TOKENS_SQL}), 0)::float8 as tokens,
           coalesce(sum(s.unpriced_calls), 0)::int as unpriced_calls,
           greatest(max(s.attempt_started_at), max(s.finished_at)) as last_activity
         from "${schema}".runs c
         join "${schema}".steps s on s.run_id = c.id
         where c.root_id = r.root_id
       ) t
       where r.id = $1`,
      [runId],
    )
    return rows[0] ?? null
  }

  function sweep(now: number) {
    for (const [runId, state] of runs) {
      if (now - state.seenAt > STALE_RUN_MS) {
        runs.delete(runId)
        flagged.delete(runId)
      }
    }
    for (const [rootId, state] of roots) if (now - state.seenAt > STALE_RUN_MS) roots.delete(rootId)
  }

  function decide(
    hook: CapDecision['hook'],
    args: { runId: string; stepId: string },
    run: RunState,
    root: RootState,
    metrics: readonly Metric[],
  ): CapDecision {
    const treeCaps = capsNow(root.workflowId)
    const ownCaps = run.workflowId === root.workflowId ? treeCaps : capsNow(run.workflowId)
    const caps: Metrics = { ...treeCaps.values, steps: ownCaps.values.steps }
    const observed: Metrics = {
      cost: root.cost,
      tokens: root.tokens,
      wallMs: Date.now() - root.startedAt,
      steps: run.steps,
    }
    const exceeded = metrics.find((m) => observed[m] > caps[m]) ?? null
    return {
      rule: 'runaway-cap',
      hook,
      runId: args.runId,
      rootId: run.rootId,
      workflowId: run.workflowId,
      stepId: args.stepId,
      allowed: exceeded === null,
      observed,
      caps,
      basis: { tree: treeCaps.basis.tree, steps: ownCaps.basis.steps },
      unpricedCalls: root.unpricedCalls,
      exceeded,
    }
  }

  function refuse(decision: CapDecision): RunawayCapExceeded {
    const metric = decision.exceeded as Metric
    const basis = metric === 'steps' ? decision.basis.steps : decision.basis.tree
    const err = new RunawayCapExceeded(metric, decision.observed[metric], decision.caps[metric], basis)
    logger.warn('runaway cap exceeded', { ...decision, message: err.message })
    return err
  }

  function stateOf(runId: string): { run: RunState; root: RootState } | null {
    const run = runs.get(runId)
    const root = run && roots.get(run.rootId)
    if (!run || !root) return null
    const now = Date.now()
    run.seenAt = now
    root.seenAt = now
    return { run, root }
  }

  return {
    name: 'runaway-cap',

    async runPre(args: RunPreArgs) {
      const now = Date.now()
      sweep(now)
      capsNow(args.workflowId)
      // Admission may wait (bounded by the query timeout); the step hooks never do.
      if (args.resume) {
        await load(args.runId, true)
        return
      }
      runs.set(args.runId, { workflowId: args.workflowId, rootId: args.rootId, steps: 0, seenAt: now })
      if (args.parentId === null) {
        roots.set(args.runId, {
          workflowId: args.workflowId,
          startedAt: now,
          cost: 0,
          tokens: 0,
          unpricedCalls: 0,
          seenAt: now,
        })
      } else if (!roots.has(args.rootId)) {
        void load(args.runId, false)
      }
    },

    stepPre(args: StepPreArgs) {
      const state = stateOf(args.runId)
      if (!state) {
        // Unknown here (evicted, or its load failed): load in the background, this step passes unchecked.
        void load(args.runId, false)
        return
      }
      // A replayed step already has its journal row, counted by the resume load.
      if (!args.replay) state.run.steps++
      const decision = decide('stepPre', args, state.run, state.root, METRICS)
      emit(decision)
      if (decision.exceeded) throw refuse(decision)
    },

    toolPre(event: ToolEvent) {
      // Once per run: the runtime only logs a toolPre throw and lets the step go on, so a repeated throw would add
      // an error log per tool call and stop nothing; the next stepPre stops the run.
      if (flagged.has(event.runId)) return
      const state = stateOf(event.runId)
      if (!state) return
      const decision = decide('toolPre', event, state.run, state.root, ['wallMs'])
      // Only an exceeded cap is a decision worth recording; an agent step makes many tool calls.
      if (!decision.exceeded) return
      flagged.add(event.runId)
      emit(decision)
      throw refuse(decision)
    },

    stepPost(args: StepPostArgs) {
      const state = stateOf(args.runId)
      if (!state) return
      const { tokens, cost, unpricedCalls } = args.usage
      state.root.cost += cost ?? 0
      state.root.tokens += tokens.input + tokens.output + tokens.cacheRead + tokens.reasoning
      state.root.unpricedCalls += unpricedCalls
    },

    runPost(args: RunPostArgs) {
      runs.delete(args.runId)
      loading.delete(args.runId)
      flagged.delete(args.runId)
      if (args.runId === args.rootId) roots.delete(args.rootId)
    },

    async caps(workflowId: string) {
      capsNow(workflowId)
      const entry = entryOf(workflowId)
      if (entry.refreshing) await entry.refreshing
      return entry.caps ?? staticCaps(workflowId, 'history_pending')
    },
    get queries() {
      return queries
    },
    close: () => pool.end(),
  }
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

import { Pool, type QueryConfig } from 'pg'
import { z } from 'zod'
import {
  AdmissionRefused,
  Cancelled,
  errorMessage,
  IdempotencyConflict,
  InfraError,
  Shutdown,
  WorkflowError,
} from './errors.ts'
import { Journal, type RunEnd, type RunRow } from './journal.ts'
import { type Json, jsonViolation } from './json.ts'
import { type Lease, LeasePool } from './lease.ts'
import { assertSchemaName, migrate } from './migrate.ts'
import { checkVerdict } from './score.ts'
import { type Refusal, RunScope, raceAbort, type ScopeHost, toRunError } from './scope.ts'
import type {
  AgentHost,
  Arm,
  AnyWorkflow,
  FinalScore,
  JudgeCaller,
  KeyedRun,
  Logger,
  Middleware,
  RunInfo,
  RunPostArgs,
  RunPreArgs,
  RunResult,
  RunSnapshot,
  ScoredRun,
  ScoredRunFilter,
  StartOptions,
  Usage,
  StepLiveArgs,
  StepPostArgs,
  StepPreArgs,
  ToolEvent,
  Workflow,
} from './types.ts'

export type RuntimeOptions = {
  connectionString: string
  /** Postgres schema of the journal. Default `agw`. */
  schema?: string
  /** Every workflow this process may drive; recovery only claims runs of these. */
  workflows: AnyWorkflow[]
  /**
   * Workflows another process serves, known here to `start` a run of (the same object) and to `scoreRun` it with their
   * scorer, and nothing else: never claimed, leased, recovered, redelivered or driven here, and not in `driftCandidates`.
   * The process that serves the workflow drives the run from the shared journal. An id in both lists is an error.
   */
  foreign?: AnyWorkflow[]
  host?: AgentHost
  /**
   * Final say on the task message of an agent step, called once per attempt right before the session is opened or
   * prompted (never when the prompt was already sent: a resumed step only waits). The host uses it to append learned
   * facts after the task, which keeps the agent's `AGENTS.md` prefix cacheable. A throw is logged and the original
   * prompt is sent: a missing aid must not fail the step.
   */
  agentPrompt?: (args: { agent: string; prompt: string }) => string | Promise<string>
  /** Ordered; called around every run, step and tool call. */
  middleware?: Middleware[]
  /** Top-level runs this process drives at once; also the size of the lease connection budget. Default 16. */
  maxConcurrentRuns?: number
  /** Journal connection pool, separate from the leases. Default 10. */
  journalPoolSize?: number
  /** Recovery tick: claims pending and orphaned runs whose lease is free. Default 2000 ms. */
  recoveryIntervalMs?: number
  /** Cancel and steer delivery tick for runs driven here. Default 500 ms. */
  watchIntervalMs?: number
  /** First backoff after an infra failure of a run, doubled per failure up to 60 s. Default 1000 ms. */
  infraBackoffMs?: number
  /**
   * Drives (a start plus every takeover of a run whose holder died without releasing its lease: a crash or a kill,
   * not a graceful shutdown, a deploy handoff or an infra-backoff retry) after which a run fails as `crash_loop`.
   * Persisted on the run, so the cap survives restarts. Default 20.
   */
  maxDrives?: number
  /**
   * A run of a workflow no process serves (not in `workflows`, not in `foreign`, not registered by any named process:
   * a deploy renamed or removed it) whose lease is free and that nobody touched for this long ends: `failed`
   * (`infra`), or `cancelled` when a cancel was requested. Default 10 min.
   */
  unknownWorkflowGraceMs?: number
  /**
   * This process's name on a shared journal. It records its `workflows` under the name on every sweep, replacing what
   * its previous version served, so another process knows them: a process that is down keeps its row and its runs
   * wait, a workflow a deploy dropped leaves the row and its runs end. Unset: this process registers nothing, and
   * other processes see its workflows only if they list them in `foreign`.
   */
  processName?: string
  /** Failed `runPost` deliveries (a hook threw) before the run is marked delivered anyway, logged. Default 5. */
  maxPostHookAttempts?: number
  /**
   * How long the lease is held after an abort for a still-running step body to settle, and how long a resumed
   * effect waits (from its last start) before running again. Default 30 s.
   */
  bodyGraceMs?: number
  /**
   * A hang guard on each `runPost` hook call (hooks are bookkeeping, never an agent run): a hook still running after it
   * counts as a failed delivery, so a hung hook neither holds the drive and its lease nor blocks redelivery. `close()`
   * abandons a running hook at once without counting it. Default 5 min.
   */
  postHookTimeoutMs?: number
  /** The same guard on `host.abort` while a cancelled run is cleaned up; a timeout is logged like a failed abort. Default 30 s. */
  hostAbortTimeoutMs?: number
  /**
   * How often the `stepLive` hooks run while a step attempt is running (a runaway cap watches wall time and spend
   * there, also for a step that makes no tool call). `null` turns the timer off; host-reported usage still calls
   * the hooks. Default 30 s.
   */
  liveCheckMs?: number | null
  logger?: Logger
  /**
   * The capability caller a scorer gets as `judge` for an LLM-judged sub-score: regression and drift always, the
   * inline gate only with `scorer.judgeInline`. Unset: no scorer can judge (the default scorers never do).
   */
  judge?: JudgeCaller
}

/** `Runtime.scoreRun`: who scores, and for a regression the case it replays. */
export type ScoreRunOptions = {
  source: 'regression' | 'drift'
  /** The case's expected result, validated by `scorer.reference`. */
  reference?: Json
  caseId?: string
  evalRunId?: string
  /** The extra input the eval arm ran with (`agw eval run --args`), kept for `agw eval compare`. */
  args?: Json
  /** First writer wins: an already scored run is left alone and `null` returned. Drift sets it. */
  onlyUnscored?: boolean
}

const consoleLogger: Logger = {
  warn: (message, meta) => console.warn(`[agw-runtime] ${message}`, meta ?? ''),
  error: (message, meta) => console.error(`[agw-runtime] ${message}`, meta ?? ''),
}

const TERMINAL = new Set(['done', 'failed', 'cancelled'])
/**
 * Failed scoring attempts (judge, journal) before a run gets an `infra` scorer error. Drift spaces them by
 * `SCORE_BACKOFF_MS` doubling (1 h, 2 h, 4 h, 8 h): giving up takes ~15 h of outage, and a day later it is tried again.
 */
export const MAX_SCORE_ATTEMPTS = 5
export const SCORE_BACKOFF_MS = 3_600_000
const CANCELLED = { kind: 'cancelled' as const, message: 'cancelled' }
const MAX_RECOVERY_BACKOFF_MS = 30_000
const MAX_INFRA_BACKOFF_MS = 60_000

type Backoff = { failures: number; nextAt: number }

/** A run id a caller may choose (`StartOptions.runId`): lowercase hex UUID. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export class Runtime {
  readonly schema: string
  private readonly journal: Journal
  private readonly pool: Pool
  private readonly leases: LeasePool
  private readonly registry = new Map<string, AnyWorkflow>()
  private readonly foreign = new Map<string, AnyWorkflow>()
  private readonly middleware: Middleware[]
  private readonly logger: Logger
  private readonly host: AgentHost | null
  /** Top-level runs this process is claiming or driving. */
  private readonly claiming = new Set<string>()
  /** Every run (top-level and child) with a live scope here, for cancel and steer delivery. */
  private readonly scopes = new Map<string, RunScope>()
  /** Agent steps waiting on the host, by step key, for steer delivery. */
  private readonly agents = new Map<string, Json>()
  private readonly backoff = new Map<string, Backoff>()
  private readonly drives = new Set<Promise<void>>()
  private recoveryTimer: ReturnType<typeof setTimeout> | undefined
  private lastUnknownSweepAt = 0
  private watchTimer: ReturnType<typeof setTimeout> | undefined
  private recoveryDelay: number
  private steerQueue: Promise<void> = Promise.resolve()
  /** The tick currently running, awaited by `close()` before the pools end. */
  private ticks = new Set<Promise<void>>()
  private readonly scopeHost: ScopeHost
  private opened = false
  private closing = false
  /** Aborted by `close()`: after-the-fact scoring stops with the process. */
  private readonly lifetime = new AbortController()

  constructor(private readonly options: RuntimeOptions) {
    this.schema = options.schema ?? 'agw'
    assertSchemaName(this.schema)
    for (const wf of options.workflows) this.register(wf)
    for (const wf of options.foreign ?? []) {
      if (this.registry.has(wf.id) || this.foreign.has(wf.id)) throw new Error(`workflow ${wf.id} is registered twice`)
      this.foreign.set(wf.id, wf)
    }
    this.middleware = options.middleware ?? []
    this.logger = options.logger ?? consoleLogger
    this.host = options.host ?? null
    this.recoveryDelay = options.recoveryIntervalMs ?? 2000
    this.pool = new Pool({
      connectionString: options.connectionString,
      max: options.journalPoolSize ?? 10,
      application_name: `agw-journal:${this.schema}`,
      connectionTimeoutMillis: 30_000,
      // A hung journal call must fail (infra, retried) instead of stalling a tick forever.
      query_timeout: 120_000,
      statement_timeout: 120_000,
      keepAlive: true,
    })
    this.pool.on('error', (err) => this.logger.warn('journal pool: idle connection error', { error: err.message }))
    this.journal = new Journal(this.pool, this.schema)
    this.leases = new LeasePool(
      options.connectionString,
      options.maxConcurrentRuns ?? 16,
      `agw-lease:${this.schema}`,
      this.logger,
    )
    this.scopeHost = {
      journal: this.journal,
      host: this.host,
      agentPrompt: async (args) => {
        if (!options.agentPrompt) return args.prompt
        try {
          return await options.agentPrompt(args)
        } catch (err) {
          this.logger.error('agentPrompt hook failed; sending the prompt as is', {
            agent: args.agent,
            error: err instanceof Error ? err.message : String(err),
          })
          return args.prompt
        }
      },
      stepPre: (args) => this.stepPre(args),
      bodyGraceMs: options.bodyGraceMs ?? 30_000,
      stepPost: (args) => this.stepPost(args),
      tool: (phase, event) => this.tool(phase, event),
      liveCheckMs: options.liveCheckMs === undefined ? 30_000 : options.liveCheckMs,
      stepLive: (args) => this.stepLive(args),
      runChild: (parent, childId, workflow, input) => this.runChild(parent, childId, workflow, input),
      trackAgent: (key, handle) => this.agents.set(key, handle),
      untrackAgent: (key, handle) => {
        if (this.agents.get(key) === handle) this.agents.delete(key)
      },
      logError: (message, meta) => this.logger.error(message, meta),
      judge: options.judge ?? null,
    }
  }

  /** Migrates the journal and starts the recovery and watch ticks. */
  async open(): Promise<void> {
    await migrate(this.pool, this.schema)
    this.opened = true
    this.scheduleRecovery(0)
    this.scheduleWatch()
  }

  /**
   * Validates the input and records a pending run; this process starts driving it at once when it has a free
   * lease, else the next recovery tick (here or in another process) picks it up. With `parentId` the run is a child of
   * that run (its cost rolls up into the parent's) yet stays its own root: own lease, own recovery, driven by whichever
   * process serves its workflow.
   */
  async start<I extends z.ZodType, O extends z.ZodType>(
    workflow: Workflow<I, O>,
    input: z.input<I>,
    options: StartOptions,
  ): Promise<{ runId: string }> {
    if (!options.purpose) throw new Error('start: purpose is required')
    const foreign = this.foreign.get(workflow.id) === workflow
    if (!foreign) this.register(workflow)
    const parsed = workflow.input.safeParse(input)
    if (!parsed.success) {
      throw new WorkflowError('invalid_input', `${workflow.id}: ${z.prettifyError(parsed.error)}`)
    }
    const value = parsed.data as Json
    const violation = jsonViolation(value)
    if (violation) throw new WorkflowError('invalid_input', `${workflow.id}: input ${violation}`)
    const id = options.runId ?? Bun.randomUUIDv7()
    if (options.runId !== undefined) {
      if (!UUID.test(options.runId)) throw new WorkflowError('invalid_input', 'start: runId must be a UUID')
      if (options.idempotencyKey)
        throw new WorkflowError('invalid_input', 'start: runId and idempotencyKey exclude each other')
    }
    const inputHash = hashJson(value)
    const arm = checkArm(options.arm ?? workflow.arm?.(parsed.data))
    if (arm && options.unarmed) throw new WorkflowError('invalid_input', 'start: unarmed excludes an arm')
    const origin =
      options.parentId === undefined ? originOf(options, arm) : await this.parentOrigin(options.parentId, options, arm)
    const runId = await this.journal.insertRun({
      id,
      workflow: workflow.id,
      parentId: options.parentId ?? null,
      rootId: id,
      purpose: options.purpose,
      ...origin,
      input: value,
      inputHash,
      idempotencyKey: options.idempotencyKey ?? null,
      traceId: traceIdOf(origin.traceparent ?? undefined),
      version: workflow.version,
      chosenId: options.runId !== undefined,
    })
    // A replay of a key: the same input is the same run, a different one is a caller bug.
    if (runId !== id && options.idempotencyKey && (await this.journal.inputHashOf(runId)) !== inputHash) {
      throw new IdempotencyConflict(workflow.id, options.idempotencyKey, runId)
    }
    // A foreign run is the serving process's to claim: this one never takes its lease.
    if (this.opened && !this.closing && !foreign) this.kick(runId)
    return { runId }
  }

  /**
   * A parented start inherits caller, project, workspace and trace from the parent row, as a fan-out child does. The
   * trace: the parent's `traceparent`, else one naming the parent's derived trace and admission span (the telemetry
   * middleware's derivation), so the child's span lands under the parent's in the same trace although its root differs.
   * The arm is the parent's: a child never runs on another arm than its tree.
   */
  private async parentOrigin(parentId: string, options: StartOptions, arm: Arm | null): Promise<Origin> {
    const own: string[] = (['caller', 'project', 'workspace', 'traceparent'] as const).filter(
      (k) => options[k] !== undefined,
    )
    if (arm) own.push('arm')
    if (own.length) throw new WorkflowError('invalid_input', `start: parentId excludes ${own.join(', ')}`)
    const parent = await this.journal.getRun(parentId)
    if (!parent) throw new WorkflowError('invalid_input', `start: parent run ${parentId} not found`)
    return {
      caller: parent.caller,
      project: parent.project,
      workspace: parent.workspace,
      traceparent: parent.traceparent ?? derivedTraceparent(parent),
      arm: options.unarmed ? null : parent.arm,
    }
  }

  /** Polls until the run is done, failed or cancelled. */
  async wait(runId: string, options: { pollMs?: number; signal?: AbortSignal } = {}): Promise<RunResult> {
    for (;;) {
      const run = await this.journal.getRun(runId)
      if (!run) throw new Error(`run ${runId} not found`)
      if (TERMINAL.has(run.status)) return runResult(run)
      options.signal?.throwIfAborted()
      await Bun.sleep(options.pollMs ?? 100)
    }
  }

  /** The run's current state, from any process; null when no such run exists. */
  async getRun(runId: string): Promise<RunSnapshot | null> {
    const run = await this.journal.getRun(runId)
    if (!run) return null
    return {
      runId: run.id,
      workflowId: run.workflow,
      version: run.version_finished ?? run.version_started,
      status: run.status,
      output: run.status === 'done' ? run.output : null,
      error: run.error_kind ? { kind: run.error_kind, message: run.error ?? '' } : null,
      cost: run.cost === null ? null : Number(run.cost),
      unpricedCalls: run.unpriced_calls ?? 0,
      postHooksDone: run.post_hooks_at !== null,
      postHooksFailed: run.post_hooks_failed_at !== null,
    }
  }

  /**
   * Resolves when the journal database answers, and rejects after `timeoutMs` (default 2 s). The bound holds both
   * while waiting for a pooled connection and while the query runs; a query that stalls past it destroys its
   * connection (pg releases a failed `pool.query` client with the error), so a slow Postgres cannot park health
   * probes on the journal pool for the pool's 120 s statement timeout.
   */
  async ping(timeoutMs = 2000): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        // `query_timeout` is a pg query option that @types/pg does not declare.
        this.pool.query({ text: 'select 1', query_timeout: timeoutMs } as QueryConfig),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`journal ping timed out after ${timeoutMs} ms`)), timeoutMs)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Cancels the run and its descendants (parented starts included) from any process. Pending runs end at once; for
   * running ones the process holding the lease (or, for an orphan, the next one to claim it) aborts the running step,
   * aborts the agent sessions, ends the run `cancelled` and calls `runPost`.
   */
  async cancel(runId: string): Promise<boolean> {
    const changed = await this.journal.cancel(runId)
    for (const id of changed) this.scopes.get(id)?.controller.abort(new Cancelled(id))
    return changed.length > 0
  }

  /** Journals a steer for a running agent step; the process driving it forwards it to the host. */
  async steer(runId: string, stepId: string, text: string): Promise<void> {
    const ok = await this.journal.addSteer(runId, stepId, text)
    if (!ok) throw new Error(`steer: step "${stepId}" of run ${runId} is not a running agent step`)
    if (this.scopes.has(runId)) await this.deliverSteers([runId])
  }

  /**
   * Scores an ended run after the fact (concept §6: regression, drift) with its workflow's scorer, and records the
   * verdict on the run (`scores.final`). A failed run is scored with output `null` (a miss); a cancelled or unfinished
   * one is not scored (null). A judge or journal failure is rethrown unrecorded (drift retries the run) and counted;
   * the `MAX_SCORE_ATTEMPTS`th in a row, or a scorer that fails on its own, is recorded as an explicit scorer error
   * (`error`, `pass: null`, `runs.score_error`): not a verdict, and re-scored only by a new scorer version. A shutdown
   * is rethrown uncounted. Any process may call it: the run has ended, nothing races the write.
   */
  async scoreRun(runId: string, options: ScoreRunOptions): Promise<FinalScore | null> {
    const run = await this.journal.scoreTarget(runId)
    if (!run) throw new Error(`run ${runId} not found`)
    if (run.status !== 'done' && run.status !== 'failed') return null
    const workflow = this.registry.get(run.workflow) ?? this.foreign.get(run.workflow)
    if (!workflow?.scorer) throw new Error(`workflow ${run.workflow} has no scorer`)
    const { scorer } = workflow
    // Drift scores a run once; a scorer error is scored again only by another scorer version.
    const rescorable = run.score_error !== null && (run.score_error_kind === 'infra' || run.scorer !== scorer.version)
    if (options.onlyUnscored && run.scored_at && !rescorable) return null
    const meta = {
      source: options.source,
      scorer: scorer.version,
      ...(options.caseId === undefined ? {} : { caseId: options.caseId }),
      ...(options.evalRunId === undefined ? {} : { evalRunId: options.evalRunId }),
      ...(options.args === undefined ? {} : { args: options.args }),
    }
    let final: FinalScore
    /** Set when a judge call failed: whatever the scorer made of it, nothing is recorded and the caller retries. */
    let judgeFailure: unknown = null
    try {
      const reference =
        options.reference === undefined || !scorer.reference
          ? options.reference
          : scorer.reference.parse(options.reference)
      const judge = this.options.judge
      const signal = this.lifetime.signal
      const judged = judge
        ? async (capability: string, input: Json) => {
            try {
              return await judge(capability, input, {
                signal,
                addUsage: noUsage,
                source: options.source,
                runId,
                scorer: scorer.version,
                ...(options.evalRunId === undefined ? {} : { evalRunId: options.evalRunId }),
              })
            } catch (err) {
              judgeFailure = err
              throw new InfraError(`score judge ${capability}: ${errorMessage(err)}`, { cause: err })
            }
          }
        : undefined
      const raw = await scorer.score(run.input, run.status === 'done' ? run.output : null, {
        source: options.source,
        signal,
        ...(reference === undefined ? {} : { reference }),
        ...(judged ? { judge: judged } : {}),
      })
      if (judgeFailure !== null) throw judgeFailure
      final = { ...checkVerdict(raw, `scoring run ${runId}`), ...meta }
    } catch (err) {
      // Not the scorer's verdict: a judge call, the journal, a shutdown. Rethrown unrecorded, so the run stays
      // unscored and drift (or the eval run) tries again.
      if (this.lifetime.signal.aborted) throw err
      if (judgeFailure !== null || err instanceof InfraError) {
        // Bounded: after MAX_SCORE_ATTEMPTS failures in a row the run gets an explicit scorer error, so a persistent
        // failure neither starves newer runs nor keeps spending judge calls.
        const attempts = await this.journal.scoreFailed(runId).catch(() => null)
        if (attempts === null || attempts < MAX_SCORE_ATTEMPTS) throw err
        final = {
          scores: {},
          pass: null,
          error: `gave up after ${attempts} failed attempts: ${errorMessage(err)}`,
          errorKind: 'infra',
          ...meta,
        }
      } else {
        // The scorer's own deterministic failure (a bug, a reference it refuses, a malformed verdict): an explicit
        // scorer error, not a verdict, so drift does not loop on a run that can never score.
        final = { scores: {}, pass: null, error: errorMessage(err), errorKind: 'scorer', ...meta }
      }
    }
    const written = await this.journal.writeFinalScore(runId, final, options.onlyUnscored ?? false)
    return written ? final : null
  }

  /**
   * Drift's sample: done runs (of registered workflows with a scorer, unless `workflows` names others) with a
   * `purposes` purpose (default `prod`), finished since `since`, unscored, and inside the deterministic `rate` sample;
   * plus drift runs whose scorer error came from an older scorer version. Failed attempts sort last.
   */
  driftCandidates(options: {
    rate: number
    since: Date
    limit: number
    purposes?: string[]
    workflows?: string[]
  }): Promise<string[]> {
    const workflows = options.workflows ?? [...this.registry.values()].filter((w) => w.scorer).map((w) => w.id)
    if (workflows.length === 0 || options.rate <= 0) return Promise.resolve([])
    // Only workflows with a scorer have errors to re-score; never a run of one without (no '' version).
    const scored = workflows.filter((id) => this.registry.get(id)?.scorer)
    const versions = scored.map((id) => this.registry.get(id)?.scorer?.version as string)
    return this.journal.driftCandidates({
      ...options,
      workflows,
      scored,
      versions,
      backoffMs: SCORE_BACKOFF_MS,
      purposes: options.purposes ?? ['prod'],
    })
  }

  /** Scored runs of a workflow (oldest first), for `agw eval compare`. */
  scoredRuns(options: ScoredRunFilter): Promise<ScoredRun[]> {
    return this.journal.scoredRuns(options)
  }

  /** The run started under `idempotencyKey` for `workflow` (status, error, final score, fingerprint), or null. */
  runByKey(workflow: string, idempotencyKey: string): Promise<KeyedRun | null> {
    return this.journal.runByKey(workflow, idempotencyKey)
  }

  /**
   * The mean cost of the latest `limit` done runs of a workflow: the base of an eval estimate. A run whose cost is
   * unknown (null) is left out; a free run (0) counts.
   */
  recentCost(workflow: string, limit = 50): Promise<{ runs: number; meanCost: number | null }> {
    return this.journal.recentCost(workflow, limit)
  }

  /**
   * One recovery pass: claim pending and orphaned top-level runs while leases are free, then re-deliver
   * unconfirmed `runPost` hooks (on a reserved maintenance lease, so a full budget never starves it).
   */
  async recover(): Promise<void> {
    if (this.closing) return
    await this.claimFree()
    await this.endUnknownWorkflowRuns()
    await this.redeliverPostHooks()
  }

  /** Ends runs nobody can drive any more (their workflow is gone), at most once per sweep interval. */
  private async endUnknownWorkflowRuns() {
    const graceMs = this.options.unknownWorkflowGraceMs ?? 600_000
    const now = Date.now()
    if (now - this.lastUnknownSweepAt < Math.min(30_000, graceMs)) return
    this.lastUnknownSweepAt = now
    if (this.options.processName)
      await this.journal.registerProcess(this.options.processName, [...this.registry.keys()])
    const known = [...this.registry.keys(), ...this.foreign.keys()]
    const ended = await this.journal.endUnknownWorkflowRuns(known, graceMs)
    if (ended.length > 0) this.logger.warn('ended runs of unregistered workflows', { runIds: ended })
  }

  private async claimFree() {
    const free = this.leases.free()
    if (free <= 0) return
    const workflows = [...this.registry.keys()]
    const running = await this.journal.runningByWorkflow(workflows)
    const saturated = workflows.filter((id) => {
      const max = this.registry.get(id)?.concurrency
      return max !== undefined && (running.get(id) ?? 0) >= max
    })
    const now = Date.now()
    const waiting = [...this.backoff].filter(([, b]) => b.nextAt > now).map(([id]) => id)
    const ids = await this.journal.claimable(workflows, saturated, [...this.claiming, ...waiting], free * 2)
    for (const id of ids) {
      if (this.closing) return
      const result = await this.tryClaim(id)
      if (result === 'full') return
    }
  }

  /**
   * Stops ticking, aborts every run driven here with `Shutdown` (rows stay `running`, agent sessions keep
   * going) and releases the leases, so the next process re-attaches.
   */
  async close(): Promise<void> {
    this.closing = true
    this.lifetime.abort(new Shutdown('runtime closing'))
    clearTimeout(this.recoveryTimer)
    clearTimeout(this.watchTimer)
    await Promise.allSettled([...this.ticks])
    // Claims in flight see `closing` once their lock resolves; loop until none is left.
    while (this.claiming.size > 0 || this.drives.size > 0) {
      for (const scope of this.scopes.values()) scope.controller.abort(new Shutdown('runtime closing'))
      await Promise.allSettled([...this.drives])
      await Bun.sleep(5)
    }
    await Promise.allSettled([...this.ticks, this.steerQueue])
    await this.leases.close()
    await this.pool.end()
  }

  private register(workflow: AnyWorkflow) {
    const known = this.registry.get(workflow.id)
    if ((known && known !== workflow) || this.foreign.has(workflow.id))
      throw new Error(`workflow ${workflow.id} is registered twice`)
    this.registry.set(workflow.id, workflow)
  }

  private kick(runId: string) {
    this.tryClaim(runId).catch((err: unknown) => this.logger.error('claim failed', { runId, error: errorMessage(err) }))
  }

  private async tryClaim(runId: string): Promise<'started' | 'busy' | 'full' | 'skip'> {
    if (this.closing || this.claiming.has(runId)) return 'skip'
    const backoff = this.backoff.get(runId)
    if (backoff && backoff.nextAt > Date.now()) return 'skip'
    this.claiming.add(runId)
    let lease: Lease | 'full' | 'busy'
    try {
      lease = await this.leases.tryLock(this.journal.lockKey(runId), 'run')
    } catch (err) {
      this.claiming.delete(runId)
      this.noteInfra(runId, err)
      return 'skip'
    }
    if (typeof lease === 'string') {
      this.claiming.delete(runId)
      return lease
    }
    if (this.closing) {
      await lease.release()
      this.claiming.delete(runId)
      return 'skip'
    }
    const drive = this.driveLeased(runId, lease)
    this.drives.add(drive)
    drive
      .catch((err: unknown) => this.logger.error('drive failed', { runId, error: errorMessage(err) }))
      .finally(() => this.drives.delete(drive))
    return 'started'
  }

  /**
   * Holds the lease for the whole drive and then until every abandoned step body of the tree settled (bounded by
   * the body grace), so no other process starts the same body while this one still runs it. The claim and the
   * lease are released in `finally`, whatever failed.
   */
  private async driveLeased(runId: string, lease: Lease): Promise<void> {
    const inflight = new Set<Promise<unknown>>()
    const held: { token: string | null } = { token: null }
    try {
      await this.driveRoot(runId, lease, inflight, held)
      this.backoff.delete(runId)
    } catch (err) {
      this.noteInfra(runId, err)
    } finally {
      if (inflight.size > 0) {
        await Promise.race([Promise.allSettled([...inflight]), Bun.sleep(this.scopeHost.bodyGraceMs)])
      }
      // This process is alive and lets go: the next takeover is a handoff, not a crash (best effort; if the write
      // fails the next takeover counts a drive, which only matters after `maxDrives` of them).
      if (held.token) {
        await this.journal.releaseLease(runId, held.token).catch((err: unknown) => {
          this.logger.warn('lease release not recorded', { runId, error: errorMessage(err) })
        })
      }
      await lease.release()
      this.claiming.delete(runId)
    }
  }

  private async driveRoot(
    runId: string,
    lease: Lease,
    inflight: Set<Promise<unknown>>,
    held: { token: string | null },
  ) {
    const run = await this.journal.getRun(runId)
    // Only a run that is its own root is driven here; a fan-out child is driven inside its parent's step.
    if (!run || run.id !== run.root_id || TERMINAL.has(run.status)) return
    const workflow = this.registry.get(run.workflow)
    if (!workflow) return
    const token = crypto.randomUUID()
    held.token = token
    const drives = await this.journal.takeLease(runId, token)
    const scope = new RunScope(this.scopeHost, run, workflow, { rootId: runId, token }, null, inflight)
    lease.onLost(() => scope.controller.abort(new InfraError(`lease connection of run ${runId} lost`)))
    const maxDrives = this.options.maxDrives ?? 20
    if (drives > maxDrives) {
      // A run that takes its process down on every boot (or never gets through) ends instead of looping.
      const error = { kind: 'crash_loop' as const, message: `driven ${drives - 1} times without finishing` }
      await this.finish(scope, { status: 'failed', output: null, error, version: workflow.version })
      return
    }
    await this.drive(scope)
  }

  /** Admission, then the workflow body, then the terminal write and the post hooks. Shared by roots and children. */
  private async drive(scope: RunScope): Promise<Json | null> {
    const { run } = scope
    this.scopes.set(run.id, scope)
    if (this.closing) scope.controller.abort(new Shutdown('runtime closing'))
    try {
      if (run.cancel_requested_at) {
        // Cancelled while nobody drove it (orphan): clean up instead of resuming.
        const version = scope.workflow.version
        return await this.finish(scope, { status: 'cancelled', output: null, error: CANCELLED, version })
      }
      const admitted = await this.admit(scope)
      if (!admitted) return null
      const end = await this.execute(scope)
      return await this.finish(scope, end)
    } finally {
      this.scopes.delete(run.id)
    }
  }

  /**
   * The concurrency slot first (atomic, under a per-workflow lock), then admission once: `runPre` sees
   * `resume: false` until it has accepted the run (`admitted_at`), so a lost slot race or a crash before the
   * accept never fires a second admission for an admitted run. False: stays pending, or ended (refused).
   */
  private async admit(scope: RunScope): Promise<boolean> {
    const { run, workflow } = scope
    if (run.status === 'pending') {
      const limit =
        run.id === run.root_id && workflow.concurrency ? { workflow: workflow.id, max: workflow.concurrency } : null
      const startedAt = await scope.j(() => this.journal.markRunning(run.id, scope.fence, limit))
      if (!startedAt) return false
      scope.run = { ...run, status: 'running', started_at: startedAt }
    }
    const info = runInfo(scope.run, workflow)
    if (run.admitted_at !== null) {
      await this.runPre({ ...info, resume: true })
      return true
    }
    const refusal = await this.runPre({ ...info, resume: false })
    if (refusal) {
      const { refused } = refusal
      const kind = refused instanceof AdmissionRefused ? 'admission_refused' : 'middleware'
      const message = refused === undefined ? 'runPre refused' : errorMessage(refused)
      await this.finish(scope, { status: 'failed', output: null, error: { kind, message }, version: workflow.version })
      return false
    }
    await scope.j(() => this.journal.markAdmitted(run.id, scope.fence))
    return true
  }

  private async execute(scope: RunScope): Promise<RunEnd> {
    const { run, workflow } = scope
    const version = workflow.version
    try {
      const raw: unknown = await raceAbort(
        Promise.resolve().then(() => workflow.run(scope.ctx(), run.input)),
        scope.signal,
      )
      if (scope.infra) throw scope.infra
      const parsed = workflow.output.safeParse(raw)
      if (!parsed.success) {
        const message = `${workflow.id}: ${z.prettifyError(parsed.error)}`
        return { status: 'failed', output: null, error: { kind: 'invalid_output', message }, version }
      }
      const violation = jsonViolation(parsed.data)
      if (violation) {
        return { status: 'failed', output: null, error: { kind: 'invalid_output', message: violation }, version }
      }
      return { status: 'done', output: parsed.data as Json, error: null, version }
    } catch (err) {
      if (scope.infra) throw scope.infra
      if (err instanceof InfraError) throw err
      const reason: unknown = scope.signal.aborted ? scope.signal.reason : null
      if (reason instanceof InfraError) throw reason
      if (err instanceof Cancelled || reason instanceof Cancelled) {
        return { status: 'cancelled', output: null, error: CANCELLED, version }
      }
      return { status: 'failed', output: null, error: toRunError(err), version }
    }
  }

  /** The commit, then `runPost` outside any try: a throwing hook never downgrades the recorded outcome. */
  private async finish(scope: RunScope, end: RunEnd): Promise<Json | null> {
    if (end.status === 'cancelled') await this.cleanUpCancelled(scope)
    const written = await scope.j(() => this.journal.finishRun(scope.run.id, scope.fence, end))
    if (!written) return null
    await this.deliverPostHooks(runPostArgs(scope.run, scope.workflow.version, end, new Date()))
    return end.status === 'done' ? end.output : null
  }

  /**
   * Before a cancelled run ends: running steps of the run and its descendants become `cancelled`, their agent
   * sessions are aborted (`host.abort` must be idempotent: a step aborted in-process may be aborted twice) and
   * unfinished descendants end with their `runPost`. An infra error here leaves the run running for a retry.
   */
  private async cleanUpCancelled(scope: RunScope) {
    const { run, fence } = scope
    const steps = await scope.j(() => this.journal.cancelRunningSteps(run.id, fence))
    for (const step of steps) {
      if (step.kind !== 'agent' || !step.handle || !this.host) continue
      const host = this.host
      const handle = step.handle.handle
      const aborting = Promise.resolve().then(() => host.abort(handle))
      await this.bounded(aborting, this.options.hostAbortTimeoutMs ?? 30_000).catch((err: unknown) => {
        this.logger.error('agent host abort failed', {
          runId: step.run_id,
          stepId: step.step_id,
          error: errorMessage(err),
        })
      })
    }
    const children = await scope.j(() => this.journal.cancelDescendants(run.id, fence))
    for (const child of children) {
      await this.deliverPostHooks(
        runPostArgs(child, child.version_started, endOf(child), child.finished_at ?? new Date()),
      )
    }
  }

  /**
   * `runPost`, then its delivery marker. A hook that threw leaves the run undelivered, so recovery delivers it again
   * (every hook: they are idempotent), up to `maxPostHookAttempts`; then it is marked delivered and logged.
   */
  private async deliverPostHooks(args: RunPostArgs) {
    const runId = args.runId
    const delivered = await this.runPost(args)
    if (delivered === null) return // closing: the next process delivers it, nothing is counted
    if (delivered) {
      await this.journal.postHooksDone(runId).catch((err: unknown) => {
        this.logger.warn('runPost done but not recorded; recovery delivers it again', {
          runId,
          error: errorMessage(err),
        })
      })
      return
    }
    const max = this.options.maxPostHookAttempts ?? 5
    try {
      const { attempts, gaveUp } = await this.journal.postHooksFailed(runId, max)
      if (gaveUp) this.logger.error('runPost failed every attempt; marked delivered', { runId, attempts })
    } catch (err) {
      this.logger.warn('runPost failure not recorded; recovery delivers it again', { runId, error: errorMessage(err) })
    }
  }

  /**
   * At-least-once `runPost`: ended runs whose hooks were never confirmed (a kill between the terminal write and
   * the hooks, or runs a cancel ended while pending). The root's lease proves no live driver is still running
   * the hooks.
   */
  private async redeliverPostHooks() {
    const rows = await this.journal.postHooksPending([...this.registry.keys()], 50)
    for (const row of rows) {
      if (this.closing) return
      if (this.claiming.has(row.root_id)) continue
      const lease = await this.leases.tryLock(this.journal.lockKey(row.root_id), 'maintenance')
      if (lease === 'full') return
      if (lease === 'busy') continue
      try {
        const fresh = await this.journal.getRun(row.id)
        if (!fresh || !TERMINAL.has(fresh.status) || fresh.post_hooks_at !== null) continue
        const version = fresh.version_finished ?? fresh.version_started
        await this.deliverPostHooks(runPostArgs(fresh, version, endOf(fresh), fresh.finished_at ?? new Date()))
      } finally {
        await lease.release()
      }
    }
  }

  /** A child run, driven inside its parent's fan-out step under the root's lease; never by recovery. */
  private async runChild(
    parent: RunScope,
    childId: string,
    workflow: AnyWorkflow,
    input: unknown,
  ): Promise<Json | null> {
    const root = parent.run
    const parsed = workflow.input.safeParse(input)
    const value = (parsed.success ? parsed.data : input) as Json
    const invalid = parsed.success ? jsonViolation(value) : z.prettifyError(parsed.error)
    await parent.j(() =>
      this.journal.insertRun(
        {
          id: childId,
          workflow: workflow.id,
          parentId: root.id,
          rootId: root.root_id,
          purpose: root.purpose,
          caller: root.caller,
          project: root.project,
          workspace: root.workspace,
          arm: root.arm,
          input: invalid ? null : value,
          inputHash: hashJson(invalid ? null : value),
          idempotencyKey: null,
          traceparent: root.traceparent,
          traceId: traceIdOf(root.traceparent ?? undefined),
          version: workflow.version,
          ...(invalid
            ? { status: 'failed' as const, error: { kind: 'invalid_input' as const, message: invalid } }
            : {}),
        },
        parent.fence,
      ),
    )
    const run = await parent.j(() => this.journal.getRun(childId))
    if (!run) throw new InfraError(`child run ${childId} vanished`)
    if (TERMINAL.has(run.status)) return run.status === 'done' ? run.output : null
    const scope = new RunScope(this.scopeHost, run, workflow, parent.fence, parent)
    try {
      return await this.drive(scope)
    } catch (err) {
      if (scope.infra) parent.infra ??= scope.infra
      throw err
    }
  }

  /** Resolves to the refusal for a new run; on resume every throw is logged and ignored. */
  private async runPre(args: RunPreArgs): Promise<Refusal | null> {
    for (const m of this.middleware) {
      if (!m.runPre) continue
      try {
        await m.runPre(args)
      } catch (err) {
        if (!args.resume) return { refused: err }
        this.logger.warn('runPre threw on resume; ignored', {
          middleware: m.name,
          runId: args.runId,
          error: errorMessage(err),
        })
      }
    }
    return null
  }

  /**
   * Settles with `work`, or rejects when `ms` pass (a `TimeoutError`) or the runtime closes (`Shutdown`). The work runs
   * on detached: the hooks and the host take no signal, so a hung one is abandoned, not cancelled.
   */
  private bounded<T>(work: Promise<T>, ms: number): Promise<T> {
    return raceAbort(work, AbortSignal.any([AbortSignal.timeout(ms), this.lifetime.signal]))
  }

  /**
   * Every hook runs even after one threw or timed out; false when any did (the delivery is retried). Null when the
   * runtime closed meanwhile: the rest is skipped and the delivery is left for the next process, uncounted.
   */
  private async runPost(args: RunPostArgs): Promise<boolean | null> {
    let delivered = true
    const timeoutMs = this.options.postHookTimeoutMs ?? 300_000
    for (const m of this.middleware) {
      if (!m.runPost) continue
      const hook = m.runPost.bind(m)
      try {
        await this.bounded(
          Promise.resolve().then(() => hook(args)),
          timeoutMs,
        )
      } catch (err) {
        if (err instanceof Shutdown) return null
        delivered = false
        this.logger.error('runPost threw; outcome kept, delivery retried', {
          middleware: m.name,
          runId: args.runId,
          error: errorMessage(err),
        })
      }
    }
    return delivered
  }

  private async stepPre(args: StepPreArgs): Promise<Refusal | null> {
    for (const m of this.middleware) {
      if (!m.stepPre) continue
      try {
        await m.stepPre(args)
      } catch (err) {
        return { refused: err }
      }
    }
    return null
  }

  private async stepPost(args: StepPostArgs) {
    for (const m of this.middleware) {
      if (!m.stepPost) continue
      try {
        await m.stepPost(args)
      } catch (err) {
        this.logger.error('stepPost threw; outcome kept', {
          middleware: m.name,
          runId: args.runId,
          stepId: args.stepId,
          error: errorMessage(err),
        })
      }
    }
  }

  /** A throwing `toolPre` refuses (the step fails, like `stepPre`); a throwing `toolPost` is logged. */
  private async tool(phase: 'pre' | 'post', event: ToolEvent): Promise<Refusal | null> {
    for (const m of this.middleware) {
      const hook = phase === 'pre' ? m.toolPre : m.toolPost
      if (!hook) continue
      try {
        await hook(event)
      } catch (err) {
        if (phase === 'pre') return { refused: err }
        this.logger.error('toolPost threw', { middleware: m.name, runId: event.runId, error: errorMessage(err) })
      }
    }
    return null
  }

  /** A throwing `stepLive` refuses like `toolPre`: the step fails and its session is aborted. */
  private async stepLive(args: StepLiveArgs): Promise<Refusal | null> {
    for (const m of this.middleware) {
      if (!m.stepLive) continue
      try {
        await m.stepLive(args)
      } catch (err) {
        return { refused: err }
      }
    }
    return null
  }

  private noteInfra(runId: string, err: unknown) {
    if (err instanceof Shutdown) return
    const failures = (this.backoff.get(runId)?.failures ?? 0) + 1
    const delay = Math.min(MAX_INFRA_BACKOFF_MS, (this.options.infraBackoffMs ?? 1000) * 2 ** (failures - 1))
    this.backoff.set(runId, { failures, nextAt: Date.now() + delay })
    this.logger.warn('run left running after an infra error; retrying with backoff', {
      runId,
      failures,
      retryInMs: delay,
      error: errorMessage(err),
    })
  }

  private track(tick: Promise<void>): Promise<void> {
    this.ticks.add(tick)
    return tick.finally(() => this.ticks.delete(tick))
  }

  private scheduleRecovery(delay: number) {
    if (this.closing) return
    this.recoveryTimer = setTimeout(() => {
      this.track(this.recover())
        .then(() => {
          this.recoveryDelay = this.options.recoveryIntervalMs ?? 2000
        })
        .catch((err: unknown) => {
          this.recoveryDelay = Math.min(MAX_RECOVERY_BACKOFF_MS, this.recoveryDelay * 2)
          this.logger.warn('recovery tick failed; backing off', {
            retryInMs: this.recoveryDelay,
            error: errorMessage(err),
          })
        })
        .finally(() => this.scheduleRecovery(this.recoveryDelay))
    }, delay)
  }

  private scheduleWatch() {
    if (this.closing) return
    this.watchTimer = setTimeout(() => {
      this.track(this.watch())
        .catch((err: unknown) => this.logger.warn('watch tick failed', { error: errorMessage(err) }))
        .finally(() => this.scheduleWatch())
    }, this.options.watchIntervalMs ?? 500)
  }

  /** Cancels requested from any process reach the runs driven here; steers reach their agent sessions. */
  private async watch() {
    const ids = [...this.scopes.keys()]
    if (ids.length === 0) return
    for (const id of await this.journal.cancelRequestedAmong(ids)) {
      this.scopes.get(id)?.controller.abort(new Cancelled(id))
    }
    await this.deliverSteers(ids)
  }

  /** Serialized, so the watch tick and a direct `steer()` never send the same row twice. */
  private deliverSteers(runIds: string[]): Promise<void> {
    const next = this.steerQueue.then(() => this.sendSteers(runIds))
    this.steerQueue = next.catch(() => {})
    return next
  }

  private async sendSteers(runIds: string[]) {
    const host = this.host
    if (!host) return
    for (const steer of await this.journal.pendingSteers(runIds)) {
      const handle = this.agents.get(`${steer.run_id}:${steer.step_id}`)
      if (handle === undefined) continue // not waiting on the host yet; the next tick retries
      try {
        await host.steer(handle, steer.text, { signalId: steer.id })
      } catch (err) {
        this.logger.warn('steer delivery failed; retried next tick', { runId: steer.run_id, error: errorMessage(err) })
        continue
      }
      await this.journal.steerDelivered(steer.id)
    }
  }
}

/** Usage of a judge call outside any step: priced by the capability's own run, not attached here. */
const noUsage = (_usage: Usage) => {}

function runInfo(run: RunRow, workflow: { id: string; version: string }): RunInfo {
  return {
    runId: run.id,
    workflowId: workflow.id,
    version: workflow.version,
    purpose: run.purpose,
    parentId: run.parent_id,
    rootId: run.root_id,
    input: run.input,
    traceparent: run.traceparent,
    ...(run.arm ? { arm: run.arm } : {}),
  }
}

/** The terminal fields of an ended row. */
function endOf(run: RunRow): Pick<RunEnd, 'status' | 'output' | 'error'> {
  return {
    status: run.status as RunEnd['status'],
    output: run.status === 'done' ? run.output : null,
    error: run.error_kind ? { kind: run.error_kind, message: run.error ?? '' } : null,
  }
}

/** RunRow (with `started_at` as written by `markRunning`) plus its end → the `runPost` arguments. */
function runPostArgs(
  run: RunRow,
  version: string,
  end: Pick<RunEnd, 'status' | 'output' | 'error'>,
  finishedAt: Date,
): RunPostArgs {
  return {
    ...runInfo(run, { id: run.workflow, version }),
    status: end.status,
    output: end.output,
    error: end.error,
    startedAt: run.started_at,
    finishedAt,
  }
}

function runResult(run: RunRow): RunResult {
  return { runId: run.id, ...endOf(run) }
}

function hashJson(value: Json): string {
  return new Bun.CryptoHasher('sha256').update(JSON.stringify(value)).digest('hex')
}

type Origin = Pick<RunRow, 'caller' | 'project' | 'workspace' | 'traceparent' | 'arm'>

function originOf(options: StartOptions, arm: Arm | null): Origin {
  return {
    caller: options.caller ?? null,
    project: options.project ?? null,
    workspace: options.workspace ?? null,
    traceparent: options.traceparent ?? null,
    arm,
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * The arm's shape (`{ routes?: {...}, params?: {...} }`, JSON throughout). An arm whose routes and params are both
 * empty is none (null): `{ routes: {} }` is the unarmed baseline, on the row and in the fingerprint. The route patches are
 * the routes package's to validate (`validateArm`), which this package cannot import: the caller checks them first.
 */
function checkArm(arm: Arm | undefined): Arm | null {
  if (arm === undefined) return null
  const bad = (why: string) => new WorkflowError('invalid_input', `start: arm ${why}`)
  if (!isRecord(arm)) throw bad('is not an object')
  const extra = Object.keys(arm).filter((k) => k !== 'routes' && k !== 'params')
  if (extra.length) throw bad(`has unknown keys: ${extra.join(', ')}`)
  for (const key of ['routes', 'params'] as const) {
    if (arm[key] !== undefined && !isRecord(arm[key])) throw bad(`${key} is not an object`)
  }
  const violation = jsonViolation(arm, 'arm')
  if (violation) throw new WorkflowError('invalid_input', `start: ${violation}`)
  const empty = (part: object | undefined) => part === undefined || Object.keys(part).length === 0
  return empty(arm.routes) && empty(arm.params) ? null : arm
}

const sha256 = (text: string) => new Bun.CryptoHasher('sha256').update(text).digest('hex')

/**
 * The parent's trace and admission span as a traceparent: the derivation of `traceIdForRun` and `admissionSpanId`
 * (packages/middleware/src/ids.ts), which this package cannot import.
 */
function derivedTraceparent(parent: RunRow): string {
  const traceId = sha256(`agw-trace:${parent.root_id}`).slice(0, 32)
  return `00-${traceId}-${sha256(`agw-run-span:${parent.id}`).slice(0, 16)}-01`
}

/** `00-<trace-id>-<parent-id>-<flags>` → trace id. */
function traceIdOf(traceparent: string | undefined): string | null {
  const match = traceparent ? /^[\da-f]{2}-([\da-f]{32})-[\da-f]{16}-[\da-f]{2}$/.exec(traceparent) : null
  return match?.[1] ?? null
}

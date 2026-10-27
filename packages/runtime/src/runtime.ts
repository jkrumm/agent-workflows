import { Pool } from 'pg'
import { z } from 'zod'
import { AdmissionRefused, Cancelled, errorMessage, InfraError, Shutdown, WorkflowError } from './errors.ts'
import { Journal, type RunEnd, type RunRow } from './journal.ts'
import { type Json, jsonViolation } from './json.ts'
import { type Lease, LeasePool, lockKey } from './lease.ts'
import { assertSchemaName, migrate } from './migrate.ts'
import { RunScope, raceAbort, type ScopeHost, toRunError } from './scope.ts'
import type {
  AgentHost,
  AnyWorkflow,
  Logger,
  Middleware,
  RunInfo,
  RunPostArgs,
  RunPreArgs,
  RunResult,
  StartOptions,
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
  host?: AgentHost
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
  /** Consecutive infra failures after which a run is marked failed (`infra`). Default 20. */
  maxInfraFailures?: number
  logger?: Logger
}

const consoleLogger: Logger = {
  warn: (message, meta) => console.warn(`[agw-runtime] ${message}`, meta ?? ''),
  error: (message, meta) => console.error(`[agw-runtime] ${message}`, meta ?? ''),
}

const TERMINAL = new Set(['done', 'failed', 'cancelled'])
const CANCELLED = { kind: 'cancelled' as const, message: 'cancelled' }
const MAX_RECOVERY_BACKOFF_MS = 30_000
const MAX_INFRA_BACKOFF_MS = 60_000

type Backoff = { failures: number; nextAt: number }

export class Runtime {
  readonly schema: string
  private readonly journal: Journal
  private readonly pool: Pool
  private readonly leases: LeasePool
  private readonly registry = new Map<string, AnyWorkflow>()
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
  private watchTimer: ReturnType<typeof setTimeout> | undefined
  private recoveryDelay: number
  private steerQueue: Promise<void> = Promise.resolve()
  /** The tick currently running, awaited by `close()` before the pools end. */
  private ticks = new Set<Promise<void>>()
  private readonly scopeHost: ScopeHost
  private opened = false
  private closing = false

  constructor(private readonly options: RuntimeOptions) {
    this.schema = options.schema ?? 'agw'
    assertSchemaName(this.schema)
    for (const wf of options.workflows) this.register(wf)
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
      stepPre: (args) => this.stepPre(args),
      stepPost: (args) => this.stepPost(args),
      tool: (phase, event) => this.tool(phase, event),
      runChild: (parent, childId, workflow, input) => this.runChild(parent, childId, workflow, input),
      trackAgent: (key, handle) => this.agents.set(key, handle),
      untrackAgent: (key, handle) => {
        if (this.agents.get(key) === handle) this.agents.delete(key)
      },
      logError: (message, meta) => this.logger.error(message, meta),
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
   * lease, else the next recovery tick (here or in another process) picks it up.
   */
  async start<I extends z.ZodType, O extends z.ZodType>(
    workflow: Workflow<I, O>,
    input: z.input<I>,
    options: StartOptions,
  ): Promise<{ runId: string }> {
    if (!options.purpose) throw new Error('start: purpose is required')
    this.register(workflow)
    const parsed = workflow.input.safeParse(input)
    if (!parsed.success) {
      throw new WorkflowError('invalid_input', `${workflow.id}: ${z.prettifyError(parsed.error)}`)
    }
    const value = parsed.data as Json
    const violation = jsonViolation(value)
    if (violation) throw new WorkflowError('invalid_input', `${workflow.id}: input ${violation}`)
    const id = Bun.randomUUIDv7()
    const runId = await this.journal.insertRun({
      id,
      workflow: workflow.id,
      parentId: null,
      rootId: id,
      purpose: options.purpose,
      input: value,
      inputHash: hashJson(value),
      idempotencyKey: options.idempotencyKey ?? null,
      traceparent: options.traceparent ?? null,
      traceId: traceIdOf(options.traceparent),
      version: workflow.version,
    })
    if (this.opened && !this.closing) this.kick(runId)
    return { runId }
  }

  /** Polls until the run is done, failed or cancelled. */
  async wait(runId: string, options: { pollMs?: number; signal?: AbortSignal } = {}): Promise<RunResult> {
    for (;;) {
      const run = await this.journal.getRun(runId)
      if (!run) throw new Error(`run ${runId} not found`)
      if (TERMINAL.has(run.status)) {
        return {
          runId,
          status: run.status as RunResult['status'],
          output: run.output,
          error: run.error_kind ? { kind: run.error_kind, message: run.error ?? '' } : null,
        }
      }
      options.signal?.throwIfAborted()
      await Bun.sleep(options.pollMs ?? 100)
    }
  }

  /**
   * Cancels the run and its children from any process. Pending runs end at once; for running ones the process
   * holding the lease (or, for an orphan, the next one to claim it) aborts the running step, aborts the agent
   * sessions, ends the run `cancelled` and calls `runPost`.
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

  /** One recovery pass: claim pending and orphaned top-level runs while leases are free. */
  async recover(): Promise<void> {
    if (this.closing) return
    const free = this.leases.free()
    if (free <= 0) return
    const workflows = [...this.registry.keys()]
    const running = await this.journal.runningByWorkflow(workflows)
    const saturated = workflows.filter((id) => {
      const max = this.registry.get(id)?.concurrency
      return max !== undefined && (running.get(id) ?? 0) >= max
    })
    const ids = await this.journal.claimable(workflows, saturated, 200)
    for (const id of ids) {
      if (this.closing) return
      const result = await this.tryClaim(id)
      if (result === 'full') return
    }
    await this.redeliverPostHooks()
  }

  /**
   * Stops ticking, aborts every run driven here with `Shutdown` (rows stay `running`, agent sessions keep
   * going) and releases the leases, so the next process re-attaches.
   */
  async close(): Promise<void> {
    this.closing = true
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
    if (known && known !== workflow) throw new Error(`workflow ${workflow.id} is registered twice`)
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
      lease = await this.leases.tryLock(lockKey(`${this.schema}:${runId}`))
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

  /** Holds the lease for the whole drive; the claim and the lease are released in `finally`, whatever failed. */
  private async driveLeased(runId: string, lease: Lease): Promise<void> {
    try {
      await this.driveRoot(runId, lease)
      this.backoff.delete(runId)
    } catch (err) {
      this.noteInfra(runId, err)
    } finally {
      await lease.release()
      this.claiming.delete(runId)
    }
  }

  private async driveRoot(runId: string, lease: Lease) {
    const run = await this.journal.getRun(runId)
    if (!run || run.parent_id !== null || TERMINAL.has(run.status)) return
    const workflow = this.registry.get(run.workflow)
    if (!workflow) return
    const token = crypto.randomUUID()
    await this.journal.takeLease(runId, token)
    const scope = new RunScope(this.scopeHost, run, workflow, { rootId: runId, token }, null)
    lease.onLost(() => scope.controller.abort(new InfraError(`lease connection of run ${runId} lost`)))
    if ((this.backoff.get(runId)?.failures ?? 0) >= (this.options.maxInfraFailures ?? 20)) {
      const error = { kind: 'infra' as const, message: 'too many consecutive infra failures' }
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
        run.parent_id === null && workflow.concurrency ? { workflow: workflow.id, max: workflow.concurrency } : null
      const taken = await scope.j(() => this.journal.markRunning(run.id, scope.fence, limit))
      if (!taken) return false
    }
    const info = this.runInfo(run, workflow)
    if (run.admitted_at !== null) {
      await this.runPre({ ...info, resume: true })
      return true
    }
    const refusal = await this.runPre({ ...info, resume: false })
    if (refusal) {
      const kind = refusal instanceof AdmissionRefused ? 'admission_refused' : 'middleware'
      await this.finish(scope, {
        status: 'failed',
        output: null,
        error: { kind, message: errorMessage(refusal) },
        version: workflow.version,
      })
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
    await this.runPost({
      ...this.runInfo(scope.run, scope.workflow),
      status: end.status,
      output: end.output,
      error: end.error,
      startedAt: scope.run.started_at,
      finishedAt: new Date(),
    })
    await this.markPostHooks(scope.run.id)
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
      await this.host.abort(step.handle.handle).catch((err: unknown) => {
        this.logger.error('agent host abort failed', {
          runId: step.run_id,
          stepId: step.step_id,
          error: errorMessage(err),
        })
      })
    }
    const children = await scope.j(() => this.journal.cancelDescendants(run.id, fence))
    for (const child of children) {
      await this.runPost({
        ...this.runInfo(child, { id: child.workflow, version: child.version_started }),
        status: 'cancelled',
        output: null,
        error: CANCELLED,
        startedAt: child.started_at,
        finishedAt: new Date(),
      })
      await this.markPostHooks(child.id)
    }
  }

  private async markPostHooks(runId: string) {
    await this.journal.postHooksDone(runId).catch((err: unknown) => {
      this.logger.warn('runPost done but not recorded; recovery delivers it again', { runId, error: errorMessage(err) })
    })
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
      const lease = await this.leases.tryLock(lockKey(`${this.schema}:${row.root_id}`))
      if (lease === 'full') return
      if (lease === 'busy') continue
      try {
        const fresh = await this.journal.getRun(row.id)
        if (!fresh || !TERMINAL.has(fresh.status) || fresh.post_hooks_at !== null) continue
        await this.runPost({
          ...this.runInfo(fresh, { id: fresh.workflow, version: fresh.version_finished ?? fresh.version_started }),
          status: fresh.status as RunPostArgs['status'],
          output: fresh.status === 'done' ? fresh.output : null,
          error: fresh.error_kind ? { kind: fresh.error_kind, message: fresh.error ?? '' } : null,
          startedAt: fresh.started_at,
          finishedAt: fresh.finished_at ?? new Date(),
        })
        await this.markPostHooks(fresh.id)
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
      this.journal.insertRun({
        id: childId,
        workflow: workflow.id,
        parentId: root.id,
        rootId: root.root_id,
        purpose: root.purpose,
        input: invalid ? null : value,
        inputHash: hashJson(invalid ? null : value),
        idempotencyKey: null,
        traceparent: root.traceparent,
        traceId: traceIdOf(root.traceparent ?? undefined),
        version: workflow.version,
        ...(invalid ? { status: 'failed' as const, error: { kind: 'invalid_input' as const, message: invalid } } : {}),
      }),
    )
    const run = await parent.j(() => this.journal.getRun(childId))
    if (!run) throw new InfraError(`child run ${childId} vanished`)
    if (TERMINAL.has(run.status)) return run.status === 'done' ? run.output : null
    const scope = new RunScope(this.scopeHost, run, workflow, parent.fence, parent.signal)
    try {
      return await this.drive(scope)
    } catch (err) {
      if (scope.infra) parent.infra ??= scope.infra
      throw err
    }
  }

  private runInfo(run: RunRow, workflow: { id: string; version: string }): RunInfo {
    return {
      runId: run.id,
      workflowId: workflow.id,
      version: workflow.version,
      purpose: run.purpose,
      parentId: run.parent_id,
      rootId: run.root_id,
      input: run.input,
      traceparent: run.traceparent,
    }
  }

  /** Resolves to the refusal for a new run; on resume every throw is logged and ignored. */
  private async runPre(args: RunPreArgs): Promise<unknown> {
    for (const m of this.middleware) {
      if (!m.runPre) continue
      try {
        await m.runPre(args)
      } catch (err) {
        if (!args.resume) return err
        this.logger.warn('runPre threw on resume; ignored', {
          middleware: m.name,
          runId: args.runId,
          error: errorMessage(err),
        })
      }
    }
    return null
  }

  private async runPost(args: RunPostArgs) {
    for (const m of this.middleware) {
      if (!m.runPost) continue
      try {
        await m.runPost(args)
      } catch (err) {
        this.logger.error('runPost threw; outcome kept', {
          middleware: m.name,
          runId: args.runId,
          error: errorMessage(err),
        })
      }
    }
  }

  private async stepPre(args: StepPreArgs): Promise<unknown> {
    for (const m of this.middleware) {
      if (!m.stepPre) continue
      try {
        await m.stepPre(args)
      } catch (err) {
        return err
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

  private async tool(phase: 'pre' | 'post', event: ToolEvent) {
    for (const m of this.middleware) {
      const hook = phase === 'pre' ? m.toolPre : m.toolPost
      if (!hook) continue
      try {
        await hook(event)
      } catch (err) {
        this.logger.error(`tool${phase === 'pre' ? 'Pre' : 'Post'} threw`, {
          middleware: m.name,
          error: errorMessage(err),
        })
      }
    }
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
        await host.steer(handle, steer.text)
      } catch (err) {
        this.logger.warn('steer delivery failed; retried next tick', { runId: steer.run_id, error: errorMessage(err) })
        continue
      }
      await this.journal.steerDelivered(steer.id)
    }
  }
}

function hashJson(value: Json): string {
  return new Bun.CryptoHasher('sha256').update(JSON.stringify(value)).digest('hex')
}

/** `00-<trace-id>-<parent-id>-<flags>` → trace id. */
function traceIdOf(traceparent: string | undefined): string | null {
  const match = traceparent ? /^[\da-f]{2}-([\da-f]{32})-[\da-f]{16}-[\da-f]{2}$/.exec(traceparent) : null
  return match?.[1] ?? null
}

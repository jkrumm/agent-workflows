import type { z } from 'zod'
import {
  Cancelled,
  type ErrorKind,
  errorKind,
  errorMessage,
  InfraError,
  StepFailed,
  StepTimeout,
  ToolRefused,
  WorkflowError,
} from './errors.ts'
import type { AgentHandleState, Fence, Journal, RunRow, StepRow } from './journal.ts'
import { type Json, jsonViolation } from './json.ts'
import { UsageTotals } from './usage.ts'
import type {
  AgentHost,
  AgentSpec,
  AnyWorkflow,
  Ctx,
  RetryPolicy,
  StepKind,
  StepOptions,
  StepPostArgs,
  StepPreArgs,
  StepScope,
  ToolEvent,
  Workflow,
} from './types.ts'

export const DEFAULT_AGENT_IDLE_MS = 5 * 60_000

/** A hook refused: wrapped, so a hook that throws `undefined` still refuses. */
export type Refusal = { refused: unknown }

/** What a run scope needs from the runtime; keeps the step machinery free of lifecycle state. */
export type ScopeHost = {
  journal: Journal
  host: AgentHost | null
  /** The task message an agent step sends: `RuntimeOptions.agentPrompt`, never throwing. */
  agentPrompt(args: { agent: string; prompt: string }): Promise<string>
  /** `{ refused }` with whatever a hook threw (the step then fails as `middleware`), or null. */
  stepPre(args: StepPreArgs): Promise<Refusal | null>
  /** How long a resumed effect waits, measured from its last start, before running its body again. */
  bodyGraceMs: number
  stepPost(args: StepPostArgs): Promise<void>
  /** `{ refused }` when a `toolPre` hook threw (the step then fails), else null. */
  tool(phase: 'pre' | 'post', event: ToolEvent): Promise<Refusal | null>
  runChild(parent: RunScope, childId: string, workflow: AnyWorkflow, input: unknown): Promise<Json | null>
  trackAgent(key: string, handle: Json): void
  /** Only removes the entry when it is still this attempt's handle. */
  untrackAgent(key: string, handle: Json): void
  logError(message: string, meta: Record<string, unknown>): void
}

/** One drive of one run in this process: its abort controller, the infra latch and the step-id set. */
export class RunScope {
  readonly controller = new AbortController()
  readonly signal: AbortSignal
  /** Set by the first journal failure; from then on every ctx call rethrows it and nothing is marked failed. */
  infra: InfraError | null = null
  /**
   * Step bodies still running in this run tree, including ones the race abandoned after an abort. The lease is
   * held until they settle (bounded by the body grace), so no other process re-runs them concurrently.
   */
  readonly inflight: Set<Promise<unknown>>
  private readonly seen = new Set<string>()
  /** Fails the running attempt of a step from outside its body (a refusing `toolPre`). */
  private readonly refusers = new Map<string, (reason: WorkflowError) => void>()
  /** The agent handle each running step last used, for `stepPost`. */
  private readonly handles = new Map<string, Json>()

  constructor(
    readonly rt: ScopeHost,
    /** Refreshed when the run starts (`started_at`), so post hooks see the real start. */
    public run: RunRow,
    readonly workflow: AnyWorkflow,
    readonly fence: Fence,
    parent: RunScope | null,
    inflight: Set<Promise<unknown>> = new Set(),
  ) {
    this.signal = parent ? AbortSignal.any([parent.signal, this.controller.signal]) : this.controller.signal
    this.inflight = parent ? parent.inflight : inflight
  }

  ctx(): Ctx {
    return {
      runId: this.run.id,
      workflowId: this.workflow.id,
      signal: this.signal,
      step: (id, fn, options) => this.journaled(id, 'code', options ?? {}, (scope) => fn(scope)),
      effect: (id, fn, options) =>
        this.journaled(id, 'effect', options ?? {}, async (scope) => {
          // An outside effect only starts while this process still holds the run.
          await this.j(() => this.rt.journal.assertLease(this.fence))
          scope.signal.throwIfAborted()
          return fn(scope.key, scope)
        }),
      agent: (id, spec) => this.agent(id, spec),
      workflow: (id, workflow, inputs) => this.fanOut(id, workflow, inputs),
    }
  }

  /** Journal calls go through here so a failure latches `infra`. */
  async j<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call()
    } catch (err) {
      if (err instanceof InfraError) this.infra ??= err
      throw err
    }
  }

  private guard() {
    if (this.infra) throw this.infra
    if (this.signal.aborted) throw this.signal.reason
  }

  private async journaled<T extends Json>(
    stepId: string,
    kind: StepKind,
    options: StepOptions,
    body: (scope: StepScope, row: StepRow | null) => T | Promise<T>,
  ): Promise<T> {
    this.guard()
    if (this.seen.has(stepId)) {
      throw new WorkflowError('duplicate_step', `step id "${stepId}" is used twice in run ${this.run.id}`)
    }
    this.seen.add(stepId)
    const { journal } = this.rt
    const runId = this.run.id
    const row = await this.j(() => journal.getStep(runId, stepId))
    if (row?.status === 'done') return row.output as T
    if (row?.status === 'failed') throw new StepFailed(stepId, row.error_kind ?? 'error', row.error ?? '')
    if (row?.status === 'cancelled') throw new Cancelled(runId)
    if (kind === 'effect' && row?.status === 'running' && row.attempt_age_ms < this.rt.bodyGraceMs) {
      // Another process may still be inside this effect (its lease was lost mid-body): wait out the grace.
      await this.sleep(this.rt.bodyGraceMs - row.attempt_age_ms)
    }
    this.guard()

    let attempt = (row?.attempts ?? 0) + 1
    const info = {
      runId,
      workflowId: this.workflow.id,
      version: this.workflow.version,
      stepId,
      kind,
      attempt,
      startedAt: new Date(),
    }
    const refusal = await this.rt.stepPre({ ...info, status: 'running', replay: row !== null })
    await this.j(() => journal.stepRunning(runId, stepId, kind, this.fence))

    const usage = new UsageTotals()
    const policy = retryPolicy(options.retry)
    let outcome: { ok: true; value: T } | { ok: false; error: unknown }
    if (refusal) {
      const message = refusal.refused === undefined ? 'stepPre refused' : errorMessage(refusal.refused)
      outcome = { ok: false, error: new WorkflowError('middleware', message, { cause: refusal.refused }) }
    } else {
      for (let tries = 1; ; tries++) {
        outcome = await this.attempt(stepId, attempt, options.idleTimeoutMs ?? null, usage, (scope) => body(scope, row))
        if (outcome.ok) break
        if (this.infra) throw this.infra
        if (outcome.error instanceof InfraError) throw outcome.error
        if (outcome.error instanceof Cancelled || outcome.error instanceof ToolRefused || tries >= policy.attempts) {
          break
        }
        try {
          await this.sleep(backoffMs(policy, tries))
        } catch (err) {
          if (err instanceof InfraError) throw err
          outcome = { ok: false, error: err }
          break
        }
        attempt++
        await this.j(() => journal.stepRunning(runId, stepId, kind, this.fence))
      }
    }

    const cancelled = !outcome.ok && outcome.error instanceof Cancelled
    const error = outcome.ok ? null : { kind: errorKind(outcome.error), message: errorMessage(outcome.error) }
    const status = outcome.ok ? 'done' : cancelled ? 'cancelled' : 'failed'
    const output = outcome.ok ? outcome.value : null
    const recorded = await this.j(() =>
      journal.finishStep(runId, stepId, this.fence, {
        status,
        output,
        error,
        usage: usage.snapshot(),
        model: usage.model(),
      }),
    )
    // Not recorded: a cancel cleanup ended the step first; its outcome stands.
    if (!recorded) throw new Cancelled(runId)
    const handle = this.handles.get(stepId) ?? null
    this.handles.delete(stepId)
    await this.rt.stepPost({
      ...info,
      attempt,
      status,
      finishedAt: new Date(),
      usage: usage.snapshot(),
      handle,
      output,
      error,
    })
    if (outcome.ok) return outcome.value
    if (cancelled) throw outcome.error
    throw new StepFailed(stepId, error?.kind ?? 'error', error?.message ?? '')
  }

  /** One execution of the body, raced against cancel, lease loss, shutdown and the idle timer. */
  private async attempt<T extends Json>(
    stepId: string,
    attempt: number,
    idleMs: number | null,
    usage: UsageTotals,
    body: (scope: StepScope) => T | Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
    const idle = new AbortController()
    const refuse = new AbortController()
    const signal = AbortSignal.any([this.signal, idle.signal, refuse.signal])
    this.refusers.set(stepId, (reason) => refuse.abort(reason))
    let timer: ReturnType<typeof setTimeout> | undefined
    let finished = false
    const progress = () => {
      if (idleMs === null || signal.aborted || finished) return
      clearTimeout(timer)
      timer = setTimeout(() => idle.abort(new StepTimeout(stepId, idleMs)), idleMs)
    }
    progress()
    const scope: StepScope = {
      key: `${this.run.id}:${stepId}`,
      attempt,
      signal,
      addUsage: (u) => usage.add(u),
      progress,
    }
    try {
      // The awaits before this point (stepPre, the journal) may have outlived a cancel: never start a body then.
      signal.throwIfAborted()
      const running = Promise.resolve().then(() => body(scope))
      this.inflight.add(running)
      const settle = () => this.inflight.delete(running)
      running.then(settle, settle)
      const value = await raceAbort(running, signal)
      const violation = jsonViolation(value)
      if (violation) return { ok: false, error: new WorkflowError('non_json_output', `step "${stepId}": ${violation}`) }
      return { ok: true, value }
    } catch (error) {
      return { ok: false, error }
    } finally {
      finished = true
      clearTimeout(timer)
      this.refusers.delete(stepId)
    }
  }

  private agent<S extends z.ZodType>(stepId: string, spec: AgentSpec<S>): Promise<z.output<S>> {
    const host = this.rt.host
    const { journal } = this.rt
    const runId = this.run.id
    let state: AgentHandleState | null = null
    /** The journal still holds a handle this step no longer uses (a failed attempt's session). */
    let staleHandle = false
    /** The journal write that clears a forgotten handle; the next attempt waits for it. */
    let clearing: Promise<void> = Promise.resolve()
    let loaded = false
    const idleMs = spec.idleTimeoutMs === undefined ? DEFAULT_AGENT_IDLE_MS : spec.idleTimeoutMs
    return this.journaled(stepId, 'agent', { retry: spec.retry, idleTimeoutMs: idleMs }, async (scope, row) => {
      if (!host) throw new WorkflowError('error', 'no AgentHost configured for agent steps')
      if (!loaded) {
        state = row?.handle ?? null
        loaded = true
      }
      await clearing
      if (!state && staleHandle) {
        // A crash before the new handle is journaled must not re-attach to the failed session.
        await this.j(() => journal.stepHandle(runId, stepId, this.fence, null))
        staleHandle = false
      }
      // Re-attach order (concept §3): open, journal the handle, then prompt; a journaled prompt only waits.
      // Every await is followed by a checkpoint: a superseded attempt (timeout, cancel) must not write state.
      let handle: Json | null = state?.handle ?? null
      let sessionAborted = false
      /** Drops this attempt's session from the shared state, unless a newer attempt already replaced it. */
      const forget = () => {
        if (handle === null || state?.handle !== handle) return
        state = null
        staleHandle = true
        // Cleared now, not at the next attempt: a crash during the retry backoff must not re-attach to it.
        clearing = journal.stepHandle(runId, stepId, this.fence, null).then(
          () => {
            if (state === null) staleHandle = false
          },
          (err: unknown) =>
            this.rt.logError('clearing a failed agent handle', { runId, stepId, error: errorMessage(err) }),
        )
      }
      const abortSession = () => {
        const reason: unknown = scope.signal.reason
        if (handle === null || sessionAborted || reason instanceof InfraError) return // shutdown or lease loss: keep the session for re-attach
        sessionAborted = true
        if (reason instanceof StepTimeout) forget() // a retry opens a fresh session
        host.abort(handle).catch((err: unknown) => {
          this.rt.logError('agent host abort failed', { runId, stepId, error: errorMessage(err) })
        })
      }
      /** A cancel or timeout can land while open/prompt is in flight: abort the session and stop before spending. */
      const checkpoint = () => {
        if (!scope.signal.aborted) return
        abortSession()
        throw scope.signal.reason
      }
      scope.signal.addEventListener('abort', abortSession, { once: true })
      try {
        // Read once per attempt, and only when a prompt is still to be sent (a re-attach to a prompted session waits).
        const prompt = !state?.prompted
          ? await this.rt.agentPrompt({ agent: spec.agent, prompt: spec.prompt })
          : spec.prompt
        checkpoint()
        if (!state) {
          handle = await host.open({
            runId,
            stepId,
            key: scope.key,
            agent: spec.agent,
            prompt,
            options: spec.options,
          })
          checkpoint()
          const opened: AgentHandleState = { handle, prompted: false }
          state = opened
          await this.j(() => journal.stepHandle(runId, stepId, this.fence, opened))
        }
        const current: AgentHandleState = state
        this.handles.set(stepId, current.handle)
        this.rt.trackAgent(scope.key, current.handle)
        if (!current.prompted) {
          await this.j(() => journal.assertLease(this.fence)) // never spend a prompt for a run another process took
          checkpoint()
          await host.prompt(current.handle, prompt)
          checkpoint()
          const prompted = { ...current, prompted: true }
          state = prompted
          await this.j(() => journal.stepHandle(runId, stepId, this.fence, prompted))
        }
        checkpoint()
        scope.progress()
        const result = await host.wait(current.handle, {
          signal: scope.signal,
          onProgress: scope.progress,
          onTool: async ({ phase, ...event }) => {
            const refusal = await this.rt.tool(phase, { ...event, runId, stepId })
            if (!refusal) return
            const reason = new ToolRefused(refusal.refused)
            this.refusers.get(stepId)?.(reason)
            throw reason
          },
        })
        if (result.usage) scope.addUsage(result.usage)
        if (!spec.output) return result.output
        const parsed = spec.output.safeParse(result.output)
        if (!parsed.success) {
          throw new WorkflowError('invalid_output', `agent step "${stepId}": ${parsed.error.message}`)
        }
        return parsed.data as Json
      } catch (err) {
        // Any workflow-level failure: a retry must not wait on the same finished or wedged session again.
        if (!(err instanceof InfraError) && !(err instanceof Cancelled)) forget()
        throw err
      } finally {
        scope.signal.removeEventListener('abort', abortSession)
        if (handle !== null) this.rt.untrackAgent(scope.key, handle)
      }
    }) as Promise<z.output<S>>
  }

  private fanOut<I extends z.ZodType, O extends z.ZodType>(
    stepId: string,
    workflow: Workflow<I, O>,
    inputs: z.input<I>[],
  ): Promise<(z.output<O> | null)[]> {
    return this.journaled(stepId, 'workflow', {}, async () => {
      // allSettled: an infra failure in one child must not leave its siblings running unobserved.
      const settled = await Promise.allSettled(
        inputs.map((input, i) => this.rt.runChild(this, `${this.run.id}/${stepId}/${i}`, workflow, input)),
      )
      const rejected = settled.find((s) => s.status === 'rejected')
      if (rejected) throw rejected.reason
      return settled.map((s) => (s.status === 'fulfilled' ? s.value : null))
    }) as Promise<(z.output<O> | null)[]>
  }

  private async sleep(ms: number) {
    await raceAbort(Bun.sleep(ms), this.signal)
  }
}

export function retryPolicy(policy: RetryPolicy | undefined): Required<RetryPolicy> {
  return {
    attempts: Math.max(1, Math.floor(policy?.attempts ?? 1)),
    backoffMs: policy?.backoffMs ?? 1000,
    factor: policy?.factor ?? 2,
    maxBackoffMs: policy?.maxBackoffMs ?? 60_000,
  }
}

function backoffMs(policy: Required<RetryPolicy>, tries: number): number {
  return Math.min(policy.maxBackoffMs, policy.backoffMs * policy.factor ** (tries - 1))
}

/** Settles with `promise`, or rejects with the signal's reason as soon as it aborts (the body runs on detached). */
export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => {})
    return Promise.reject(signal.reason)
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      },
    )
  })
}

export function toRunError(err: unknown): { kind: ErrorKind; message: string } {
  return { kind: errorKind(err), message: errorMessage(err) }
}

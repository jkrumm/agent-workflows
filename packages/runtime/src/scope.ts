import type { z } from 'zod'
import {
  Cancelled,
  type ErrorKind,
  errorKind,
  errorMessage,
  InfraError,
  StepFailed,
  StepTimeout,
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

/** What a run scope needs from the runtime; keeps the step machinery free of lifecycle state. */
export type ScopeHost = {
  journal: Journal
  host: AgentHost | null
  /** Resolves to the error a hook threw (the step then fails as `middleware`), or null. */
  stepPre(args: StepPreArgs): Promise<unknown>
  stepPost(args: StepPostArgs): Promise<void>
  tool(phase: 'pre' | 'post', event: ToolEvent): Promise<void>
  runChild(parent: RunScope, childId: string, workflow: AnyWorkflow, input: unknown): Promise<Json | null>
  trackAgent(key: string, handle: Json | null): void
  logError(message: string, meta: Record<string, unknown>): void
}

/** One drive of one run in this process: its abort controller, the infra latch and the step-id set. */
export class RunScope {
  readonly controller = new AbortController()
  readonly signal: AbortSignal
  /** Set by the first journal failure; from then on every ctx call rethrows it and nothing is marked failed. */
  infra: InfraError | null = null
  private readonly seen = new Set<string>()

  constructor(
    readonly rt: ScopeHost,
    readonly run: RunRow,
    readonly workflow: AnyWorkflow,
    readonly fence: Fence,
    parentSignal: AbortSignal | null,
  ) {
    this.signal = parentSignal ? AbortSignal.any([parentSignal, this.controller.signal]) : this.controller.signal
  }

  ctx(): Ctx {
    return {
      runId: this.run.id,
      workflowId: this.workflow.id,
      signal: this.signal,
      step: (id, fn, options) => this.journaled(id, 'code', options ?? {}, (scope) => fn(scope)),
      effect: (id, fn, options) => this.journaled(id, 'effect', options ?? {}, (scope) => fn(scope.key, scope)),
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
      outcome = { ok: false, error: new WorkflowError('middleware', errorMessage(refusal), { cause: refusal }) }
    } else {
      for (let tries = 1; ; tries++) {
        outcome = await this.attempt(stepId, attempt, options.idleTimeoutMs ?? null, usage, (scope) => body(scope, row))
        if (outcome.ok) break
        if (this.infra) throw this.infra
        if (outcome.error instanceof InfraError) throw outcome.error
        if (outcome.error instanceof Cancelled || tries >= policy.attempts) break
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
    await this.j(() =>
      journal.finishStep(runId, stepId, this.fence, {
        status,
        output,
        error,
        usage: usage.snapshot(),
        model: usage.model(),
      }),
    )
    await this.rt.stepPost({ ...info, attempt, status, finishedAt: new Date(), usage: usage.snapshot(), output, error })
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
    const signal = AbortSignal.any([this.signal, idle.signal])
    let timer: ReturnType<typeof setTimeout> | undefined
    const progress = () => {
      if (idleMs === null || signal.aborted) return
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
      const value = await raceAbort(
        Promise.resolve().then(() => body(scope)),
        signal,
      )
      const violation = jsonViolation(value)
      if (violation) return { ok: false, error: new WorkflowError('non_json_output', `step "${stepId}": ${violation}`) }
      return { ok: true, value }
    } catch (error) {
      return { ok: false, error }
    } finally {
      clearTimeout(timer)
    }
  }

  private agent<S extends z.ZodType>(stepId: string, spec: AgentSpec<S>): Promise<z.output<S>> {
    const host = this.rt.host
    const { journal } = this.rt
    const runId = this.run.id
    let state: AgentHandleState | null = null
    let loaded = false
    const idleMs = spec.idleTimeoutMs === undefined ? DEFAULT_AGENT_IDLE_MS : spec.idleTimeoutMs
    return this.journaled(stepId, 'agent', { retry: spec.retry, idleTimeoutMs: idleMs }, async (scope, row) => {
      if (!host) throw new WorkflowError('error', 'no AgentHost configured for agent steps')
      if (!loaded) {
        state = row?.handle ?? null
        loaded = true
      }
      // Re-attach order (concept §3): open, journal the handle, then prompt; a journaled prompt only waits.
      if (!state) {
        const handle = await host.open({
          runId,
          stepId,
          key: scope.key,
          agent: spec.agent,
          prompt: spec.prompt,
          options: spec.options,
        })
        state = { handle, prompted: false }
        const opened = state
        await this.j(() => journal.stepHandle(runId, stepId, this.fence, opened))
      }
      const current: AgentHandleState = state
      const onAbort = () => {
        const reason: unknown = scope.signal.reason
        if (reason instanceof InfraError) return // shutdown or lease loss: the session keeps running for re-attach
        if (reason instanceof StepTimeout) state = null // a retry opens a fresh session
        host.abort(current.handle).catch((err: unknown) => {
          this.rt.logError('agent host abort failed', { runId, stepId, error: errorMessage(err) })
        })
      }
      scope.signal.addEventListener('abort', onAbort, { once: true })
      this.rt.trackAgent(scope.key, current.handle)
      try {
        if (!current.prompted) {
          await host.prompt(current.handle, spec.prompt)
          const prompted = { ...current, prompted: true }
          state = prompted
          await this.j(() => journal.stepHandle(runId, stepId, this.fence, prompted))
        }
        scope.progress()
        const result = await host.wait(current.handle, {
          signal: scope.signal,
          onProgress: scope.progress,
          onTool: ({ phase, ...event }) => this.rt.tool(phase, { ...event, runId, stepId }),
        })
        if (result.usage) scope.addUsage(result.usage)
        if (!spec.output) return result.output
        const parsed = spec.output.safeParse(result.output)
        if (!parsed.success) {
          throw new WorkflowError('invalid_output', `agent step "${stepId}": ${parsed.error.message}`)
        }
        return parsed.data as Json
      } finally {
        scope.signal.removeEventListener('abort', onAbort)
        this.rt.trackAgent(scope.key, null)
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

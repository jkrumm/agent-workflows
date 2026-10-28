import type { z } from 'zod'
import type { ErrorKind } from './errors.ts'
import type { Json } from './json.ts'

export type StepKind = 'code' | 'effect' | 'agent' | 'workflow'
export type RunStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled'
export type StepStatus = 'running' | 'done' | 'failed' | 'cancelled'

/**
 * Raw provider counts: `input` includes cache reads and cache writes, `output` includes reasoning. `cacheWrite` is
 * optional so a report without it (most OpenAI-shaped wires) stays assignable; sums always carry it.
 */
export type Tokens = { input: number; output: number; cacheRead: number; reasoning: number; cacheWrite?: number }

/** Summed tokens: every bucket present. */
export type TokenCounts = Required<Tokens>

/**
 * What a step body or agent host reports; summed per step and persisted on the step row. A capability's usage
 * (`@agent-workflows/capabilities`) is assignable as is. `cost` null or absent means unpriced: counted in
 * `unpricedCalls`, never summed as 0.
 */
export type Usage = {
  model?: string
  tokens: Tokens
  cost?: number | null
  costSource?: 'provider' | 'rate' | 'unknown'
  toolCalls?: number
}

/** `cost` sums the priced reports only; `unpricedCalls > 0` marks it as a lower bound. */
export type ModelUsage = { tokens: TokenCounts; cost: number | null; toolCalls: number; unpricedCalls: number }

/** The per-step sum of every `addUsage`, with a per-model split for the Argo projection. */
export type StepUsage = ModelUsage & { byModel: Record<string, ModelUsage> }

export type RetryPolicy = {
  /** Total attempts including the first. Default 1 (no retry); agent steps default to none as well. */
  attempts: number
  backoffMs?: number
  factor?: number
  maxBackoffMs?: number
}

export type StepOptions = {
  retry?: RetryPolicy
  /** Fail the attempt as `timeout` after this long without `progress()`. Idle rule, never a wall-clock cap. */
  idleTimeoutMs?: number | null
}

/** Handed to every step body. */
export type StepScope = {
  /** `${runId}:${stepId}`: the idempotency key for outside effects. */
  key: string
  /** 1-based count of executions of this step, across retries and resumes. */
  attempt: number
  /** Aborts on cancel, idle timeout, lease loss and shutdown. */
  signal: AbortSignal
  addUsage: (usage: Usage) => void
  /** Resets the idle timer. */
  progress: () => void
}

export type AgentSpec<S extends z.ZodType = z.ZodType<Json>> = {
  /** Agent definition name, resolved by the host. */
  agent: string
  prompt: string
  /** Validates the host's output; a mismatch fails the step as `invalid_output` (the re-ask comes later). */
  output?: S
  /** Host-specific settings (route, model, profile). */
  options?: Json
  retry?: RetryPolicy
  /** Default 5 minutes without a host progress event; `null` disables. */
  idleTimeoutMs?: number | null
}

export type AgentOpenSpec = {
  runId: string
  stepId: string
  key: string
  agent: string
  prompt: string
  options?: Json
}

export type ToolEvent = {
  runId: string
  stepId: string
  callId: string
  tool: string
  input?: Json
  output?: Json
  error?: string
}

export type AgentWaitOptions = {
  signal: AbortSignal
  /** Call on every new session message or event: it feeds the idle watchdog. */
  onProgress: () => void
  onTool: (event: { phase: 'pre' | 'post' } & Omit<ToolEvent, 'runId' | 'stepId'>) => Promise<void>
}

export type AgentResult = { output: Json; usage?: Usage }

/**
 * The port agent steps go through (OpenCode adapter in Wave 3). The runtime journals the handle between
 * `open` and `prompt`, so a resumed step re-attaches instead of re-prompting.
 */
export type AgentHost = {
  open(spec: AgentOpenSpec): Promise<Json>
  /** Must be idempotent: check the session's messages and send only when the prompt is not there yet. */
  prompt(handle: Json, prompt: string): Promise<void>
  wait(handle: Json, options: AgentWaitOptions): Promise<AgentResult>
  /**
   * `options.signalId` is the journaled signal row of the steer. Delivery is at least once (a crash between the send
   * and the delivery mark sends it again), so a host that can dedupe does it on this id.
   */
  steer(handle: Json, text: string, options?: { signalId?: string }): Promise<void>
  abort(handle: Json): Promise<void>
}

export type Ctx = {
  readonly runId: string
  readonly workflowId: string
  /** Aborts on cancel, lease loss and shutdown. */
  readonly signal: AbortSignal
  step<T extends Json>(id: string, fn: (scope: StepScope) => T | Promise<T>, options?: StepOptions): Promise<T>
  effect<T extends Json>(
    id: string,
    fn: (key: string, scope: StepScope) => T | Promise<T>,
    options?: StepOptions,
  ): Promise<T>
  agent<S extends z.ZodType = z.ZodType<Json>>(id: string, spec: AgentSpec<S>): Promise<z.output<S>>
  /** Fan-out: one child run per input, driven by this step. A failing child yields `null`. */
  workflow<I extends z.ZodType, O extends z.ZodType>(
    id: string,
    workflow: Workflow<I, O>,
    inputs: z.input<I>[],
  ): Promise<(z.output<O> | null)[]>
}

export type WorkflowDefinition<I extends z.ZodType, O extends z.ZodType> = {
  id: string
  /** Code version; recorded as `version_started` / `version_finished`. */
  version: string
  input: I
  output: O
  /** Max top-level runs of this workflow in `running` across all processes; the rest stay pending. */
  concurrency?: number
  run(ctx: Ctx, input: z.output<I>): Promise<z.input<O>>
}

export type Workflow<I extends z.ZodType, O extends z.ZodType> = Readonly<WorkflowDefinition<I, O>>

// biome-ignore lint/suspicious/noExplicitAny: the registry holds workflows of every input and output type
export type AnyWorkflow = Workflow<any, any>

export type RunError = { kind: ErrorKind; message: string }

/** A run as the outside world sees it (`Runtime.getRun`): output only once `done`, error only once ended badly. */
export type RunSnapshot = {
  runId: string
  workflowId: string
  status: RunStatus
  output: Json | null
  error: RunError | null
}

export type RunInfo = {
  runId: string
  workflowId: string
  version: string
  purpose: string
  parentId: string | null
  rootId: string
  input: Json
  traceparent: string | null
}

export type RunPreArgs = RunInfo & { resume: boolean }

export type RunPostArgs = RunInfo & {
  status: 'done' | 'failed' | 'cancelled'
  output: Json | null
  error: RunError | null
  startedAt: Date | null
  finishedAt: Date
}

export type StepInfo = {
  runId: string
  workflowId: string
  version: string
  stepId: string
  kind: StepKind
  attempt: number
  startedAt: Date
}

export type StepPreArgs = StepInfo & { status: 'running'; replay: boolean }

export type StepPostArgs = StepInfo & {
  status: 'done' | 'failed' | 'cancelled'
  finishedAt: Date
  usage: StepUsage
  /** Agent steps: the host handle this execution last used (also after a failed attempt cleared it); else null. */
  handle: Json | null
  output: Json | null
  error: RunError | null
}

type Hook<A> = (args: A) => void | Promise<void>

/**
 * Called by the runtime around every run, step and tool call, in list order; no workflow can skip it.
 * - `runPre` may throw `AdmissionRefused` (or anything) to refuse a new run; ignored when `resume` is true.
 * - `stepPre` throwing fails the step (caps); so does `toolPre`: the step's signal aborts (the agent session is
 *   aborted), the step fails with the thrown `WorkflowError`'s kind (else `middleware`) and is not retried.
 * - Post hooks run after the commit; a throw is logged and never changes a recorded outcome. A throwing `runPost`
 *   is re-delivered (every hook again) up to the runtime's `maxPostHookAttempts`, then marked delivered and logged.
 */
export type Middleware = {
  name: string
  runPre?: Hook<RunPreArgs>
  stepPre?: Hook<StepPreArgs>
  toolPre?: Hook<ToolEvent>
  toolPost?: Hook<ToolEvent>
  stepPost?: Hook<StepPostArgs>
  runPost?: Hook<RunPostArgs>
}

export type Logger = {
  warn(message: string, meta?: Record<string, unknown>): void
  error(message: string, meta?: Record<string, unknown>): void
}

export type StartOptions = {
  /** Why this run exists (`build`, `prod`, `eval`, …); persisted on the run. */
  purpose: string
  traceparent?: string
  /** Same workflow + key → the same run id; the second start is a no-op. */
  idempotencyKey?: string
}

export type RunResult = {
  runId: string
  status: 'done' | 'failed' | 'cancelled'
  output: Json | null
  error: RunError | null
}

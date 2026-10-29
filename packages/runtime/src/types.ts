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
  /**
   * Text that stays the last thing in the task message (a retry directive such as "answer with JSON only"). The
   * `RuntimeOptions.agentPrompt` hook sees `prompt` without it and its additions land before it.
   */
  tail?: string
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
  /**
   * A follow-up turn in the session of `handle` (a done agent step, or an earlier follow-up): returns the handle of
   * the new turn, which `prompt`, `wait`, `steer` and `abort` take like any other. Opens nothing that costs tokens;
   * `prompt` sends the turn's text and must dedupe it like a first prompt. Optional: `ctx.continue` fails without it.
   */
  followUp?(handle: Json, spec: AgentFollowUpSpec): Promise<Json>
}

/** `attempt` keys the turn: a retried continue step sends a new turn instead of re-reading the failed one. */
export type AgentFollowUpSpec = { runId: string; stepId: string; key: string; attempt: number }

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
  /**
   * Runs the workflow's `scorer` on `value` as a journaled code step (`source: 'inline'`): a resumed run returns the
   * recorded verdict and never scores again. The verdict is also kept on the run (`runs.scores.gates[id]`).
   */
  score(id: string, value: Json): Promise<Verdict>
  /**
   * Re-prompts the SAME agent session with `prompt`, as a new agent step `id`. `from` is the value an earlier
   * `ctx.agent` / `ctx.continue` returned (objects and arrays, by identity) or that step's id (any output, a text
   * answer included). The output is validated against `options.output`, else the earlier step's schema.
   */
  continue<S extends z.ZodType = z.ZodType<Json>>(
    id: string,
    from: Json,
    prompt: string,
    options?: ContinueOptions<S>,
  ): Promise<z.output<S>>
  /** Fan-out: one child run per input, driven by this step. A failing child yields `null`. */
  workflow<I extends z.ZodType, O extends z.ZodType>(
    id: string,
    workflow: Workflow<I, O>,
    inputs: z.input<I>[],
  ): Promise<(z.output<O> | null)[]>
}

export type ContinueOptions<S extends z.ZodType> = Pick<AgentSpec<S>, 'output' | 'retry' | 'idleTimeoutMs'>

/** Where a score comes from (concept §6): the inline gate, a regression replay, or a sampled production run. */
export type ScoreSource = 'inline' | 'regression' | 'drift'

/** A scorer's answer. `scores` are numbers, higher is better, ideally in [0, 1]; `feedback` is for `ctx.continue`. */
export type Verdict = { scores: Record<string, number>; pass: boolean; feedback?: string }

/** A capability call a scorer may make for an LLM-judged sub-score; its usage lands on the scoring step. */
export type ScoreJudge = (capability: string, input: Json) => Promise<Json>

/**
 * The runtime's side of `ScoreJudge`: the host passes its capability registry (`RuntimeOptions.judge`). `source` says
 * who scores: an inline gate's `addUsage` is its step's; regression and drift score outside any step, so the host
 * records those calls as runs of their own. `runId` is the scored run and `scorer` the scorer's version: a retried
 * scoring can find its finished calls, a scorer of another version cannot.
 */
export type JudgeCaller = (
  capability: string,
  input: Json,
  scope: { signal: AbortSignal; addUsage: (usage: Usage) => void; source: ScoreSource; runId: string; scorer: string },
) => Promise<Json>

export type ScorerContext<R> = {
  source: ScoreSource
  /** The case's expected result: regression only. */
  reference?: R
  /** Present for regression and drift; inline only when the scorer sets `judgeInline` (never by default). */
  judge?: ScoreJudge
  signal: AbortSignal
}

/**
 * One scorer per workflow (concept §6), deterministic first. `score` gets the run's input and a value: the final
 * output (regression, drift; `null` for a failed run, which scores as a miss) or the draft an inline gate checks.
 * It validates the value itself: "is it even valid" is a score.
 */
export type Scorer<I = Json, R = Json> = {
  /** Recorded with every verdict: scores of different scorer versions are not compared. */
  version: string
  /** Validates a regression case's reference before `score` sees it. */
  reference?: z.ZodType<R>
  /** Hands `judge` to the inline gate too. Off by default: the gate stays free and fast. */
  judgeInline?: boolean
  score(input: I, output: Json, ctx: ScorerContext<R>): Verdict | Promise<Verdict>
}

export type WorkflowDefinition<I extends z.ZodType, O extends z.ZodType> = {
  id: string
  /** Code version; recorded as `version_started` / `version_finished`. */
  version: string
  input: I
  output: O
  /** Max top-level runs of this workflow in `running` across all processes; the rest stay pending. */
  concurrency?: number
  /** Scores the workflow's results: the inline gate (`ctx.score`), regression and drift (concept §6). */
  // biome-ignore lint/suspicious/noExplicitAny: a scorer's reference type is its own business
  scorer?: Scorer<z.output<I>, any>
  run(ctx: Ctx, input: z.output<I>): Promise<z.input<O>>
}

export type Workflow<I extends z.ZodType, O extends z.ZodType> = Readonly<WorkflowDefinition<I, O>>

// biome-ignore lint/suspicious/noExplicitAny: the registry holds workflows of every input and output type
export type AnyWorkflow = Workflow<any, any>

export type RunError = { kind: ErrorKind; message: string }

/**
 * A run as the outside world sees it (`Runtime.getRun`): output only once `done`, error only once ended badly.
 * `cost` and `unpricedCalls` are the run record's sums over the run's own steps (a fan-out child carries its own record,
 * its parent's sums do not include it). `runPost` writes them after the terminal status commits: `postHooksDone`
 * says the hooks were delivered or given up on, and `postHooksFailed` that it was the give-up, so the record may be
 * missing. Before `postHooksDone` the sums are not to be read as final.
 */
export type RunSnapshot = {
  runId: string
  workflowId: string
  status: RunStatus
  output: Json | null
  error: RunError | null
  /** Sum of the priced usage; null when nothing was priced. A lower bound while `unpricedCalls > 0`. */
  cost: number | null
  unpricedCalls: number
  postHooksDone: boolean
  postHooksFailed: boolean
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

/** What a scored run carries in `runs.scores.final`: the verdict of a regression or drift scoring of its output. */
export type FinalScore = {
  source: 'regression' | 'drift'
  /** The scorer version that scored (or failed to score) the run. */
  scorer: string
  /** Regression: the case and the eval run that replayed it, and the extra input the arm ran with. */
  caseId?: string
  evalRunId?: string
  args?: Json
  scores: Record<string, number>
  /** The verdict; `null` exactly when `error` is set: no verdict, never a fail. */
  pass: boolean | null
  feedback?: string
  /**
   * The scorer could not score the run: its own failure, or a judge or journal failure `MAX_SCORE_ATTEMPTS` times in
   * a row. Not a verdict: eval summaries and compare leave it out, and drift re-scores it once the workflow's scorer
   * version changes. Mirrored in `runs.score_error`.
   */
  error?: string
  /** With `error`: `scorer` (its own failure) or `infra` (judge or journal outage, gave up after the attempts). */
  errorKind?: 'scorer' | 'infra'
}

/** `runs.scores`: the inline gate verdicts by step id, and the after-the-fact score of the output. */
export type RunScores = { gates?: Record<string, Verdict>; final?: FinalScore }

/** `Runtime.scoredRuns`: always one workflow and source; every other filter narrows in SQL. */
export type ScoredRunFilter = {
  workflow: string
  source: 'regression' | 'drift'
  runIds?: string[]
  fingerprintPrefix?: string
  /** The exact `--args` an eval arm recorded (`{}` for none); omitted: any. */
  args?: Json
}

/** A run found by workflow + idempotency key (`Runtime.runByKey`): a resumed eval adopts it. */
export type KeyedRun = {
  runId: string
  status: RunStatus
  error: RunError | null
  final: FinalScore | null
  fingerprint: string | null
}

/** A run as `Runtime.scoredRuns` returns it, for `agw eval compare`. */
export type ScoredRun = {
  runId: string
  workflowId: string
  fingerprint: string | null
  final: FinalScore
  cost: number | null
  unpricedCalls: number
  wallMs: number | null
  /** Raw provider counts summed: input (cache included) plus output (reasoning included). */
  tokens: number | null
  toolCalls: number | null
  finishedAt: Date | null
}

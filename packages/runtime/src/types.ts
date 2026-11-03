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
 * `unpricedCalls`, never summed as 0. A step that reports no usage at all is free, not unknown: its cost is 0.
 */
export type Usage = {
  /** The canonical model id (`canonicalModel` in `@agent-workflows/routes`), not the provider's echo. */
  model?: string
  /** The route id the call was resolved from; a fallback call keeps the primary's. Absent for a call with no route. */
  route?: string
  tokens: Tokens
  cost?: number | null
  costSource?: 'provider' | 'rate' | 'unknown'
  toolCalls?: number
}

/**
 * `cost` sums the priced reports only; `unpricedCalls > 0` marks it as a lower bound. null: unknown (every report
 * was a call nobody priced); a step with no report at all is 0 (known free).
 */
export type ModelUsage = { tokens: TokenCounts; cost: number | null; toolCalls: number; unpricedCalls: number }

/**
 * The per-step sum of every `addUsage`, with a per-model split for the usage projection. `route` is the one route named by the reports
 * that name one, null when they name several or none (a report without a route names none; set by `UsageTotals.snapshot`).
 */
export type StepUsage = ModelUsage & { byModel: Record<string, ModelUsage>; route?: string | null }

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

/**
 * Who a step's outside calls are for. Capabilities send it to the gateway as `x-agw-*` headers; structurally the same
 * `Attribution` as `@agent-workflows/capabilities`, so a step can pass its scope to `registry.call` as is.
 */
export type Attribution = {
  /** The step's own run (a child run has its own id). */
  runId: string
  /** The root of the run tree: the gateway's session. */
  rootId: string
  workflow: string
  step: string
  purpose: string
  project?: string
  workspace?: string
  traceparent?: string
  /** Who asked agw for the tree (the root run's `runs.caller`; `eval` / `host` for a run the host started itself). */
  origin?: string
  /**
   * Never set on a step's scope. A call that replaces a balance-refused one (a route fallback) adds the refused
   * response's request id, or `unknown`; structurally the capabilities' `Attribution.routeFallback`.
   */
  routeFallback?: string
}

/**
 * A run tree's experiment arm (`agw eval run --arm <file>`), stored on the run row and copied to every descendant run.
 * `routes` patches the route table for every resolution inside the tree (validated by `@agent-workflows/routes`'
 * `validateArm` at admission; this package only carries it); `params` are the knobs a workflow reads with
 * `ctx.param`. A run without one resolves the plain table.
 */
export type Arm = { routes?: { [routeId: string]: { [key: string]: Json } }; params?: { [name: string]: Json } }

/**
 * What a capability call inside a step takes (`registry.call(id, input, scope.callContext)`): the step's usage sink,
 * signal, attribution and its run's arm. One object, so no call can drop a part of it (the arm above all: a call that
 * forgets it resolves the table inside an armed run).
 */
export type CallContext = {
  signal: AbortSignal
  addUsage: (usage: Usage) => void
  attribution: Attribution
  arm?: Arm
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
  /** The step's run, workflow and step id, for a capability call to pass on (`registry.call(id, input, scope)`). */
  attribution: Attribution
  /**
   * The run's arm, absent for a run without one: a route resolution inside the step applies `arm.routes`
   * (`resolveRoute(id, scope.arm?.routes)`), and `registry.call(id, input, scope)` hands it to the capability.
   */
  arm?: Arm
  /** The capability-call context of this step: pass it to every `registry.call` as is (spread it to wrap `addUsage`). */
  callContext: CallContext
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
  /**
   * The JSON Schema of the step's `output` (`z.toJSONSchema`, `io: 'input'`: what the agent has to produce; a part
   * JSON Schema cannot express is left open), absent when the step has no `output` or the conversion failed. A host
   * that returns structured output offers it to the agent; the runtime's zod parse of the result stays the last check.
   */
  schema?: Json
  /** Why the conversion of `output` to `schema` failed, when it did: a host that needs the schema names it. */
  schemaError?: string
  /** Who the step's model calls are for: the host hands it to the gateway with them. */
  attribution: Attribution
  /** The run's arm, absent for a run without one: the host resolves the step's route with `arm.routes`. */
  arm?: Arm
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

/**
 * `usage` is one report or several (a step that moved between sessions reports each one's spend, so the per-model
 * split and a priced half survive); the step adds each.
 */
export type AgentResult = { output: Json; usage?: Usage | Usage[] }

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
export type AgentFollowUpSpec = {
  runId: string
  stepId: string
  key: string
  attempt: number
  /** The continuing step's, not the step that opened the session. */
  attribution: Attribution
  /** The continuing step's output schema, as `AgentOpenSpec.schema`: a host checks it against the session's. */
  schema?: Json
  /** As `AgentOpenSpec.schemaError`. */
  schemaError?: string
}

export type Ctx = {
  readonly runId: string
  readonly workflowId: string
  /**
   * The run's arm, absent for a run without one (production). Resolve a route outside a step with
   * `resolveRoute(id, ctx.arm?.routes)`; a step body has the same on `scope.arm`.
   */
  readonly arm?: Arm
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
  /**
   * A knob of this run's arm (`arm.params[name]`), else `fallback`. The value must have the fallback's JSON type
   * (number, string, boolean, array, object or null): another type fails the run as `invalid_input`, naming the param.
   */
  param<T extends Json>(name: string, fallback: T): Widen<T>
  /** Fan-out: one child run per input, driven by this step. A failing child yields `null`. */
  workflow<I extends z.ZodType, O extends z.ZodType>(
    id: string,
    workflow: Workflow<I, O>,
    inputs: z.input<I>[],
  ): Promise<(z.output<O> | null)[]>
}

/** A literal's base type: `ctx.param('finders', 3)` is a `number`, not `3`. */
export type Widen<T> = T extends string ? string : T extends number ? number : T extends boolean ? boolean : T

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
  scope: {
    signal: AbortSignal
    addUsage: (usage: Usage) => void
    source: ScoreSource
    runId: string
    scorer: string
    /** The inline gate's step; absent for regression and drift, whose calls are runs of their own. */
    attribution?: Attribution
    /** Regression inside `agw eval run`: the eval run, which the host starts the judge's calls under (`parentId`). */
    evalRunId?: string
  },
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
  // oxlint-disable-next-line typescript/no-explicit-any -- a scorer's reference type is its own business
  scorer?: Scorer<z.output<I>, any>
  run(ctx: Ctx, input: z.output<I>): Promise<z.input<O>>
  /**
   * The arm a run of this workflow applies to itself and its descendants, read from its own validated input at
   * `start` (`eval.run`'s `arm`). Absent: only `StartOptions.arm` (or a parent's) sets one.
   */
  arm?: (input: z.output<I>) => Arm | undefined
}

export type Workflow<I extends z.ZodType, O extends z.ZodType> = Readonly<WorkflowDefinition<I, O>>

// oxlint-disable-next-line typescript/no-explicit-any -- the registry holds workflows of every input and output type
export type AnyWorkflow = Workflow<any, any>

export type RunError = { kind: ErrorKind; message: string }

/**
 * A run as the outside world sees it (`Runtime.getRun`): output only once `done`, error only once ended badly.
 * `cost` and `unpricedCalls` are the run record's, over the steps of the run and every descendant run (by `parent_id`),
 * so a root carries its tree's total. `runPost` writes them after the terminal status commits: `postHooksDone`
 * says the hooks were delivered or given up on, and `postHooksFailed` that it was the give-up, so the record may be
 * missing. Before `postHooksDone` the sums are not to be read as final.
 */
export type RunSnapshot = {
  runId: string
  workflowId: string
  /** The version the run finished under, else the one it started under (null for a run nothing has started). */
  version: string | null
  status: RunStatus
  output: Json | null
  error: RunError | null
  /**
   * Sum of the priced usage of the run and its descendant runs. When no step has a positive known cost: null if some
   * step's cost is unknown or any call was unpriced, else 0 (every step free; also a run with no step, which spent
   * nothing). A lower bound while `unpricedCalls > 0`. A record written before cost 0 meant "free" reads null for a
   * free run: history cannot tell.
   */
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
  /** The run's arm (its own or inherited), absent when it has none: part of the fingerprint. */
  arm?: Arm
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
  /** Who started the run (`runs.caller`); child runs inherit it. Absent: the host itself. */
  caller?: string
  /** The repo the caller works in (`runs.project`), a bare name. */
  project?: string
  /** `work` or `private` (`runs.workspace`); absent leaves the workspace unclassified. */
  workspace?: 'work' | 'private'
  traceparent?: string
  /** Same workflow + key → the same run id; the second start is a no-op. */
  idempotencyKey?: string
  /**
   * The run's id, chosen by the caller (a UUID, best v7: ids sort by time) so it is known before the start returns: a
   * response header can carry it without waiting for the journal. Never together with `idempotencyKey`; an id already
   * in the journal is refused.
   */
  runId?: string
  /**
   * Starts the run as a child of this run (`parent_id`): its cost rolls up into the parent's, and caller, project,
   * workspace and trace come from the parent row (so those options are refused next to it). It stays its own root
   * (`root_id` = its id): leased, recovered and redelivered on its own by the process that serves its workflow, not
   * driven inside the parent like a fan-out child. `agw eval run` starts its case runs so. The child inherits the
   * parent's arm too (unless `unarmed`), so `arm` is refused next to it.
   */
  parentId?: string
  /**
   * The run resolves the plain route table even under an armed parent: it neither takes nor passes on an arm. The
   * regression judge's calls start so: they stay children of the eval run (its cost) but grade with the table, so an arm
   * that patches the judge's routes never changes the grader.
   */
  unarmed?: true
  /**
   * The run's arm (`Arm`), copied to every descendant run. Without it a run takes its workflow's `arm(input)` or none.
   * Only shape-checked here: a caller validates the route patches first (`validateArm`).
   */
  arm?: Arm
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

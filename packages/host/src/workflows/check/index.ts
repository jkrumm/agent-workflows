import { statSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_STATE_DIR } from '@agent-workflows/opencode-host'
import {
  type Ctx,
  defineWorkflow,
  InfraError,
  type Logger,
  StepFailed,
  type StepScope,
  WorkflowError,
} from '@agent-workflows/runtime'
import type { HostWorkflow } from '../../operations.ts'
import type { WorkflowDeps } from '../index.ts'
import { bunExec, type Exec, type ExecResult } from './exec.ts'
import { hasMakeCheckTarget } from './make.ts'
import { agentIdleMs, agentPrompt, JSON_ONLY_RETRY } from './prompt.ts'
import { CHECK_INPUT, CHECK_OUTPUT, type CheckInput, type CheckOutput } from './schema.ts'
import { checkScorer } from './scorer.ts'

/** Ordinary steps; the test step and `make check` (which bundles the tests) get {@link DEFAULT_TEST_IDLE_SECONDS}. */
const DEFAULT_STEP_IDLE_SECONDS = 180
const DEFAULT_TEST_IDLE_SECONDS = 600
/** The runtime's step idle timer is a backstop above the command's own watchdog, which always fires first. */
const BACKSTOP_MARGIN_MS = 60_000
const GIT_WALL_MS = 30_000
const MAX_ERROR_LINES = 50
const LINE_MAX_CHARS = 500
/** A probe that fails for any reason but a definitive answer is retried, never journaled as a verdict. */
const PROBE_RETRY = { attempts: 3, backoffMs: 500 }

type Step = CheckOutput['steps'][number]
/** A deterministic step's verdict with its one-line summary fragment. */
type StepResult = { step: Step; summary: string }

/** What the module can be given beyond the host's shared deps (which it does not use). */
export interface CheckDeps {
  /** Subprocess port; default `Bun.spawn`. */
  exec?: Exec
  /** Where the process groups of running commands are recorded; default the host's state directory. */
  stateDir?: string
  logger?: Pick<Logger, 'warn'>
}

/** The last non-empty output lines, bounded per line: the contract wants error lines, not a second log. */
export function errorLines(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line !== '')
    .slice(-MAX_ERROR_LINES)
    .map((line) => (line.length > LINE_MAX_CHARS ? `${line.slice(0, LINE_MAX_CHARS)}…` : line))
}

function stepResult(name: string, argv: string[], idleSeconds: number, result: ExecResult): StepResult {
  const label = argv.join(' ')
  if (!result.idleKilled && result.exitCode === 0) return { step: { name, passed: true }, summary: `${label} passed` }
  const lines = errorLines(result.output)
  const errors = result.idleKilled
    ? [`no output for ${idleSeconds}s — likely a watch-mode runner or a hung process`, ...lines]
    : lines
  return {
    step: {
      name,
      passed: false,
      errors: errors.length > 0 ? errors : [`${label} failed (exit ${result.exitCode}) with no output`],
    },
    summary: result.idleKilled
      ? `${label} failed: no output for ${idleSeconds}s`
      : `${label} failed (exit ${result.exitCode})`,
  }
}

interface Context {
  exec: Exec
  stateDir: string
  logger: Pick<Logger, 'warn'>
}

async function runStep(
  context: Context,
  scope: StepScope,
  options: { name: string; argv: string[]; cwd: string; idleSeconds: number },
): Promise<StepResult> {
  const { name, argv, cwd, idleSeconds } = options
  const result = await context.exec.run({
    argv,
    cwd,
    idleMs: idleSeconds * 1000,
    signal: scope.signal,
    onOutput: scope.progress,
    groupFile: join(context.stateDir, 'check', `${scope.key.replaceAll(/[^\w.-]/g, '_')}.group`),
  })
  if (result.aborted) throw scope.signal.reason // cancel, shutdown or lease loss: the runtime decides what that means
  if (result.exitCode === null && !result.idleKilled && !result.timedOut) {
    // Something else killed the command (an OOM kill, an operator): not a verdict on the repo, the step runs again.
    throw new InfraError(`${argv.join(' ')} was killed by ${result.signalCode ?? 'a signal'}, not by this host`)
  }
  return stepResult(name, argv, idleSeconds, result)
}

/**
 * Why `cwd` is not a git work tree, or null when it is. Only a definitive answer is a refusal; a probe that failed
 * for any other reason throws, so the step is retried instead of journaling a verdict about the caller's input.
 */
async function workTreeRefusal(exec: Exec, cwd: string, signal: AbortSignal): Promise<string | null> {
  try {
    if (!statSync(cwd).isDirectory()) return `cwd is not a directory: ${cwd}`
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return `cwd does not exist: ${cwd}`
    throw error
  }
  const probe = await exec.run({
    argv: ['git', 'rev-parse', '--is-inside-work-tree'],
    cwd,
    wallMs: GIT_WALL_MS,
    signal,
  })
  if (probe.aborted) throw signal.reason
  const answer = probe.output.trim()
  if (probe.exitCode === 0 && answer === 'true') return null
  if (probe.exitCode === 0 && answer === 'false') return `cwd is not a git work tree: ${cwd}`
  if (probe.exitCode === 128 && /not a git repository/i.test(answer)) return `cwd is not a git work tree: ${cwd}`
  throw new Error(`git rev-parse failed (exit ${probe.exitCode}${probe.timedOut ? ', timed out' : ''}): ${answer}`)
}

async function fallowApplies(exec: Exec, cwd: string, signal: AbortSignal): Promise<boolean> {
  if (!exec.which('fallow')) return false
  const remotes = await exec.run({ argv: ['git', 'remote'], cwd, wallMs: GIT_WALL_MS, stderr: 'discard', signal })
  if (remotes.aborted) throw signal.reason
  if (remotes.exitCode !== 0) throw new Error(`git remote failed (exit ${remotes.exitCode})`)
  return remotes.output.trim() !== ''
}

/** `make check`, then `fallow audit` when it applies. No model: the exit codes are the verdict. */
async function contractCheck(
  context: Context,
  ctx: Ctx,
  options: { cwd: string; idleSeconds: number; fallow: boolean },
): Promise<CheckOutput> {
  const { cwd, idleSeconds } = options
  // The runtime's own idle timer must not cut a long but chatty command: every output chunk feeds it.
  const stepOptions = { idleTimeoutMs: idleSeconds * 1000 + BACKSTOP_MARGIN_MS }
  const make = await ctx.step(
    'make-check',
    (scope) => runStep(context, scope, { name: 'check', argv: ['make', 'check'], cwd, idleSeconds }),
    stepOptions,
  )
  const fallow = options.fallow
    ? await ctx.step(
        'fallow',
        (scope) => runStep(context, scope, { name: 'fallow', argv: ['fallow', 'audit', '--quiet'], cwd, idleSeconds }),
        stepOptions,
      )
    : null
  const results = fallow ? [make, fallow] : [make]
  return {
    passed: results.every((result) => result.step.passed),
    steps: results.map((result) => result.step),
    summary: results.map((result) => result.summary).join('; '),
  }
}

const isInvalidOutput = (error: unknown) => error instanceof StepFailed && error.stepKind === 'invalid_output'

/** One agent step, one retry with a JSON-only directive; two invalid replies are a failed check, not a crash. */
async function agentCheck(ctx: Ctx, input: CheckInput, stepSeconds: number, testSeconds: number): Promise<CheckOutput> {
  const idleMs = agentIdleMs(stepSeconds, testSeconds)
  const prompt = agentPrompt({ cwd: input.cwd, commands: input.commands, stepSeconds, testSeconds, idleMs })
  const spec = {
    agent: 'check',
    output: CHECK_OUTPUT,
    idleTimeoutMs: idleMs,
    // `allowDirectories`: the agent works in its compiled location, so the checked tree is an external directory.
    options: { output: 'json', allowDirectories: [input.cwd] },
  }
  try {
    return await ctx.agent('agent', { ...spec, prompt })
  } catch (error) {
    if (!isInvalidOutput(error)) throw error
  }
  try {
    return await ctx.agent('agent-retry', { ...spec, prompt: prompt + JSON_ONLY_RETRY })
  } catch (error) {
    if (!isInvalidOutput(error)) throw error
    return {
      passed: false,
      steps: [],
      summary: `check agent returned invalid output twice: ${(error as Error).message}`,
    }
  }
}

/**
 * `check` (concept §11 P1): the repo's validation as a workflow. `make check` runs without a model when the
 * Makefile has the target and no commands were given; otherwise one agent step discovers or runs the steps.
 */
export function createCheckWorkflows(shared: CheckDeps | WorkflowDeps = {}): HostWorkflow[] {
  const deps = shared as CheckDeps // the host's WorkflowDeps carry none of the module's own injectables
  const context: Context = {
    exec: deps.exec ?? bunExec,
    stateDir: deps.stateDir ?? DEFAULT_STATE_DIR,
    logger: deps.logger ?? { warn: (message, meta) => console.warn('[agw-check]', message, meta ?? '') },
  }
  const workflow = defineWorkflow({
    id: 'check',
    version: '2026-10-28.2',
    input: CHECK_INPUT,
    output: CHECK_OUTPUT,
    scorer: checkScorer,
    async run(ctx, input) {
      const stepSeconds = input.stepTimeoutSeconds ?? DEFAULT_STEP_IDLE_SECONDS
      const testSeconds = input.stepTimeoutSeconds ?? DEFAULT_TEST_IDLE_SECONDS
      const plan = await ctx.step(
        'plan',
        async ({ signal }) => {
          const refusal = await workTreeRefusal(context.exec, input.cwd, signal)
          // The caller's commands win over the repo contract.
          const makeCheck =
            refusal === null &&
            !input.commands?.length &&
            (await hasMakeCheckTarget(context.exec, input.cwd, { signal, logger: context.logger }))
          const fallow = makeCheck && (await fallowApplies(context.exec, input.cwd, signal))
          return { refusal, makeCheck, fallow }
        },
        { retry: PROBE_RETRY },
      )
      if (plan.refusal) throw new WorkflowError('invalid_input', plan.refusal)
      return plan.makeCheck
        ? contractCheck(context, ctx, { cwd: input.cwd, idleSeconds: testSeconds, fallow: plan.fallow })
        : agentCheck(ctx, input, stepSeconds, testSeconds)
    },
  })
  return [
    {
      workflow,
      summary: 'Run a repo’s validation (make check, else an agent discovers format/lint/typecheck/test)',
      // `commands` is an array: `--commands '["bun test","bun run lint"]'` (the CLI parses JSON for non-scalars)
      cli: {},
      agents: [{ agent: 'check', route: 'check' }],
    },
  ]
}

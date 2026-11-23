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
import { agentIdleMs, agentPrompt, SUBMIT_RESULT_RETRY } from './prompt.ts'
import { CHECK_INPUT, CHECK_OUTPUT, type CheckInput, type CheckOutput } from './schema.ts'
import { checkScorer } from './scorer.ts'
import { inSlot, slotBusy } from './slot.ts'

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
type StepResult = { step: Step; summary: string; busy?: true }

/** What the module can be given beyond the host's shared deps (which it does not use). */
export interface CheckDeps {
  /** Subprocess port; default `Bun.spawn`. */
  exec?: Exec
  /** Where the process groups of running commands are recorded; default the host's state directory. */
  stateDir?: string
  logger?: Pick<Logger, 'warn'>
  /** Where `FACTORY_SLOT_WAIT_MS` is read from; default the host's environment. */
  env?: Record<string, string | undefined>
}

/** A passing or skipped test's line from bun's reporter: progress, never a reason a step failed. */
const PASSING_TEST_LINE = /^\s*\((pass|skip|todo)\) /

/**
 * The last non-empty output lines, bounded per line: the contract wants error lines, not a second log. Bun's passing
 * test lines are dropped (a red suite prints hundreds of them above its one failure); an output of nothing else keeps
 * them, so a failed step never loses all its evidence.
 */
function errorLines(output: string): string[] {
  const lines = output
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line !== '')
  const failing = lines.filter((line) => !PASSING_TEST_LINE.test(line))
  return (failing.length > 0 ? failing : lines)
    .slice(-MAX_ERROR_LINES)
    .map((line) => (line.length > LINE_MAX_CHARS ? `${line.slice(0, LINE_MAX_CHARS)}…` : line))
}

function stepResult(name: string, label: string, idleSeconds: number, result: ExecResult): StepResult {
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
  env: Record<string, string | undefined>
}

/** The verdict when the factory's slot wait ran out: the command never ran, so the repo is neither green nor red. */
function busyResult(name: string, label: string, waitedMs: number): StepResult {
  const message = `machine busy, not a failure: no test slot within ${Math.round(waitedMs / 1000)}s, ${label} did not run; run it again later`
  return { step: { name, passed: false, errors: [message] }, summary: message, busy: true }
}

async function runStep(
  context: Context,
  scope: StepScope,
  options: { name: string; argv: string[]; cwd: string; idleSeconds: number; slot?: boolean; label?: string },
): Promise<StepResult> {
  const { name, argv, cwd, idleSeconds } = options
  const label = options.label ?? argv.join(' ')
  // The heavy phase waits for a factory test slot when `factory` is installed; the wait writes nothing, so the idle
  // window grows by the longest wait.
  const slot = options.slot ? inSlot(context.exec, cwd, argv, context.env) : null
  const result = await context.exec.run({
    argv: slot?.argv ?? argv,
    cwd,
    env: slot?.env,
    idleMs: idleSeconds * 1000 + (slot?.idleExtraMs ?? 0),
    signal: scope.signal,
    onOutput: scope.progress,
    groupFile: join(context.stateDir, 'check', `${scope.key.replaceAll(/[^\w.-]/g, '_')}.group`),
  })
  if (result.aborted) throw scope.signal.reason // cancel, shutdown or lease loss: the runtime decides what that means
  if (slot && slotBusy(result)) return busyResult(name, label, slot.idleExtraMs)
  if (result.exitCode === null && !result.idleKilled && !result.timedOut) {
    // Something else killed the command (an OOM kill, an operator): not a verdict on the repo, the step runs again.
    throw new InfraError(`${label} was killed by ${result.signalCode ?? 'a signal'}, not by this host`)
  }
  return stepResult(name, label, idleSeconds, result)
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
    env: { LC_ALL: 'C' }, // the "not a git repository" test below reads git's English message
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
  // `make check` bundles install, format, lint, tsc and the tests: the slot covers the lot, the repo's Makefile
  // being the only place that could split the heavy part out.
  const slotted = inSlot(context.exec, cwd, [], context.env)
  const makeOptions = { idleTimeoutMs: stepOptions.idleTimeoutMs + (slotted?.idleExtraMs ?? 0) }
  const make = await ctx.step(
    'make-check',
    (scope) => runStep(context, scope, { name: 'check', argv: ['make', 'check'], cwd, idleSeconds, slot: true }),
    makeOptions,
  )
  // A machine that had no slot for the tests is not asked for more.
  const fallow =
    options.fallow && !make.busy
      ? await ctx.step(
          'fallow',
          (scope) =>
            runStep(context, scope, { name: 'fallow', argv: ['fallow', 'audit', '--quiet'], cwd, idleSeconds }),
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

/** Step names by what the command runs, in the contract's vocabulary; any other command is named after its tool. */
const STEP_KINDS: [name: string, pattern: RegExp][] = [
  ['check', /^\s*make\s+check\s*$/], // the repo contract by hand: named as on the contract path
  ['typecheck', /\b(tsc|typecheck|type-check|mypy|pyrefly|pyright)\b|\bty check\b/],
  ['test', /\b(test|tests|pytest|vitest|jest)\b/],
  ['format', /\b(format|fmt|oxfmt|prettier|gofmt)\b|\bruff format\b/],
  ['lint', /\b(lint|eslint|oxlint|ruff|clippy|biome)\b/],
]
/** The commands that hold the machine: the typecheck and the tests wait for a factory test slot, format and lint do not. */
const HEAVY_STEP = /^(typecheck|test)$/

/** The step's name for a caller's command: `format | lint | typecheck | test`, else the command's tool. */
function commandStepName(command: string): string {
  const kind = STEP_KINDS.find(([, pattern]) => pattern.test(command))
  if (kind) return kind[0]
  const tool = command.trim().split(/\s+/)[0] ?? command
  return tool.split('/').at(-1) || tool
}

/**
 * The caller's commands, each through `sh -c` in the checked tree, in order, in one journaled step (a step id is a
 * literal, so a command has none of its own: a resume runs them all again). No model: the exit codes are the verdict.
 * A red command does not stop the rest (the report keeps every step that ran); a heavy command that found no slot
 * says so on its own step.
 */
async function commandsCheck(
  context: Context,
  ctx: Ctx,
  options: { cwd: string; commands: string[]; stepSeconds: number; testSeconds: number },
): Promise<CheckOutput> {
  const { cwd, commands, stepSeconds, testSeconds } = options
  const plan = commands.map((command) => {
    const name = commandStepName(command)
    const heavy = HEAVY_STEP.test(name)
    return { command, name, heavy, idleSeconds: heavy ? testSeconds : stepSeconds }
  })
  // The runtime's idle timer is fed by every output chunk of every command, so it needs the largest single silence.
  const slotted = plan.some((entry) => entry.heavy) ? inSlot(context.exec, cwd, [], context.env) : null
  const idleTimeoutMs =
    Math.max(...plan.map((entry) => entry.idleSeconds)) * 1000 + BACKSTOP_MARGIN_MS + (slotted?.idleExtraMs ?? 0)
  const results = await ctx.step(
    'commands',
    async (scope) => {
      const done: StepResult[] = []
      for (const { command, name, heavy, idleSeconds } of plan) {
        const argv = ['sh', '-c', command]
        done.push(await runStep(context, scope, { name, argv, cwd, idleSeconds, slot: heavy, label: command }))
      }
      return done
    },
    { idleTimeoutMs },
  )
  const failed = results.filter((result) => !result.step.passed)
  return {
    passed: failed.length === 0,
    steps: results.map((result) => result.step),
    summary:
      failed.length === 0
        ? `All ${results.length} steps passed`
        : `${failed.length}/${results.length} steps failed: ${failed.map((result) => result.summary).join('; ')}`,
  }
}

const isInvalidOutput = (error: unknown) => error instanceof StepFailed && error.stepKind === 'invalid_output'

/** DISCOVER: one agent step, one retry with a JSON-only directive; two invalid replies are a failed check, not a crash. */
async function agentCheck(
  context: Context,
  ctx: Ctx,
  input: CheckInput,
  stepSeconds: number,
  testSeconds: number,
): Promise<CheckOutput> {
  // The agent's heavy steps wait for a factory test slot (run-step.sh), which is silent for as long as the wait.
  const idleMs = agentIdleMs(stepSeconds, testSeconds, inSlot(context.exec, input.cwd, [], context.env)?.idleExtraMs)
  const prompt = agentPrompt({ cwd: input.cwd, stepSeconds, testSeconds, idleMs })
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
    return await ctx.agent('agent-retry', { ...spec, prompt: prompt + SUBMIT_RESULT_RETRY })
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
 * `check` (concept §11 P1): the repo's validation as a workflow, without a model wherever the steps are known: the
 * caller's `commands` run in order, else `make check` when the Makefile has the target. Only discovery (neither) is
 * one agent step.
 */
export function createCheckWorkflows(shared: CheckDeps | WorkflowDeps = {}): HostWorkflow[] {
  const deps = shared as CheckDeps // the host's WorkflowDeps carry none of the module's own injectables
  const context: Context = {
    exec: deps.exec ?? bunExec,
    stateDir: deps.stateDir ?? DEFAULT_STATE_DIR,
    logger: deps.logger ?? { warn: (message, meta) => console.warn('[agw-check]', message, meta ?? '') },
    env: deps.env ?? process.env,
  }
  const workflow = defineWorkflow({
    id: 'check',
    version: '2026-11-23.1',
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
      if (input.commands?.length) {
        return commandsCheck(context, ctx, { cwd: input.cwd, commands: input.commands, stepSeconds, testSeconds })
      }
      return plan.makeCheck
        ? contractCheck(context, ctx, { cwd: input.cwd, idleSeconds: testSeconds, fallow: plan.fallow })
        : agentCheck(context, ctx, input, stepSeconds, testSeconds)
    },
  })
  return [
    {
      workflow,
      summary:
        'Run a repo’s validation (the given commands, else make check, else an agent discovers format/lint/typecheck/test)',
      // `commands` is an array: `--commands '["bun test","bun run lint"]'` (the CLI parses JSON for non-scalars)
      cli: {},
      agents: [{ agent: 'check', route: 'check' }],
    },
  ]
}

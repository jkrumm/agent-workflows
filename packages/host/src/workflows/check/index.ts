import { statSync } from 'node:fs'
import { type Ctx, defineWorkflow, StepFailed, type StepScope, WorkflowError } from '@agent-workflows/runtime'
import type { HostWorkflow } from '../../operations.ts'
import type { WorkflowDeps } from '../index.ts'
import { type Exec, type ExecResult, bunExec } from './exec.ts'
import { hasMakeCheckTarget } from './make.ts'
import { agentIdleMs, agentPrompt, JSON_ONLY_RETRY } from './prompt.ts'
import { CHECK_INPUT, CHECK_OUTPUT, type CheckInput, type CheckOutput } from './schema.ts'

/** Ordinary steps; the test step and `make check` (which bundles the tests) get {@link DEFAULT_TEST_IDLE_SECONDS}. */
const DEFAULT_STEP_IDLE_SECONDS = 180
const DEFAULT_TEST_IDLE_SECONDS = 600
/** The runtime's step idle timer is a backstop above the command's own watchdog, which always fires first. */
const BACKSTOP_MARGIN_MS = 60_000
const GIT_WALL_MS = 30_000
const MAX_ERROR_LINES = 50
const LINE_MAX_CHARS = 500

type Step = CheckOutput['steps'][number]
/** A deterministic step's verdict with its one-line summary fragment. */
type StepResult = { step: Step; summary: string }

export interface CheckDeps extends Partial<WorkflowDeps> {
  /** Subprocess port; default `Bun.spawn`. */
  exec?: Exec
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

function stepResult(name: Step['name'], argv: string[], idleSeconds: number, result: ExecResult): StepResult {
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

async function runStep(
  exec: Exec,
  scope: StepScope,
  options: { name: Step['name']; argv: string[]; cwd: string; idleSeconds: number },
): Promise<StepResult> {
  const { name, argv, cwd, idleSeconds } = options
  const result = await exec.run({
    argv,
    cwd,
    idleMs: idleSeconds * 1000,
    signal: scope.signal,
    onOutput: scope.progress,
  })
  if (result.aborted) throw scope.signal.reason // cancel, shutdown or lease loss: the runtime decides what that means
  return stepResult(name, argv, idleSeconds, result)
}

/** Whether `cwd` is a directory inside a git work tree; the reason when it is not. */
async function refuseUnlessWorkTree(exec: Exec, cwd: string): Promise<string | null> {
  let isDirectory = false
  try {
    isDirectory = statSync(cwd).isDirectory()
  } catch {
    // reported below
  }
  if (!isDirectory) return `cwd is not an existing directory: ${cwd}`
  const probe = await exec.run({
    argv: ['git', 'rev-parse', '--is-inside-work-tree'],
    cwd,
    wallMs: GIT_WALL_MS,
    stderr: 'discard',
  })
  return probe.exitCode === 0 && probe.output.trim() === 'true' ? null : `cwd is not a git work tree: ${cwd}`
}

async function fallowApplies(exec: Exec, cwd: string): Promise<boolean> {
  if (!exec.which('fallow')) return false
  const remotes = await exec.run({ argv: ['git', 'remote'], cwd, wallMs: GIT_WALL_MS, stderr: 'discard' })
  return remotes.exitCode === 0 && remotes.output.trim() !== ''
}

/** `make check`, then `fallow audit` when it applies. No model: the exit codes are the verdict. */
async function contractCheck(exec: Exec, ctx: Ctx, cwd: string, idleSeconds: number): Promise<CheckOutput> {
  // The runtime's own idle timer must not cut a long but chatty command: every output chunk feeds it.
  const options = { idleTimeoutMs: idleSeconds * 1000 + BACKSTOP_MARGIN_MS }
  const make = await ctx.step(
    'make-check',
    (scope) => runStep(exec, scope, { name: 'check', argv: ['make', 'check'], cwd, idleSeconds }),
    options,
  )
  const fallow = await ctx.step(
    'fallow',
    async (scope) =>
      (await fallowApplies(exec, cwd))
        ? runStep(exec, scope, { name: 'fallow', argv: ['fallow', 'audit', '--quiet'], cwd, idleSeconds })
        : null,
    options,
  )
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
  const prompt = agentPrompt({ cwd: input.cwd, commands: input.commands, idleMs })
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
export function createCheckWorkflows(deps: CheckDeps = {}): HostWorkflow[] {
  const exec = deps.exec ?? bunExec
  const workflow = defineWorkflow({
    id: 'check',
    version: '2026-10-28.1',
    input: CHECK_INPUT,
    output: CHECK_OUTPUT,
    async run(ctx, input) {
      const stepSeconds = input.stepTimeoutSeconds ?? DEFAULT_STEP_IDLE_SECONDS
      const testSeconds = input.stepTimeoutSeconds ?? DEFAULT_TEST_IDLE_SECONDS
      const plan = await ctx.step('plan', async () => {
        const refusal = await refuseUnlessWorkTree(exec, input.cwd)
        // The caller's commands win over the repo contract.
        const makeCheck = refusal === null && !input.commands?.length && (await hasMakeCheckTarget(exec, input.cwd))
        return { refusal, makeCheck }
      })
      if (plan.refusal) throw new WorkflowError('invalid_input', plan.refusal)
      return plan.makeCheck
        ? contractCheck(exec, ctx, input.cwd, testSeconds)
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

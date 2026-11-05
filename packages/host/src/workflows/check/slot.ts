import { availableParallelism } from 'node:os'
import { basename } from 'node:path'
import type { Exec } from './exec.ts'

/**
 * The machine budget (software-factory RS10 (b)): when `factory` is on PATH, the heavy phase of a check runs inside
 * `factory slot run`, so every agent's check on the mini shares the factory's test slots. Without `factory` (CI, other
 * machines) nothing changes.
 */

/** sysexits `EX_TEMPFAIL`: `factory slot run` ran out of wait and did not run the command. */
const SLOT_EXIT_BUSY = 75
/** What `factory slot run` writes when the wait ran out (a command that itself exits 75 does not say this). */
const SLOT_BUSY_LINE = 'factory: no test slot within'
/** `factory slot run`'s default wait (`FACTORY_SLOT_WAIT_MS`). */
const DEFAULT_SLOT_WAIT_MS = 45 * 60_000

type Env = Record<string, string | undefined>

/** A linked worktree (`<repo>/.claude/worktrees/<name>`) is named after its repo, not its directory. */
export function repoLabel(cwd: string): string {
  const match = /^(.*)\/\.claude\/worktrees\/[^/]+(?:\/.*)?$/.exec(cwd)
  return basename(match?.[1] ?? cwd)
}

/**
 * Half the cores, at least one: what the wrapped test runners may use. The variable names are the runners' own
 * (README §Machine budget): vitest reads `VITEST_MAX_WORKERS`; `bun test` runs serially unless `--parallel` is passed and
 * has no variable; jest takes `--maxWorkers` only.
 */
export function workerCapEnv(cores = availableParallelism()): Record<string, string> {
  return { VITEST_MAX_WORKERS: String(Math.max(1, Math.floor(cores / 2))) }
}

/** How long `factory slot run` may wait for a slot, and so how long the wrapped command may be silent before it starts. */
export function slotWaitMs(env: Env): number {
  const value = env.FACTORY_SLOT_WAIT_MS
  const parsed = Number(value)
  return value !== undefined && value !== '' && Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_SLOT_WAIT_MS
}

export interface SlotRun {
  argv: string[]
  env: Record<string, string>
  /** Extra silence the idle watchdog allows: the wait for a slot writes nothing. */
  idleExtraMs: number
}

/** `argv` inside a test slot, or null when `factory` is not installed. */
export function inSlot(exec: Exec, cwd: string, argv: string[], env: Env): SlotRun | null {
  if (!exec.which('factory')) return null
  return {
    argv: ['factory', 'slot', 'run', '--name', `agw-check:${repoLabel(cwd)}`, '--', ...argv],
    env: workerCapEnv(),
    idleExtraMs: slotWaitMs(env),
  }
}

/** True when the slot's wait ran out and the command never ran: the machine is busy, the repo is not red. */
export function slotBusy(result: { exitCode: number | null; output: string }): boolean {
  return result.exitCode === SLOT_EXIT_BUSY && result.output.includes(SLOT_BUSY_LINE)
}

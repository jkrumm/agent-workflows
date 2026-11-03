import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { helperEnv, killTree } from '../workflows/review/exec.ts'

// The one source of agent state is the factory (software-factory): `factory fleet --format json`. This file runs that
// CLI and parses its answer. It never throws: a factory that is down is a failure value the snapshot turns into a warning.

const FACTORY_TIMEOUT_MS = 10_000
const DEFAULT_STALE_HOURS = 24
const MAX_STDOUT_BYTES = 16 * 1024 * 1024 // the real fleet view is about 140 KB

export interface CommandResult {
  stdout: string
  stderr: string
  /** `null` when the process never ran to an exit: a spawn error or a timeout. */
  exitCode: number | null
  timedOut: boolean
  /** The child printed more than the byte budget and was killed; `stdout` holds nothing. */
  overflow?: boolean
  /** The spawn error's message, when there was one. */
  error?: string
}

/**
 * Runs a command and answers what it printed and how it ended; never rejects. The child gets the review helpers'
 * allowlist (`helperEnv`) plus the `extraEnv` of the call, never the host's own environment (`AGW_API_SECRET`,
 * `ARGO_API_SECRET`, `IU_API_KEY`).
 */
export type RunCommand = (
  cmd: string[],
  options?: { timeoutMs?: number; maxStdoutBytes?: number; extraEnv?: Record<string, string> },
) => Promise<CommandResult>

export function commandRunner(env: Record<string, string | undefined> = process.env): RunCommand {
  const base = helperEnv(env)
  return async (cmd, options = {}) => {
    let proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>
    try {
      proc = Bun.spawn(cmd, {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...base, ...options.extraEnv },
        detached: true, // its own process group: the timeout kills a grandchild holding the pipes too
      })
    } catch (error) {
      return { stdout: '', stderr: '', exitCode: null, timedOut: false, error: String(error) }
    }
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      killTree(proc, 'KILL')
    }, options.timeoutMs ?? FACTORY_TIMEOUT_MS)
    try {
      // stdout is counted per chunk against the byte budget: a runaway child is killed, never buffered whole.
      const budget = options.maxStdoutBytes ?? MAX_STDOUT_BYTES
      let overflow = false
      const readStdout = async (): Promise<string> => {
        const chunks: Uint8Array[] = []
        let bytes = 0
        for await (const chunk of proc.stdout) {
          bytes += chunk.byteLength
          if (bytes > budget) {
            overflow = true
            killTree(proc, 'KILL')
            return ''
          }
          chunks.push(chunk)
        }
        return Buffer.concat(chunks).toString('utf8')
      }
      const [stdout, stderr, exitCode] = await Promise.all([
        readStdout(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      return { stdout, stderr, exitCode: timedOut || overflow ? null : exitCode, timedOut, overflow }
    } catch (error) {
      return { stdout: '', stderr: '', exitCode: null, timedOut, error: String(error) }
    } finally {
      clearTimeout(timer)
    }
  }
}

export interface FleetConfig {
  /** The factory CLI (`AGW_FACTORY_BIN`; else `~/.local/bin/factory` when it exists, else `factory` on `PATH`). */
  factoryBin: string
  staleAfterHours: number
}

type Env = Record<string, string | undefined>

export function fleetConfig(env: Env, home = homedir()): FleetConfig {
  const override = env.AGW_FACTORY_BIN?.trim()
  const local = join(home, '.local', 'bin', 'factory')
  const hours = Number.parseInt(env.AGW_AGENT_STALE_HOURS ?? '', 10)
  return {
    factoryBin: override || (existsSync(local) ? local : 'factory'),
    staleAfterHours: Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_STALE_HOURS,
  }
}

// Only what agw reads, and not strict: the factory's own contract (`packages/contract/src/fleet.ts`) is strict on its
// side, a field it adds must never break this client.

const FACTORY_SESSION = z.object({
  id: z.string(),
  // A string, not the factory's enum: a state the factory adds degrades that one row to `unknown`, never the whole fleet.
  state: z.string(),
  hc: z.string().nullable().default(null),
  wait: z.string().nullable().default(null),
  account: z.string().nullable().default(null),
  terminal: z.string().nullable().default(null),
  plan: z.string().nullable().default(null),
  wave: z.number().nullable().default(null),
  title: z.string().nullable().default(null),
  headline: z.string().nullable().default(null),
  since: z.string().nullable().default(null),
  lastActivityAt: z.string().nullable().default(null),
})
export type FactorySession = z.infer<typeof FACTORY_SESSION>

const FACTORY_COMMIT = z.object({ sha: z.string(), subject: z.string(), at: z.string() })

export const FACTORY_FLEET = z.object({
  asks: z.array(z.object({ id: z.string(), kind: z.string(), text: z.string(), at: z.string() })).default([]),
  repos: z.array(
    z.object({
      name: z.string(),
      space: z.string(),
      git: z
        .object({
          branch: z.string().nullable().default(null),
          dirty: z.boolean().default(false),
          lastCommit: FACTORY_COMMIT.nullable().default(null),
        })
        .nullable()
        .default(null),
      sessions: z.array(FACTORY_SESSION).default([]),
    }),
  ),
  unplaced: z.array(FACTORY_SESSION).default([]),
  errors: z.array(z.string()).default([]),
})
export type FactoryFleet = z.infer<typeof FACTORY_FLEET>

export type FactoryRead = { ok: true; fleet: FactoryFleet } | { ok: false; warning: string }

const firstLine = (text: string) => text.trim().split('\n')[0]?.trim() ?? ''

/** A factory failure as one warning: the exit code and the first line of stderr, or the spawn error / timeout. */
export function failureWarning(result: CommandResult, timeoutMs: number): string {
  if (result.overflow) return 'factory fleet failed: output over the size limit'
  if (result.timedOut) return `factory fleet failed: timed out after ${Math.round(timeoutMs / 1000)} s`
  if (result.exitCode === null) return `factory fleet failed: ${firstLine(result.error ?? '') || 'could not be run'}`
  const detail = firstLine(result.stderr)
  return `factory fleet failed (exit ${result.exitCode})${detail ? `: ${detail}` : ''}`
}

/**
 * One `factory fleet --format json` read. `FACTORY_TOKEN` (and `FACTORY_URL`, when set) come from the host's
 * environment; without the token the CLI exits 3 and that is the warning.
 */
export async function readFactoryFleet(
  run: RunCommand,
  config: Pick<FleetConfig, 'factoryBin'>,
  env: Env,
  limits: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<FactoryRead> {
  const timeoutMs = limits.timeoutMs ?? FACTORY_TIMEOUT_MS
  const extraEnv: Record<string, string> = {}
  for (const name of ['FACTORY_TOKEN', 'FACTORY_URL']) {
    const value = env[name]
    if (value) extraEnv[name] = value
  }
  const result = await run([config.factoryBin, 'fleet', '--format', 'json'], {
    timeoutMs,
    maxStdoutBytes: limits.maxBytes,
    extraEnv,
  })
  if (result.exitCode !== 0) return { ok: false, warning: failureWarning(result, timeoutMs) }
  let raw: unknown
  try {
    raw = JSON.parse(result.stdout)
  } catch {
    return { ok: false, warning: 'factory fleet failed: output is not JSON' }
  }
  const parsed = FACTORY_FLEET.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return { ok: false, warning: `factory fleet failed: unexpected shape at ${issue?.path.join('.') || '(root)'}` }
  }
  return { ok: true, fleet: parsed.data }
}

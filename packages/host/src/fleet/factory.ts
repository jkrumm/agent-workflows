import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { z } from 'zod'
import { helperEnv, killTree } from '../process.ts'
import { oneLine, truncate } from './text.ts'

// The one source of agent state is the factory (software-factory), read through its /v1 read API: `factory read overview`
// (the asks and the human queue) and `factory read sessions --live` (the session cards). This file runs both CLI calls and
// maps their answers onto `FactoryFleet`, agw's own model of the fleet. It never throws: a factory that is down is a
// failure value the snapshot turns into a warning.

const FACTORY_TIMEOUT_MS = 10_000
const DEFAULT_STALE_HOURS = 24
const MAX_STDOUT_BYTES = 16 * 1024 * 1024 // the live session cards are well under 1 MB
const MAX_STDERR_BYTES = 64 * 1024 // a diagnostic, never a payload
export const MAX_WARNING_CHARS = 300

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

/**
 * Reads a child's pipe against a byte budget, counted per chunk. Past it `onOverflow` runs (the caller kills the tree)
 * and what was read so far is kept up to the budget; the rest is never buffered.
 */
async function readCapped(
  stream: ReadableStream<Uint8Array>,
  budget: number,
  onOverflow: () => void,
): Promise<{ text: string; overflow: boolean }> {
  const chunks: Uint8Array[] = []
  let bytes = 0
  for await (const chunk of stream) {
    if (bytes + chunk.byteLength > budget) {
      chunks.push(chunk.subarray(0, budget - bytes))
      onOverflow()
      return { text: Buffer.concat(chunks).toString('utf8'), overflow: true }
    }
    bytes += chunk.byteLength
    chunks.push(chunk)
  }
  return { text: Buffer.concat(chunks).toString('utf8'), overflow: false }
}

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
      const kill = () => killTree(proc, 'KILL')
      const [out, err, exitCode] = await Promise.all([
        readCapped(proc.stdout, options.maxStdoutBytes ?? MAX_STDOUT_BYTES, kill),
        readCapped(proc.stderr, MAX_STDERR_BYTES, kill),
        proc.exited,
      ])
      // A stdout past its budget is no answer (and is not kept); stderr past its cap keeps the capped diagnostic.
      return {
        stdout: out.overflow ? '' : out.text,
        stderr: err.text,
        exitCode: timedOut || out.overflow ? null : exitCode,
        timedOut,
        overflow: out.overflow,
      }
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

// The agw model of the fleet: what `derive.ts` and `mapFleet` read. `FactoryFleet` is built from the two read answers below.

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

// The /v1 answers, only what agw reads and not strict: within /v1 a field is only ever added, so one the factory adds
// must never break this client (schema source: software-factory `packages/contract/src/read.ts`).

const READ_ASK = z.object({ id: z.string(), kind: z.string(), text: z.string(), at: z.string() })

const READ_OVERVIEW = z.object({
  asks: z.array(READ_ASK).default([]),
  humanQueue: z.array(READ_ASK).default([]),
})

const READ_SESSION = z.object({
  id: z.string(),
  state: z.string(),
  wait: z.string().nullable().default(null),
  account: z.string().nullable().default(null),
  terminal: z
    .object({ id: z.string().nullable().default(null), space: z.string().nullable().default(null) })
    .nullable()
    .default(null),
  repo: z.string().nullable().default(null),
  title: z.string().nullable().default(null),
  summary: z.string().nullable().default(null),
  since: z.string().nullable().default(null),
  lastActivityAt: z.string().nullable().default(null),
})
type ReadSession = z.infer<typeof READ_SESSION>

const READ_SESSIONS = z.object({ sessions: z.array(READ_SESSION) })

/** The /v1 session card as agw's session. The read API has no hc word: a blocked terminal shows as its `state`. */
const toSession = (card: ReadSession): FactorySession => ({
  id: card.id,
  state: card.state,
  hc: null,
  wait: card.wait,
  account: card.account,
  terminal: card.terminal?.id ?? null,
  plan: null,
  wave: null,
  title: card.title,
  headline: card.summary,
  since: card.since,
  lastActivityAt: card.lastActivityAt,
})

/**
 * The cards grouped by their herdr space (a worktree session falls under its repo's space), else by their repo path;
 * a card with neither is unplaced. The read API carries no git facts: `git` is null.
 */
function buildFleet(overview: z.infer<typeof READ_OVERVIEW>, cards: ReadSession[]): FactoryFleet {
  const repos = new Map<string, FactorySession[]>()
  const unplaced: FactorySession[] = []
  for (const card of cards) {
    const key = card.terminal?.space ?? card.repo
    if (!key) {
      unplaced.push(toSession(card))
      continue
    }
    repos.set(key, [...(repos.get(key) ?? []), toSession(card)])
  }
  // The human queue is `kind: human` by definition (derive.ts keys on it); an ask in both lists counts once.
  const asks = new Map<string, FactoryFleet['asks'][number]>()
  for (const { id, kind, text, at } of overview.asks) asks.set(id, { id, kind, text, at })
  for (const { id, text, at } of overview.humanQueue) asks.set(id, { id, kind: 'human', text, at })
  return {
    asks: [...asks.values()],
    repos: [...repos].map(([space, sessions]) => ({ name: basename(space), space, git: null, sessions })),
    unplaced,
    errors: [],
  }
}

/** The first non-empty line of a child's text, as one clean line of at most {@link MAX_WARNING_CHARS} characters. */
const firstLine = (text: string) =>
  truncate(
    oneLine(
      text
        .trim()
        .split('\n')
        .find((l) => l.trim() !== '') ?? '',
    ),
    MAX_WARNING_CHARS,
  )

/** A factory failure as one warning: the command, the exit code and the first line of stderr, or the spawn error / timeout. */
export function failureWarning(result: CommandResult, timeoutMs: number, label: string): string {
  if (result.overflow) return `${label} failed: output over the size limit`
  if (result.timedOut) return `${label} failed: timed out after ${Math.round(timeoutMs / 1000)} s`
  if (result.exitCode === null) return `${label} failed: ${firstLine(result.error ?? '') || 'could not be run'}`
  const detail = firstLine(result.stderr)
  return `${label} failed (exit ${result.exitCode})${detail ? `: ${detail}` : ''}`
}

type Parsed<T> = { ok: true; value: T } | { ok: false; warning: string }

/**
 * The fleet from two reads, run in parallel: `factory read overview --format json` and
 * `factory read sessions --live --format json`. `FACTORY_TOKEN` (and `FACTORY_URL`, when set) come from the host's
 * environment; without the token the CLI exits 3 and that is the warning. One read failing fails the whole read.
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
  async function read<S extends z.ZodType>(args: string[], schema: S): Promise<Parsed<z.infer<S>>> {
    const label = `factory ${args.join(' ')}`
    const result = await run([config.factoryBin, ...args, '--format', 'json'], {
      timeoutMs,
      maxStdoutBytes: limits.maxBytes,
      extraEnv,
    })
    if (result.exitCode !== 0) return { ok: false, warning: failureWarning(result, timeoutMs, label) }
    let raw: unknown
    try {
      raw = JSON.parse(result.stdout)
    } catch {
      return { ok: false, warning: `${label} failed: output is not JSON` }
    }
    const parsed = schema.safeParse(raw)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      return { ok: false, warning: `${label} failed: unexpected shape at ${issue?.path.join('.') || '(root)'}` }
    }
    return { ok: true, value: parsed.data }
  }
  const [overview, sessions] = await Promise.all([
    read(['read', 'overview'], READ_OVERVIEW),
    read(['read', 'sessions', '--live'], READ_SESSIONS),
  ])
  if (!overview.ok) return overview
  if (!sessions.ok) return sessions
  return { ok: true, fleet: buildFleet(overview.value, sessions.value.sessions) }
}

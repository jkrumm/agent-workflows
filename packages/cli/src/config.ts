import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { AgwError } from './exit.ts'

export type Env = Record<string, string | undefined>

export const DEFAULT_URL = 'http://127.0.0.1:7791'
const DEFAULT_BUDGET_S = 110
// A hang guard, not a budget: a single model request gets at least 30 min (rules/agent-limits.md).
const DEFAULT_TIMEOUT_S = 1800

const home = (env: Env) => env.HOME || homedir()

export const envFilePath = (env: Env) => join(env.XDG_CONFIG_HOME || join(home(env), '.config'), 'agw', 'env')
/** One cache per host URL, so two hosts never share a contract. */
export const cachePath = (env: Env, url: string) =>
  join(
    env.XDG_CACHE_HOME || join(home(env), '.cache'),
    'agw',
    createHash('sha256').update(url).digest('hex').slice(0, 12),
    'openapi.json',
  )

function seconds(raw: string | undefined, fallback: number, min: number): number {
  const n = raw === undefined || raw.trim() === '' ? Number.NaN : Number(raw)
  return Number.isFinite(n) && n >= min ? n : fallback
}

export const waitBudgetS = (env: Env) => seconds(env.AGW_WAIT_BUDGET_S, DEFAULT_BUDGET_S, 0)

/** How long a call waits for a process that refuses connections while a deploy restarts it (`0` = never wait). */
const DEFAULT_RESTART_WAIT_S = 90
/** A process that refuses connections with no deploy in progress gets this long to come back (KeepAlive's own restart). */
const DOWN_WAIT_S = 30
/** A deliberate-restart marker younger than this means a deploy is restarting the process. */
const DEPLOYING_WINDOW_S = 180

/**
 * The longest a call waits out an unreachable process: the full bound (`AGW_RESTART_WAIT_S`, default 90) while a
 * deploy marked its restart, and at most 30 s otherwise, so a process that is simply down fails soon.
 */
export function restartBoundS(env: Env, label: string, nowMs = Date.now()): { boundS: number; deploying: boolean } {
  const full = seconds(env.AGW_RESTART_WAIT_S, DEFAULT_RESTART_WAIT_S, 0)
  const deploying = markedAgeS(env, label, nowMs) <= DEPLOYING_WINDOW_S
  return { boundS: deploying ? full : Math.min(full, DOWN_WAIT_S), deploying }
}

/**
 * Seconds since the LaunchAgent `label` was last stopped on purpose: `scripts/deploy.sh` appends one epoch line per
 * stop to `~/.local/state/devhost/deliberate-restart/<label>` (the dotfiles heartbeat reads the same file). Infinity
 * when there is none or it cannot be read.
 */
function markedAgeS(env: Env, label: string, nowMs: number): number {
  try {
    const file = join(home(env), '.local', 'state', 'devhost', 'deliberate-restart', label)
    const last = readFileSync(file, 'utf8').trim().split('\n').at(-1)
    const epoch = Number(last)
    return Number.isFinite(epoch) && epoch > 0 ? Math.max(0, nowMs / 1000 - epoch) : Number.POSITIVE_INFINITY
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

/** The deadline of one request that does not wait on a run: a capability call can run a model for minutes. */
export const timeoutS = (env: Env) => seconds(env.AGW_TIMEOUT_S, DEFAULT_TIMEOUT_S, Number.MIN_VALUE)

function parseEnvFile(text: string): Env {
  const out: Env = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim().replace(/^export\s+/, '')
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 1) continue
    const value = line.slice(eq + 1).trim()
    out[line.slice(0, eq).trim()] = value.replace(/^(['"])(.*)\1$/, '$2')
  }
  return out
}

/** `KEY=value` lines, refused unless mode 0600: the file holds the host's bearer secret. */
function readEnvFile(env: Env): Env {
  const path = envFilePath(env)
  const unreadable = (error: unknown) =>
    new AgwError('auth', `${path} cannot be read: ${error instanceof Error ? error.message : String(error)}`)
  let mode: number
  try {
    mode = statSync(path).mode & 0o777
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw unreadable(error)
  }
  if (mode !== 0o600) {
    throw new AgwError('auth', `${path} has mode ${mode.toString(8).padStart(4, '0')}, refused`, {
      hint: `chmod 600 ${path}`,
    })
  }
  try {
    return parseEnvFile(readFileSync(path, 'utf8'))
  } catch (error) {
    throw unreadable(error)
  }
}

/** A platform process besides the host: its own port and contract, the same secret. */
export interface ProcessTarget {
  name: string
  url: string
}

export interface Credentials {
  url: string
  secret: string | undefined
  /** The other processes, in declared order; the host (`AGW_URL`) is not among them. */
  processes: ProcessTarget[]
}

/** The name the host process goes by in messages and `agw schema`; no other process may take it. */
export const HOST_PROCESS = 'host'
const PROCESS_NAME = /^[a-z][a-z0-9-]*$/
const trimUrl = (url: string) => url.trim().replace(/\/+$/, '')

/** `AGW_PROCESSES=<name>=<url>[,<name>=<url>…]`; a malformed list is a usage error, never a silently dropped process. */
export function parseProcesses(raw: string | undefined, hostUrl: string): ProcessTarget[] {
  const out: ProcessTarget[] = []
  const bad = (message: string) =>
    new AgwError('usage', `AGW_PROCESSES: ${message}`, {
      hint: 'AGW_PROCESSES=audio=http://127.0.0.1:7792[,<name>=<url>…]',
    })
  for (const item of (raw ?? '').split(',')) {
    if (!item.trim()) continue
    const eq = item.indexOf('=')
    const name = item.slice(0, Math.max(eq, 0)).trim()
    const url = trimUrl(item.slice(eq + 1))
    if (eq < 1 || !url) throw bad(`"${item.trim()}" is not <name>=<url>`)
    if (!PROCESS_NAME.test(name)) throw bad(`process name "${name}" must match ${PROCESS_NAME.source}`)
    if (name === HOST_PROCESS) throw bad(`"${HOST_PROCESS}" is AGW_URL's process`)
    if (out.some((p) => p.name === name)) throw bad(`process "${name}" is listed twice`)
    if (url === hostUrl || out.some((p) => p.url === url)) throw bad(`${url} is listed for two processes`)
    out.push({ name, url })
  }
  return out
}

/**
 * The environment wins key by key; the env file is read only for what it leaves unset. The process list goes with
 * the host URL: an `AGW_URL` from the environment takes `AGW_PROCESSES` from the environment only, so a shell pointed
 * at another host never mixes in the deployed processes of the env file.
 */
export function credentials(env: Env): Credentials {
  const file = env.AGW_URL && env.AGW_API_SECRET ? {} : readEnvFile(env)
  const url = trimUrl(env.AGW_URL || file.AGW_URL || DEFAULT_URL)
  const processes = env.AGW_URL ? env.AGW_PROCESSES : (env.AGW_PROCESSES ?? file.AGW_PROCESSES)
  return {
    url,
    secret: env.AGW_API_SECRET || file.AGW_API_SECRET || undefined,
    processes: parseProcesses(processes, url),
  }
}

const LOOPBACK = new Set(['127.0.0.1', '[::1]', 'localhost'])

/** The bearer never leaves in cleartext: plain http only to loopback. */
export function assertSafeUrl(url: string, label = 'AGW_URL'): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new AgwError('auth', `${label} is not a URL: ${url}`)
  }
  if (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && LOOPBACK.has(parsed.hostname))) return
  throw new AgwError('auth', `refused to send the secret to ${url}: plain http is allowed only to loopback`, {
    hint: 'use https://, or http://127.0.0.1, http://[::1] or http://localhost',
  })
}

export function requireSecret(env: Env, creds: Credentials): string {
  if (creds.secret) return creds.secret
  throw new AgwError('auth', 'no AGW_API_SECRET found', {
    hint: `set AGW_API_SECRET or write it to ${envFilePath(env)} (mode 0600; make deploy writes it)`,
  })
}

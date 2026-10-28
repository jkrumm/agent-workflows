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

export interface Credentials {
  url: string
  secret: string | undefined
}

/** The environment wins key by key; the env file is read only for what it leaves unset. */
export function credentials(env: Env): Credentials {
  const file = env.AGW_URL && env.AGW_API_SECRET ? {} : readEnvFile(env)
  const url = (env.AGW_URL || file.AGW_URL || DEFAULT_URL).replace(/\/+$/, '')
  return { url, secret: env.AGW_API_SECRET || file.AGW_API_SECRET || undefined }
}

const LOOPBACK = new Set(['127.0.0.1', '[::1]', 'localhost'])

/** The bearer never leaves in cleartext: plain http only to loopback. */
export function assertSafeUrl(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new AgwError('auth', `AGW_URL is not a URL: ${url}`)
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

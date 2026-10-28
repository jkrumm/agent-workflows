import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { AgwError } from './exit.ts'

export type Env = Record<string, string | undefined>

export const DEFAULT_URL = 'http://127.0.0.1:7791'
const DEFAULT_BUDGET_S = 110

const home = (env: Env) => env.HOME || homedir()

export const envFilePath = (env: Env) => join(env.XDG_CONFIG_HOME || join(home(env), '.config'), 'agw', 'env')
export const cachePath = (env: Env) => join(env.XDG_CACHE_HOME || join(home(env), '.cache'), 'agw', 'openapi.json')

export function waitBudgetS(env: Env): number {
  const raw = env.AGW_WAIT_BUDGET_S
  const n = raw === undefined || raw.trim() === '' ? Number.NaN : Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_BUDGET_S
}

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
  let mode: number
  try {
    mode = statSync(path).mode & 0o777
  } catch {
    return {}
  }
  if (mode !== 0o600) {
    throw new AgwError('auth', `${path} has mode ${mode.toString(8).padStart(4, '0')}, refused`, {
      hint: `chmod 600 ${path}`,
    })
  }
  return parseEnvFile(readFileSync(path, 'utf8'))
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

export function requireSecret(env: Env, creds: Credentials): string {
  if (creds.secret) return creds.secret
  throw new AgwError('auth', 'no AGW_API_SECRET found', {
    hint: `set AGW_API_SECRET or write it to ${envFilePath(env)} (mode 0600; make deploy writes it)`,
  })
}

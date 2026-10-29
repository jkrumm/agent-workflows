import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fail } from '../errors.ts'
import type { Env } from '../transports/config.ts'
import type { HttpOptions } from '../transports/http.ts'

export type HdxEnv = 'local' | 'prod'

/** What the hdx capabilities are built from. Every field defaults to production; tests inject fakes. */
export interface HdxDeps {
  fetch?: (url: string, init: RequestInit) => Promise<Response>
  /** Where URLs and keys are read, on each call. Default `process.env`. */
  env?: Env
  /** The file holding `HYPERDX_LOCAL_ACCESS_KEY`, read on each call when the variable is unset. Default `~/.config/hyperdx/local.env`. */
  readLocalEnvFile?: () => string | undefined
  /** Retry knobs of the package's helper; tests set `backoffMs: 0`. */
  retry?: Pick<HttpOptions, 'attempts' | 'backoffMs'>
  /** For dashboard links. Default `Date.now`. */
  now?: () => number
  /** Per HTTP attempt, body included. Default 60 s. */
  timeoutMs?: number
}

export interface ResolvedHdxDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>
  env: () => Env
  readLocalEnvFile: () => string | undefined
  retry: Pick<HttpOptions, 'attempts' | 'backoffMs'>
  now: () => number
  timeoutMs: number
}

const LOCAL_ENV_FILE = join(homedir(), '.config', 'hyperdx', 'local.env')
const DEFAULT_LOCAL_URL = 'http://localhost:7707'

export function resolveHdxDeps(deps: HdxDeps = {}): ResolvedHdxDeps {
  return {
    fetch: deps.fetch ?? ((url, init) => fetch(url, init)),
    env: () => deps.env ?? process.env,
    readLocalEnvFile:
      deps.readLocalEnvFile ??
      (() => {
        try {
          return readFileSync(LOCAL_ENV_FILE, 'utf8')
        } catch {
          return undefined
        }
      }),
    retry: deps.retry ?? {},
    now: deps.now ?? Date.now,
    timeoutMs: deps.timeoutMs ?? 60_000,
  }
}

const envValue = (env: Env, name: string): string | undefined => env[name]?.trim() || undefined

/** `KEY=value` lines of a dotenv file; comments and blanks skipped, one pair of surrounding quotes removed. */
function dotenvValue(text: string, name: string): string | undefined {
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 1 || line.slice(0, eq).trim() !== name) continue
    return (
      line
        .slice(eq + 1)
        .trim()
        .replace(/^(["'])(.*)\1$/, '$2') || undefined
    )
  }
  return undefined
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * A base URL: https, or http on a loopback host only (the bearer key never crosses a network in the clear); no
 * credentials, query or fragment; no trailing slash. A malformed one is `NOT_CONFIGURED` (names the variable).
 */
function baseUrl(raw: string, variable: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw fail('NOT_CONFIGURED', `hdx unavailable: ${variable} is not a URL`)
  }
  const secure = url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))
  if (!secure) throw fail('NOT_CONFIGURED', `hdx unavailable: ${variable} must be https (http only for localhost)`)
  if (url.username || url.password || url.search || url.hash)
    throw fail('NOT_CONFIGURED', `hdx unavailable: ${variable} must be a plain URL`)
  return url.origin + url.pathname.replace(/\/+$/, '')
}

/** The base URL of an environment, without its key (a dashboard link needs only this). */
export function hdxBase(deps: ResolvedHdxDeps, hdxEnv: HdxEnv): string {
  const env = deps.env()
  if (hdxEnv === 'local') return baseUrl(envValue(env, 'HYPERDX_LOCAL_URL') ?? DEFAULT_LOCAL_URL, 'HYPERDX_LOCAL_URL')
  const explicit = envValue(env, 'HYPERDX_PROD_URL')
  if (explicit) return baseUrl(explicit, 'HYPERDX_PROD_URL')
  const domain = envValue(env, 'HYPERDX_DOMAIN')
  if (!domain) throw fail('NOT_CONFIGURED', 'hdx prod unavailable: HYPERDX_DOMAIN is not set')
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(domain))
    throw fail('NOT_CONFIGURED', 'hdx prod unavailable: HYPERDX_DOMAIN is not a domain name')
  return `https://hyperdx.${domain}`
}

/** The bearer key of an environment. Never logged, never in an error message: only its variable's name. */
export function hdxKey(deps: ResolvedHdxDeps, hdxEnv: HdxEnv): string {
  if (hdxEnv === 'prod') {
    const key = envValue(deps.env(), 'HYPERDX_PROD_ACCESS_KEY')
    if (!key) throw fail('NOT_CONFIGURED', 'hdx prod unavailable: HYPERDX_PROD_ACCESS_KEY is not set')
    return key
  }
  const fromEnv = envValue(deps.env(), 'HYPERDX_LOCAL_ACCESS_KEY')
  const key = fromEnv ?? dotenvValue(deps.readLocalEnvFile() ?? '', 'HYPERDX_LOCAL_ACCESS_KEY')
  if (!key)
    throw fail(
      'NOT_CONFIGURED',
      'hdx local unavailable: HYPERDX_LOCAL_ACCESS_KEY is not set and ~/.config/hyperdx/local.env does not hold it',
    )
  return key
}

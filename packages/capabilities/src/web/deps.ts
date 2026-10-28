import { lookup } from 'node:dns/promises'
import type { Usage } from '../context.ts'
import { fail } from '../errors.ts'
import type { Env } from '../transports/config.ts'
import type { HttpOptions } from '../transports/http.ts'
import { pinnedFetch } from './pinned.ts'

/**
 * What the web capabilities are built from. Every field defaults to production; tests inject fakes. Handlers close
 * over it, so `ctx` stays `{ signal, addUsage }`.
 */
export interface WebDeps {
  /**
   * Default: `globalThis.fetch`, or, when the call carries a `pin`, a request that connects to one of those vetted
   * addresses and nowhere else (see `pinned.ts`). Redirects are always followed by hand, so a fake sees every hop.
   */
  fetch?: (url: string, init: RequestInit, pin?: Pin) => Promise<Response>
  /** Every address a hostname resolves to. Default `dns.lookup(..., { all: true })`. */
  resolve?: (hostname: string) => Promise<string[]>
  /** Where keys and `SEARCH_PROVIDER` are read, on each call. Default `process.env`. */
  env?: Env
  /** Retry knobs of the package's helper (`withRetries`); tests set `backoffMs: 0`. */
  retry?: Pick<HttpOptions, 'attempts' | 'backoffMs'>
  /** Where a provider fallback is reported. Default `console.warn`. */
  warn?: (message: string) => void
}

/** The addresses a URL's host was vetted to, so the connection goes to one of them and DNS is not asked again. */
export interface Pin {
  addresses: string[]
}

export interface ResolvedWebDeps {
  fetch: (url: string, init: RequestInit, pin?: Pin) => Promise<Response>
  resolve: (hostname: string) => Promise<string[]>
  env: () => Env
  retry: Pick<HttpOptions, 'attempts' | 'backoffMs'>
  warn: (message: string) => void
}

export function resolveWebDeps(deps: WebDeps = {}): ResolvedWebDeps {
  return {
    fetch: deps.fetch ?? ((url, init, pin) => (pin ? pinnedFetch(url, init, pin.addresses) : fetch(url, init))),
    resolve: deps.resolve ?? (async (hostname) => (await lookup(hostname, { all: true })).map((a) => a.address)),
    env: () => deps.env ?? process.env,
    retry: deps.retry ?? {},
    warn: deps.warn ?? ((message) => console.warn(message)),
  }
}

/** A key from the environment; empty or whitespace is unset (a template renders an unresolved field as ""). */
export const keyOf = (env: Env, name: string): string | undefined => env[name]?.trim() || undefined

/** The key a capability cannot run without: `NOT_CONFIGURED`, naming the variable and never a value. */
export function requireKey(env: Env, name: string, capability: string): string {
  const key = keyOf(env, name)
  if (!key) throw fail('NOT_CONFIGURED', `${capability} unavailable: ${name} is not set`)
  return key
}

/** A URL the capability will not fetch, refused before anything was sent. */
export const refused = (capability: string, reason: string) => fail('URL_REFUSED', `${capability}: ${reason}`)

/**
 * One call to an external service as a `Usage`: no model tokens unless the service reports them. A price that is known
 * (including a free service at 0) is `rate`; `provider` when the service itself reported it; no price is `unknown`,
 * never 0.
 */
export function webUsage(
  model: string,
  cost: number | null,
  options: { source?: Usage['costSource']; tokens?: { input: number; output: number } } = {},
): Usage {
  return {
    model,
    tokens: { input: options.tokens?.input ?? 0, output: options.tokens?.output ?? 0, cacheRead: 0, reasoning: 0 },
    cost,
    costSource: cost === null ? 'unknown' : (options.source ?? 'rate'),
  }
}

/** A short per-attempt hang guard for the web calls, joined with the caller's signal. */
export const within = (signal: AbortSignal, ms: number): AbortSignal =>
  AbortSignal.any([signal, AbortSignal.timeout(ms)])

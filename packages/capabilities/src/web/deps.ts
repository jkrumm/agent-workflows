import { lookup } from 'node:dns/promises'
import { fail } from '../errors.ts'
import type { Env } from '../transports/config.ts'
import type { HttpOptions } from '../transports/http.ts'

/**
 * What the web capabilities are built from. Every field defaults to production; tests inject fakes. Handlers close
 * over it, so `ctx` stays `{ signal, addUsage }`.
 */
export interface WebDeps {
  /** Default `globalThis.fetch`. Redirects are always followed by hand, so a fake sees every hop. */
  fetch?: (url: string, init: RequestInit) => Promise<Response>
  /** Every address a hostname resolves to. Default `dns.lookup(..., { all: true })`. */
  resolve?: (hostname: string) => Promise<string[]>
  /** Where keys and `SEARCH_PROVIDER` are read, on each call. Default `process.env`. */
  env?: Env
  /** Retry knobs of the package's helper (`withRetries`); tests set `backoffMs: 0`. */
  retry?: Pick<HttpOptions, 'attempts' | 'backoffMs'>
  /** Where a provider fallback is reported. Default `console.warn`. */
  warn?: (message: string) => void
}

export interface ResolvedWebDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>
  resolve: (hostname: string) => Promise<string[]>
  env: () => Env
  retry: Pick<HttpOptions, 'attempts' | 'backoffMs'>
  warn: (message: string) => void
}

export function resolveWebDeps(deps: WebDeps = {}): ResolvedWebDeps {
  return {
    fetch: deps.fetch ?? ((url, init) => fetch(url, init)),
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

/**
 * An external call that was refused before it was sent (a URL that fails the SSRF guard, a malformed target). The
 * error table has no code for it yet, so it is an `UPSTREAM_ERROR` whose message starts with `refused:`; this is the
 * one place to switch when the table gains one.
 */
export const refused = (capability: string, reason: string) =>
  fail('UPSTREAM_ERROR', `${capability}: refused: ${reason}`, {})

/** A short per-attempt hang guard for the web calls, joined with the caller's signal. */
export const within = (signal: AbortSignal, ms: number): AbortSignal =>
  AbortSignal.any([signal, AbortSignal.timeout(ms)])

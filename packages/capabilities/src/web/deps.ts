import { lookup } from 'node:dns/promises'
import type { Usage } from '../context.ts'
import { fail } from '../errors.ts'
import type { Env } from '../transports/config.ts'
import type { HttpOptions } from '../transports/http.ts'
import {
  type BrowserRead,
  browserFromEnv,
  type PageHold,
  pageHoldFromEnv,
  parseMaxTabs,
  type RequestPolicy,
} from './browser.ts'
import { askHumanHandoff, type HumanHandoff } from './handoff.ts'
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
  /** Reads a page in a real browser. Default: the loopback CDP endpoint `AGW_BROWSER_CDP_URL` names, if it is set. */
  browser?: BrowserRead
  /** Keeps a challenged page open in the browser for the owner. Default: tabs of the `AGW_BROWSER_CDP_URL` browser, if it is set. */
  pageHold?: PageHold
  /** Asks the owner to pass a bot wall the browser cannot. Default: `ask-human.sh` (see `handoff.ts`). */
  handoff?: HumanHandoff
  /** How long Tavily Extract may take, retries included, once the plain read of the page timed out. Default 15 s. */
  extractAfterTimeoutMs?: number
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
  /** The browser reader, decided per call (the environment is read on each call); undefined when none is configured. `policy` vets every request an environment-configured browser makes. */
  browser: (policy: RequestPolicy) => BrowserRead | undefined
  /** The kept tabs of the browser, decided per call like `browser`; `policy` keeps vetting every request of a kept page. */
  pageHold: (policy: RequestPolicy) => PageHold | undefined
  handoff: HumanHandoff
  extractAfterTimeoutMs: number
}

/**
 * Tavily's whole turn after the plain read of the page timed out: the host is slow or down, and Extract fetches from
 * the same host (47 `direct: timed out` failures in 30 days, every one followed by an Extract call that failed too,
 * after up to 10 s + 30 s; the Extract p50 is 14.8 s).
 */
const EXTRACT_AFTER_TIMEOUT_MS = 15_000

export function resolveWebDeps(deps: WebDeps = {}): ResolvedWebDeps {
  const warn = deps.warn ?? ((message: string) => console.warn(message))
  return {
    fetch: deps.fetch ?? ((url, init, pin) => (pin ? pinnedFetch(url, init, pin.addresses) : fetch(url, init))),
    resolve: deps.resolve ?? (async (hostname) => (await lookup(hostname, { all: true })).map((a) => a.address)),
    env: () => deps.env ?? process.env,
    retry: deps.retry ?? {},
    warn,
    handoff: deps.handoff ?? askHumanHandoff({ env: deps.env ?? process.env, warn }),
    extractAfterTimeoutMs: deps.extractAfterTimeoutMs ?? EXTRACT_AFTER_TIMEOUT_MS,
    pageHold: (policy) =>
      deps.pageHold ?? pageHoldFromEnv(keyOf(deps.env ?? process.env, 'AGW_BROWSER_CDP_URL'), policy),
    browser: (policy) => {
      if (deps.browser) return deps.browser
      const env = deps.env ?? process.env
      const endpoint = keyOf(env, 'AGW_BROWSER_CDP_URL')
      if (!endpoint) return undefined
      try {
        return browserFromEnv(endpoint, policy, parseMaxTabs(env.AGW_BROWSER_MAX_TABS))
      } catch (error) {
        if (!(error instanceof RangeError)) throw error
        throw fail('NOT_CONFIGURED', `web.fetch unavailable: ${error.message}`)
      }
    },
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

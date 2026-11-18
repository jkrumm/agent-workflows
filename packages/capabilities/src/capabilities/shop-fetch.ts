import { fail } from '../errors.ts'
import { BrowserFailure, BrowserRefused } from '../web/browser.ts'
import { type ResolvedWebDeps, webUsage, within } from '../web/deps.ts'
import { assertPublicUrl, publicOnlyPolicy } from '../web/ssrf.ts'
import type { ReadBudget, ReadCount } from './shop-budget.ts'
import { AMAZON_ORIGIN, type BlockKind, detectBlock } from './shop-parse.ts'
import { SHOPIFY_HOSTS } from './shop-shopify-parse.ts'

// The one place the shop doors touch the network (amazon.de, alternate.de and the listed Shopify stores direct; idealo.de, geizhals.de, caseking.de and mindfactory.de
// in the research Chrome from the first request, because they turn a plain client away). Conduct, in code (docs/shop.md §Conduct): one request at a time, a
// jittered pause of 2-5 s between two page fetches, a search kept 1 h and an item page 24 h, a 429, captcha or sign-in
// wall ends the call with `blocked (<reason>)`: no retry, no second identity, no proxy, no login, no solving. A robot
// check alone gets one read in the headed research Chrome, and when that meets the check too the call ends blocked
// (nobody solves it: the owner is not asked). After a wall the process refuses further page fetches for a cooldown, so a loop of calls
// cannot lean on it. Every network read is also counted per host and day (`shop-budget.ts`); a host with a cap refuses the read
// past it before anything is sent.

export const SEARCH_TTL_MS = 3_600_000
export const ITEM_TTL_MS = 24 * 3_600_000

const MIN_PAUSE_MS = 2_000
const MAX_PAUSE_MS = 5_000
const BLOCK_COOLDOWN_MS = 15 * 60_000
const HOP_TIMEOUT_MS = 20_000
const MAX_HOPS = 3
const MAX_BODY_BYTES = 6_000_000
const CACHE_MAX_ENTRIES = 200
/** An honest client name: the shop is read as what it is, a personal tool at low volume. */
const USER_AGENT = 'agent-workflows/0.1 (shop)'

/** What a test (or the host) may replace: the clock, the pause and the jitter. */
export interface ShopPace {
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  random?: () => number
  now?: () => number
  cooldownMs?: number
}

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })

/**
 * The hosts the shop doors read and how. amazon.de, alternate.de and the listed Shopify stores answer a plain client (the direct leg first; a robot
 * check goes to the research Chrome once). idealo.de, geizhals.de, caseking.de (Cloudflare's check) and mindfactory.de (a
 * 403 "Datenbank-Update" page for the product page) turn a plain client away (measured 2026-11-17, docs/shop.md), so they
 * are read in the research Chrome from the first request: a direct request would be one guaranteed refusal and would start
 * the cooldown for nothing.
 */
const HOSTS: Record<string, 'direct' | 'browser'> = {
  'www.amazon.de': 'direct',
  'www.alternate.de': 'direct',
  'www.idealo.de': 'browser',
  'geizhals.de': 'browser',
  'www.caseking.de': 'browser',
  'www.mindfactory.de': 'browser',
  // A Shopify store answers its JSON endpoints to the honest client (measured 2026-11-18, docs/shop.md §Shopify stores).
  ...Object.fromEntries(SHOPIFY_HOSTS.map((host) => [host, 'direct' as const])),
}

/** An https URL on one of the shop hosts, no credentials, default port: the shop doors read nothing else. */
export function assertShopUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw fail('URL_REFUSED', `shop.fetch: not a URL: ${raw.slice(0, 80)}`)
  }
  if (url.protocol !== 'https:' || !(url.hostname in HOSTS) || url.username || url.password || url.port)
    throw fail(
      'URL_REFUSED',
      `shop.fetch: only ${AMAZON_ORIGIN} and the shop hosts (${Object.keys(HOSTS).join(', ')}) are read, not ${url.origin}`,
    )
  return url
}

/** The failure of a wall: the message carries `blocked (<reason>)` as `web.fetch` does. */
const blocked = (reason: BlockKind | 'cooldown', detail: string, status?: number) =>
  fail('UPSTREAM_ERROR', `shop.fetch: blocked (${reason}) · ${detail}`, status === undefined ? {} : { status })

/** The typed code of a capability error, whether it is thrown in the handler or came back through `.call`. */
export const errorCode = (error: unknown): string | undefined =>
  error instanceof Error ? (error as { code?: string }).code : undefined

/** True for the error a wall raised, in the handler or out of a nested `.call`: the run that sees it stops. */
export const isBlockedError = (error: unknown): boolean =>
  errorCode(error) === 'UPSTREAM_ERROR' && error instanceof Error && /^shop\.fetch: blocked \(/.test(error.message)

interface Entry {
  value: unknown
  at: number
  ttlMs: number
}

interface Fetched {
  status: number
  html: string
  finalUrl: string
}

type PageContext = { signal: AbortSignal; addUsage: (usage: ReturnType<typeof webUsage>) => void }

export interface PageRead<T> {
  value: T
  cached: boolean
  fetchedAt: string
}

/** `budget` counts the network reads per host and day and refuses past a host's cap (docs/shop.md §Conduct); without one nothing is counted. */
export function createShopFetch(web: ResolvedWebDeps, pace: ShopPace = {}, budget?: ReadBudget) {
  const sleep = pace.sleep ?? defaultSleep
  const random = pace.random ?? Math.random
  const now = pace.now ?? Date.now
  const cooldownMs = pace.cooldownMs ?? BLOCK_COOLDOWN_MS
  const cache = new Map<string, Entry>()
  const policy = publicOnlyPolicy(web, 'shop.fetch')
  let tail: Promise<unknown> = Promise.resolve()
  let lastEnd = 0
  /** Per host: a wall at one shop does not lock the others. */
  const blockedUntil = new Map<string, number>()

  const fresh = (entry: Entry | undefined): entry is Entry => entry !== undefined && now() - entry.at < entry.ttlMs

  /** Runs `job` after every earlier job: concurrency 1 across search, item and find. */
  const serial = <T>(job: () => Promise<T>): Promise<T> => {
    const run = tail.then(job, job)
    tail = run.catch(() => undefined)
    return run
  }

  async function read(url: string, signal: AbortSignal): Promise<Fetched> {
    let current = assertShopUrl(url).toString()
    for (let hop = 0; ; hop++) {
      const pin = await assertPublicUrl(web, 'shop.fetch', current)
      let res: Response
      try {
        res = await web.fetch(
          current,
          {
            redirect: 'manual',
            headers: {
              'user-agent': USER_AGENT,
              accept: 'text/html,application/xhtml+xml',
              'accept-language': 'de-DE,de;q=0.9',
            },
            signal: within(signal, HOP_TIMEOUT_MS),
          },
          pin,
        )
      } catch (error) {
        if (signal.aborted) throw fail('CANCELLED', 'cancelled')
        throw fail('UPSTREAM_ERROR', `shop.fetch: ${error instanceof Error ? error.message : String(error)}`, {})
      }
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel().catch(() => undefined)
        const location = res.headers.get('location')
        if (!location || hop >= MAX_HOPS)
          throw fail('UPSTREAM_ERROR', 'shop.fetch: redirect without a usable target', {})
        current = new URL(location, current).toString()
        if (/\/ap\/(signin|cvf)\b/.test(current))
          throw blocked('login-required', 'the shop asks for a sign-in', res.status)
        current = assertShopUrl(current).toString()
        continue
      }
      const html = await readBody(res, signal)
      return { status: res.status, html, finalUrl: current }
    }
  }

  /** What a failed browser read means: "not found" for a page the site answers 404, else an upstream error or a wall. */
  function browserFailure(error: unknown, label: string, first: boolean, signal: AbortSignal): never {
    if (signal.aborted) throw fail('CANCELLED', 'cancelled')
    if (!(error instanceof BrowserFailure || error instanceof BrowserRefused)) throw error
    web.warn(`shop.fetch: the browser read failed: ${error.message}`)
    // The browser leg reports an HTTP error status of the page as a failure; a 404 is "not found", as on the direct leg.
    const status = Number(error.message.match(/answered HTTP (4\d\d)/)?.[1])
    if (status === 404 || status === 410)
      throw fail('UPSTREAM_ERROR', `shop.fetch: ${label} not found (HTTP ${status})`, { status })
    if (first)
      throw fail('UPSTREAM_ERROR', `shop.fetch: the research Chrome could not read ${label}: ${error.message}`, {})
    throw blocked('bot-protection', `robot check on ${label}; the research Chrome could not read it either`)
  }

  /**
   * One page read in the research Chrome: its HTML and final URL, or `undefined` when no browser is configured. For amazon
   * this is the second read of a robot-checked page; for idealo, geizhals, caseking and mindfactory it is the only read. A challenge the browser
   * meets ends the call as blocked (`bot-protection`): the owner is not asked and the agent solves nothing. A browser
   * that fails or is refused leaves the original wall standing (amazon) or is an upstream error (no wall was seen).
   */
  async function readInBrowser(
    key: string,
    label: string,
    ctx: PageContext,
    first: boolean,
  ): Promise<Fetched | undefined> {
    const browser = web.browser(policy)
    if (!browser) return undefined
    let page: Awaited<ReturnType<typeof browser>>
    try {
      page = await browser(key, ctx.signal, { html: true })
    } catch (error) {
      browserFailure(error, label, first, ctx.signal)
    } finally {
      lastEnd = now()
    }
    ctx.addUsage(webUsage('shop-browser', 0))
    const html = page.html ?? ''
    let finalUrl: string
    try {
      finalUrl = assertShopUrl(page.finalUrl).toString()
    } catch {
      throw blocked(
        'bot-protection',
        `${first ? 'the page' : 'robot check'} on ${label}; the research Chrome ended off the shop hosts`,
      )
    }
    const wall = HOSTS[new URL(key).hostname] === 'direct' ? detectBlock({ status: 200, html, finalUrl }) : null
    if (wall === 'login-required') throw blocked(wall, 'the shop asks for a sign-in')
    if (page.challenge || wall) {
      throw blocked('bot-protection', `robot check on ${label} in the research Chrome too (needs-human)`)
    }
    return { status: 200, html, finalUrl }
  }

  /**
   * The page's response by the host's way in: idealo, geizhals, caseking and mindfactory in the research Chrome from the
   * first request, amazon and alternate direct with one browser read for a robot check. A wall throws `blocked (<reason>)`.
   */
  async function obtain(key: string, host: string, label: string, ctx: PageContext): Promise<Fetched> {
    if (HOSTS[host] === 'browser') {
      const read = await readInBrowser(key, label, ctx, true)
      if (read === undefined)
        throw fail(
          'NOT_CONFIGURED',
          `shop.fetch: ${host} turns plain clients away and is read in the research Chrome, but AGW_BROWSER_CDP_URL is not set (make research-chrome)`,
        )
      return read
    }
    let response: Fetched
    try {
      response = await read(key, ctx.signal)
    } finally {
      lastEnd = now()
    }
    ctx.addUsage(webUsage('shop-direct', 0))
    const wall = detectBlock(response)
    // Only a robot check goes to the browser: a 429 or a sign-in wall stops as ever.
    if (wall === 'bot-protection') {
      const second = await readInBrowser(key, label, ctx, false)
      if (second !== undefined) return { ...second, finalUrl: key }
    }
    if (wall) throw blocked(wall, `HTTP ${response.status} on ${label}`, response.status)
    return response
  }

  /** A 404 or any other error status is an upstream error: the page is not there, or the shop is failing. */
  function assertPage(response: Fetched, label: string): void {
    if (response.status === 404 || response.status === 410)
      throw fail('UPSTREAM_ERROR', `shop.fetch: ${label} not found (HTTP ${response.status})`, {
        status: response.status,
      })
    if (response.status >= 400)
      throw fail('UPSTREAM_ERROR', `shop.fetch: ${label} answered HTTP ${response.status}`, {
        status: response.status,
      })
  }

  /** The jittered pause of 2-5 s between two page reads. */
  async function pause(signal: AbortSignal): Promise<void> {
    if (lastEnd > 0) {
      const wait = lastEnd + MIN_PAUSE_MS + random() * (MAX_PAUSE_MS - MIN_PAUSE_MS) - now()
      if (wait > 0) await sleep(wait, signal)
    }
    if (signal.aborted) throw fail('CANCELLED', 'cancelled')
  }

  /** Keeps a parsed page, the oldest entries dropping out past the cap; the time it was read. */
  function remember(key: string, value: unknown, ttlMs: number): string {
    const at = now()
    cache.delete(key)
    cache.set(key, { value, at, ttlMs })
    for (const oldest of cache.keys()) {
      if (cache.size <= CACHE_MAX_ENTRIES) break
      cache.delete(oldest)
    }
    return new Date(at).toISOString()
  }

  async function readBody(res: Response, signal: AbortSignal): Promise<string> {
    if (!res.body) return ''
    const reader = res.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        size += value.byteLength
        if (size > MAX_BODY_BYTES) break
      }
    } catch (error) {
      if (signal.aborted) throw fail('CANCELLED', 'cancelled')
      throw fail(
        'UPSTREAM_ERROR',
        `shop.fetch: body could not be read: ${error instanceof Error ? error.message : String(error)}`,
        {},
      )
    } finally {
      await reader.cancel().catch(() => undefined)
    }
    const bytes = new Uint8Array(Math.min(size, MAX_BODY_BYTES))
    let offset = 0
    for (const chunk of chunks) {
      const room = bytes.length - offset
      if (room <= 0) break
      bytes.set(chunk.subarray(0, room), offset)
      offset += Math.min(chunk.byteLength, room)
    }
    return new TextDecoder('utf-8').decode(bytes)
  }

  return {
    /** The reads of `host` so far today (cache hits excluded) and its daily cap; null when this fetcher keeps no count. */
    reads(host: string): Promise<ReadCount> | null {
      return budget?.today(host) ?? null
    },
    /**
     * The parsed page at `url`: from this process's cache inside `ttlMs`, else one paced read. `parse` throws on a
     * layout it does not know, which is an `UPSTREAM_ERROR` here (the page changed, or it was not the page asked for).
     * Only a successful parse is cached, so a wall or an odd page is never served back.
     */
    page<T>(
      args: { url: string; ttlMs: number; fresh: boolean; label: string; parse: (html: string, finalUrl: string) => T },
      ctx: PageContext,
    ): Promise<PageRead<T>> {
      const key = assertShopUrl(args.url).toString()
      const hit = () => {
        const entry = cache.get(key)
        if (args.fresh || !fresh(entry)) return undefined
        ctx.addUsage(webUsage('cache', 0))
        return { value: entry.value as T, cached: true, fetchedAt: new Date(entry.at).toISOString() }
      }
      const early = hit()
      if (early) return Promise.resolve(early)
      return serial(async () => {
        // A call queued behind one that read the same page finds it cached now.
        const queued = hit()
        if (queued) return queued
        const host = new URL(key).hostname
        const until = blockedUntil.get(host) ?? 0
        if (now() < until)
          throw blocked('cooldown', `${host} turned this process away ${Math.ceil((until - now()) / 60_000)} min ago`)
        await budget?.take(host)
        await pause(ctx.signal)
        let response: Fetched
        try {
          response = await obtain(key, host, args.label, ctx)
        } catch (error) {
          if (isBlockedError(error)) blockedUntil.set(host, now() + cooldownMs)
          throw error
        }
        assertPage(response, args.label)
        let value: T
        try {
          value = args.parse(response.html, response.finalUrl)
        } catch (error) {
          throw fail(
            'UPSTREAM_ERROR',
            `shop.fetch: ${args.label}: ${error instanceof Error ? error.message : String(error)}`,
            {},
          )
        }
        return { value, cached: false, fetchedAt: remember(key, value, args.ttlMs) }
      })
    },
  }
}

export type ShopFetch = ReturnType<typeof createShopFetch>

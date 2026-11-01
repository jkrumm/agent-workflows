import { fail } from '../errors.ts'
import { type ResolvedWebDeps, webUsage, within } from '../web/deps.ts'
import { assertPublicUrl } from '../web/ssrf.ts'
import { AMAZON_ORIGIN, type BlockKind, detectBlock } from './shop-parse.ts'

// The one place the shop doors touch the network. Conduct, in code (docs/shop.md §Conduct): one request at a time, a
// jittered pause of 2-5 s between two page fetches, a search kept 1 h and an item page 24 h, a 429, captcha or sign-in
// wall ends the call with `blocked (<reason>)`: no retry, no second identity, no proxy, no login, no solving. After a
// wall the process refuses further page fetches for a cooldown, so a loop of calls cannot lean on it.

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

/** `https://www.amazon.de/...` only, no credentials, default port: the shop doors read nothing else. */
export function assertShopUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw fail('URL_REFUSED', `shop.fetch: not a URL: ${raw.slice(0, 80)}`)
  }
  if (url.protocol !== 'https:' || url.hostname !== 'www.amazon.de' || url.username || url.password || url.port)
    throw fail('URL_REFUSED', `shop.fetch: only ${AMAZON_ORIGIN} is read, not ${url.origin}`)
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

export interface PageRead<T> {
  value: T
  cached: boolean
  fetchedAt: string
}

export function createShopFetch(web: ResolvedWebDeps, pace: ShopPace = {}) {
  const sleep = pace.sleep ?? defaultSleep
  const random = pace.random ?? Math.random
  const now = pace.now ?? Date.now
  const cooldownMs = pace.cooldownMs ?? BLOCK_COOLDOWN_MS
  const cache = new Map<string, Entry>()
  let tail: Promise<unknown> = Promise.resolve()
  let lastEnd = 0
  let blockedUntil = 0

  const fresh = (entry: Entry | undefined): entry is Entry => entry !== undefined && now() - entry.at < entry.ttlMs

  /** Runs `job` after every earlier job: concurrency 1 across search, item and find. */
  const serial = <T>(job: () => Promise<T>): Promise<T> => {
    const run = tail.then(job, job)
    tail = run.catch(() => undefined)
    return run
  }

  async function read(url: string, signal: AbortSignal): Promise<{ status: number; html: string; finalUrl: string }> {
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
    /**
     * The parsed page at `url`: from this process's cache inside `ttlMs`, else one paced read. `parse` throws on a
     * layout it does not know, which is an `UPSTREAM_ERROR` here (the page changed, or it was not the page asked for).
     * Only a successful parse is cached, so a wall or an odd page is never served back.
     */
    page<T>(
      args: { url: string; ttlMs: number; fresh: boolean; label: string; parse: (html: string) => T },
      ctx: { signal: AbortSignal; addUsage: (usage: ReturnType<typeof webUsage>) => void },
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
        if (now() < blockedUntil)
          throw blocked(
            'cooldown',
            `the shop turned this process away ${Math.ceil((blockedUntil - now()) / 60_000)} min ago`,
          )
        if (lastEnd > 0) {
          const wait = lastEnd + MIN_PAUSE_MS + random() * (MAX_PAUSE_MS - MIN_PAUSE_MS) - now()
          if (wait > 0) await sleep(wait, ctx.signal)
        }
        if (ctx.signal.aborted) throw fail('CANCELLED', 'cancelled')
        let response: Awaited<ReturnType<typeof read>>
        try {
          response = await read(key, ctx.signal)
        } catch (error) {
          if (isBlockedError(error)) blockedUntil = now() + cooldownMs
          throw error
        } finally {
          lastEnd = now()
        }
        ctx.addUsage(webUsage('shop-direct', 0))
        const wall = detectBlock(response)
        if (wall) {
          blockedUntil = now() + cooldownMs
          throw blocked(wall, `HTTP ${response.status} on ${args.label}`, response.status)
        }
        if (response.status === 404 || response.status === 410)
          throw fail('UPSTREAM_ERROR', `shop.fetch: ${args.label} not found (HTTP ${response.status})`, {
            status: response.status,
          })
        if (response.status >= 400)
          throw fail('UPSTREAM_ERROR', `shop.fetch: ${args.label} answered HTTP ${response.status}`, {
            status: response.status,
          })
        let value: T
        try {
          value = args.parse(response.html)
        } catch (error) {
          throw fail(
            'UPSTREAM_ERROR',
            `shop.fetch: ${args.label}: ${error instanceof Error ? error.message : String(error)}`,
            {},
          )
        }
        const at = now()
        cache.delete(key)
        cache.set(key, { value, at, ttlMs: args.ttlMs })
        for (const oldest of cache.keys()) {
          if (cache.size <= CACHE_MAX_ENTRIES) break
          cache.delete(oldest)
        }
        return { value, cached: false, fetchedAt: new Date(at).toISOString() }
      })
    },
  }
}

export type ShopFetch = ReturnType<typeof createShopFetch>

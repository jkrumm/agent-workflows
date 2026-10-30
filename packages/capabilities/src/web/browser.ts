/** A page as a real browser rendered it. `challenge` is a bot wall that did not clear within the settle time. */
export interface BrowserPage {
  finalUrl: string
  title: string
  text: string
  challenge: boolean
}

/** Reads a public URL in a real, headed browser: the fallback for pages that turn a plain HTTP client away. */
export type BrowserRead = (url: string, signal: AbortSignal) => Promise<BrowserPage>

/**
 * The SSRF policy the browser's traffic answers to. `allowUrl` is asked before every request the page makes (the name is
 * resolved and checked); `allowAddress` is asked of the address the main document was actually fetched from, because the
 * browser resolves the name again itself and a name that answers differently the second time (DNS rebinding) is only
 * caught there.
 */
export interface RequestPolicy {
  allowUrl(url: string): Promise<boolean>
  allowAddress(address: string): boolean
}

/** A read that did not produce a page (browser unreachable, navigation failed): the chain moves on. */
export class BrowserFailure extends Error {}

/** The page navigated (or was redirected) to an address the policy refuses; none of its content was read. */
export class BrowserRefused extends Error {}

const TAB_REQUEST_MS = 10_000
const COMMAND_MS = 15_000
const LOAD_WAIT_MS = 20_000
/** How long a challenge may take to clear by itself (Cloudflare's usually does within seconds in a headed browser). */
const SETTLE_MS = 20_000
const POLL_MS = 1_000
/** Text shorter than this after the page loaded may still be hydrating: it gets a few more polls. */
const HYDRATED_CHARS = 200
const MAX_TEXT_CHARS = 2_000_000
/** Tabs open at once, across all runs of this process. */
const MAX_TABS = 3

const CHALLENGE_TITLE =
  /just a moment|nur einen moment|prove your humanity|something has gone wrong|attention required|verify you are human|checking your browser|ddos protection|access denied|are you a robot|blocked by network security/i

/** A bot wall: a known challenge title, or a short page whose opening lines say so. */
export function isChallenge(title: string, text: string): boolean {
  if (CHALLENGE_TITLE.test(title)) return true
  return text.length < 1_500 && CHALLENGE_TITLE.test(text.slice(0, 400))
}

const within = (signal: AbortSignal, ms: number) => AbortSignal.any([signal, AbortSignal.timeout(ms)])
const describe = (error: unknown) => (error instanceof Error ? error.message : String(error))

let openTabs = 0
const waiters: { wake: () => void; live: boolean }[] = []

/** Runs `body` once one of the process's tab slots is free; a waiter that aborts leaves the queue, so no wakeup is lost on it. */
async function withTab<T>(signal: AbortSignal, body: () => Promise<T>): Promise<T> {
  signal.throwIfAborted()
  while (openTabs >= MAX_TABS) {
    const waiter = { wake: () => {}, live: true }
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        waiter.live = false
        reject(signal.reason)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      waiter.wake = () => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      }
      waiters.push(waiter)
    }).catch((error) => {
      const at = waiters.indexOf(waiter)
      if (at >= 0) waiters.splice(at, 1)
      throw error
    })
  }
  openTabs++
  try {
    return await body()
  } finally {
    openTabs--
    // The next live waiter, skipping any that aborted between the check and now.
    for (let next = waiters.shift(); next; next = waiters.shift()) {
      if (next.live) {
        next.wake()
        break
      }
    }
  }
}

type Message = { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message: string } }

/** One CDP session on a page's WebSocket: commands answered by id (each with its own timeout), events by name. */
class Session {
  private nextId = 0
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  private readonly handlers = new Map<string, ((params: unknown) => void)[]>()
  private readonly closers = new Set<() => void>()
  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener('message', (event) => {
      let message: Message
      try {
        message = JSON.parse(String(event.data)) as Message
      } catch {
        return // a frame that is not JSON answers nothing; the command it belonged to times out
      }
      if (message.id !== undefined) {
        const call = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (message.error) call?.reject(new BrowserFailure(message.error.message))
        else call?.resolve(message.result)
      } else if (message.method) {
        for (const handler of this.handlers.get(message.method) ?? []) handler(message.params)
      }
    })
    ws.addEventListener('close', () => {
      this.failPending('the browser closed the tab')
      for (const done of this.closers) done()
    })
  }

  static async open(url: string): Promise<Session> {
    const ws = new WebSocket(url)
    try {
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener('open', () => resolve(), { once: true })
        ws.addEventListener('error', () => reject(new BrowserFailure('the browser tab could not be reached')), {
          once: true,
        })
      })
    } catch (error) {
      ws.close()
      throw error
    }
    return new Session(ws)
  }

  private failPending(reason: string) {
    for (const call of this.pending.values()) call.reject(new BrowserFailure(reason))
    this.pending.clear()
  }

  send<T>(method: string, params: object = {}): Promise<T> {
    if (this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new BrowserFailure('the browser tab is closed'))
    const id = ++this.nextId
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new BrowserFailure(`${method} was not answered`))
      }, COMMAND_MS)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value as T)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      try {
        this.ws.send(JSON.stringify({ id, method, params }))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new BrowserFailure(describe(error)))
      }
    })
  }

  on(method: string, handler: (params: unknown) => void) {
    this.handlers.set(method, [...(this.handlers.get(method) ?? []), handler])
  }

  /** Resolves when the event fires, after `ms` (a page that never finishes loading is still read), or when the session ends. */
  event(method: string, ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        this.closers.delete(done)
        resolve()
      }
      const timer = setTimeout(done, ms)
      this.closers.add(done)
      this.on(method, done)
    })
  }

  close() {
    this.failPending('the read ended')
    for (const done of this.closers) done()
    this.ws.close()
  }
}

const SNAPSHOT =
  'JSON.stringify({url: location.href, title: document.title, text: document.body ? document.body.innerText : ""})'

type Paused = { requestId: string; frameId?: string; resourceType?: string; request: { url: string } }
type Received = { type?: string; frameId?: string; response: { status: number; remoteIPAddress?: string } }

/** Page script cannot open a WebSocket: the request guard sees no handshake, and a socket to a local service could be read back out of the page. */
const NO_WEBSOCKET =
  'Object.defineProperty(window, "WebSocket", { value: function () { throw new Error("WebSocket is disabled") }, configurable: false })'

/**
 * One page read through a Chrome DevTools Protocol endpoint (`http://127.0.0.1:<port>`): a tab per read, always closed.
 * Every request the page makes (the navigation, each redirect hop, every subresource) is paused and asked of `policy`
 * before it is sent: the browser resolves names and follows redirects itself, so the guard `web.fetch` puts on its own
 * reads has to ride along. A refused document ends the read with `BrowserRefused`; a refused subresource is only blocked.
 */
export async function readViaCdp(
  base: string,
  url: string,
  signal: AbortSignal,
  policy: RequestPolicy,
  timing: { settleMs?: number; pollMs?: number } = {},
): Promise<BrowserPage> {
  return withTab(signal, async () => {
    let tab: { id: string; webSocketDebuggerUrl: string }
    try {
      const res = await fetch(`${base}/json/new?about:blank`, { method: 'PUT', signal: within(signal, TAB_REQUEST_MS) })
      if (!res.ok) throw new BrowserFailure(`the browser answered HTTP ${res.status}`)
      const body = (await res.json()) as Partial<typeof tab>
      if (
        typeof body.id !== 'string' ||
        typeof body.webSocketDebuggerUrl !== 'string' ||
        !/^ws:\/\//.test(body.webSocketDebuggerUrl)
      )
        throw new BrowserFailure('the browser opened a tab without a DevTools address')
      tab = { id: body.id, webSocketDebuggerUrl: body.webSocketDebuggerUrl }
    } catch (error) {
      if (signal.aborted) throw error
      throw error instanceof BrowserFailure
        ? error
        : new BrowserFailure(`the browser is unreachable: ${describe(error)}`)
    }
    let session: Session | undefined
    const onAbort = () => session?.close()
    try {
      signal.addEventListener('abort', onAbort, { once: true })
      session = await Session.open(tab.webSocketDebuggerUrl)
      signal.throwIfAborted()
      let refusedDocument = false
      let mainFrame = ''
      let mainStatus = 0
      const verdicts = new Map<string, Promise<boolean>>() // per URL: a page asks for the same host many times
      session.on('Fetch.requestPaused', (params) => {
        const paused = params as Paused
        const target = paused.request.url
        void (async () => {
          let allowed: boolean
          if (/^(data|blob|about):/i.test(target)) allowed = true
          else if (!/^https?:/i.test(target)) allowed = false
          else {
            const cached = verdicts.get(target)
            const verdict = cached ?? policy.allowUrl(target).catch(() => false)
            if (!cached) verdicts.set(target, verdict)
            allowed = await verdict
          }
          // The page itself (or a redirect of it) leading somewhere private ends the read; an embedded frame or a
          // script only loses that request.
          if (!allowed && paused.resourceType === 'Document' && paused.frameId === mainFrame) refusedDocument = true
          await session
            ?.send(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', {
              requestId: paused.requestId,
              ...(allowed ? {} : { errorReason: 'AccessDenied' }),
            })
            .catch(() => undefined)
        })()
      })
      // The address the page's document actually came from: the name was resolved again by the browser, so this is the
      // one check a name that answers differently the second time (DNS rebinding) cannot get past.
      session.on('Network.responseReceived', (params) => {
        const received = params as Received
        if (received.type !== 'Document' || received.frameId !== mainFrame) return
        mainStatus = received.response.status
        const address = received.response.remoteIPAddress?.replace(/^\[|\]$/g, '')
        if (address && !policy.allowAddress(address)) refusedDocument = true
      })
      await session.send('Page.enable')
      await session.send('Network.enable')
      await session.send('Page.addScriptToEvaluateOnNewDocument', { source: NO_WEBSOCKET })
      const tree = await session.send<{ frameTree?: { frame?: { id?: string } } }>('Page.getFrameTree')
      mainFrame = tree.frameTree?.frame?.id ?? ''
      await session.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] })
      const loaded = session.event('Page.loadEventFired', LOAD_WAIT_MS)
      const nav = await session.send<{ errorText?: string }>('Page.navigate', { url })
      if (nav.errorText && !refusedDocument) throw new BrowserFailure(`navigation failed: ${nav.errorText}`)
      await loaded
      signal.throwIfAborted()

      /** The snapshot as the read's answer, unless the page was refused or answered with an error status that is no challenge. */
      const accept = (page: BrowserPage) => {
        if (refusedDocument) throw new BrowserRefused('the page leads to a non-public address')
        if (!page.challenge && mainStatus >= 400) throw new BrowserFailure(`the page answered HTTP ${mainStatus}`)
        return page
      }
      const deadline = Date.now() + (timing.settleMs ?? SETTLE_MS)
      let last: BrowserPage | undefined
      for (;;) {
        signal.throwIfAborted()
        if (refusedDocument) throw new BrowserRefused('the page leads to a non-public address')
        try {
          const evaluated = await session.send<{ result: { value?: string } }>('Runtime.evaluate', {
            expression: SNAPSHOT,
            returnByValue: true,
          })
          const snap = JSON.parse(evaluated.result.value ?? '{}') as { url?: string; title?: string; text?: string }
          const text = (snap.text ?? '').trim().slice(0, MAX_TEXT_CHARS)
          const title = snap.title ?? ''
          last = { finalUrl: snap.url ?? url, title, text, challenge: isChallenge(title, text) }
        } catch (error) {
          // A navigation in flight destroys the page context for a moment; the next poll sees the new page.
          if (signal.aborted) throw error
        }
        if (last && !last.challenge && last.text.length >= HYDRATED_CHARS) return accept(last)
        if (Date.now() >= deadline) break
        await Bun.sleep(timing.pollMs ?? POLL_MS)
      }
      if (!last) throw new BrowserFailure('the page could not be read')
      return accept(last)
    } finally {
      signal.removeEventListener('abort', onAbort)
      session?.close()
      await fetch(`${base}/json/close/${tab.id}`, { signal: AbortSignal.timeout(TAB_REQUEST_MS) }).catch(
        () => undefined,
      )
    }
  })
}

/** The browser reader `AGW_BROWSER_CDP_URL` configures: loopback http only (the endpoint is unauthenticated). */
export function browserFromEnv(endpoint: string | undefined, policy: RequestPolicy): BrowserRead | undefined {
  const raw = endpoint?.trim()
  if (!raw) return undefined
  let base: URL
  try {
    base = new URL(raw)
  } catch {
    return undefined
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)
  if (!loopback || base.protocol !== 'http:') return undefined
  return (url, signal) => readViaCdp(base.origin, url, signal, policy)
}

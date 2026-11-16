import { HANDOFF_INTERVAL_MS, type OwnerPage } from './handoff.ts'

/** A page as a real browser rendered it. `challenge` is a bot wall that did not clear within the settle time. */
export interface BrowserPage {
  finalUrl: string
  title: string
  text: string
  challenge: boolean
  /** The document's `outerHTML` after the same settle, only when the read asked for it (`options.html`). */
  html?: string
}

/** Reads a public URL in a real, headed browser: the fallback for pages that turn a plain HTTP client away. */
export type BrowserRead = (url: string, signal: AbortSignal, options?: BrowserReadOptions) => Promise<BrowserPage>

export interface BrowserReadOptions {
  /** Also hand back the page's raw HTML (`BrowserPage.html`): for a caller that parses markup, not text. */
  html?: boolean
  /** Told how long the read waited for one of the process's tab slots (0 when one was free): the queue is part of the browser leg's latency. */
  onTabWait?: (ms: number) => void
  /**
   * The host of the URL is known to sit behind a bot challenge: at most one tab of it is open at a time, so parallel reads
   * produce one challenge and the others ride on its cookie. A host that is not marked is limited by the tab cap alone
   * (ten pages of one script-rendered docs site are not serialised), unless a read of it is in a challenge right now.
   */
  challengedHost?: boolean
}

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
/** How long a page that is no challenge gets to hydrate. */
const SETTLE_MS = 20_000
/**
 * How long a page that is still a challenge (`isChallenge`) gets to clear by itself, from the start of the read. Cloudflare's
 * non-interactive check cleared after 4 to 10 s in the research Chrome, two `agw web fetch` calls took 16.5 s and 23.6 s,
 * and a few reads were still on `Just a moment...` after 30 and 39 s: 20 s sat inside that spread. The read ends the moment
 * the challenge is gone and the page passes the rendered test; the page then gets `SETTLE_MS` of its own to hydrate.
 *
 * Hard limit: agw never sends input to a challenge widget and never answers a "verify you are human" check (no `Input.*`
 * command is dispatched to a page, a test pins it). An interactive check never clears by itself, and passing it is the owner's,
 * through the handoff (`handoff.ts`). No signal that tells an interactive check from one still working was proven reliable
 * (the widget is a cross-origin frame outside the tab's session), so an interactive check costs this whole limit.
 */
const CHALLENGE_MS = 45_000
/**
 * The poll interval is the floor of every read (two equal polls end it): 1 s before, 400 ms now. A challenge is only
 * ever returned when `SETTLE_MS` is over, never from a poll, so a faster poll cannot turn a page into a false challenge;
 * the early exit it speeds up is guarded by `HYDRATED_CHARS`, the equal text and the request in flight.
 */
const POLL_MS = 400
/**
 * A page counts as rendered when its text is at least this long, has not changed between two polls and the page has no
 * request in flight (the API call a client-rendered listing waits for). A shorter text is still hydrating; a longer one
 * that is still growing is a consent banner or a header with the content yet to come. A request that never ends
 * (long polling, a stalled beacon) holds the read only until the text has been the same for `QUIET_POLLS` polls (3.2 s,
 * the 3 s of three 1 s polls kept); a page that keeps changing is returned as the settle time left it.
 */
const HYDRATED_CHARS = 200
const QUIET_POLLS = 8
const MAX_TEXT_CHARS = 2_000_000
const MAX_HTML_CHARS = 6_000_000
/**
 * Tabs open for reads at once: the machine-wide cap, because every `web.fetch` runs in the one host process and parallel
 * research runs share it. `AGW_BROWSER_MAX_TABS` sets it (bounds `MIN_TABS` to `MAX_TABS_LIMIT`). It is a memory figure: a tab
 * measured about 120 MiB (three loaded tabs added about 350 MiB to an idle Chrome), so 8 is about 1 GiB of tabs.
 */
const DEFAULT_MAX_TABS = 8
const MIN_TABS = 1
const MAX_TABS_LIMIT = 16
/**
 * Tabs kept open on a challenged page for the owner, across all hosts. They do not count against the tab cap and hold no
 * slot of it, and they do not block a read of their host (it opens a tab of its own; a pass releases the kept one, a second
 * keep of the host replaces it). The true ceiling is therefore the cap plus this: 11 tabs, about 1.3 GiB, by default.
 */
const MAX_KEPT = 3

/** The tab cap from `AGW_BROWSER_MAX_TABS`: unset or empty is the default; anything but an integer from 1 to 16 is refused, naming the variable. */
export function parseMaxTabs(raw: string | undefined): number {
  const value = raw?.trim()
  if (!value) return DEFAULT_MAX_TABS
  const tabs = Number(value)
  if (!/^\d+$/.test(value) || tabs < MIN_TABS || tabs > MAX_TABS_LIMIT)
    throw new RangeError(`AGW_BROWSER_MAX_TABS must be an integer from ${MIN_TABS} to ${MAX_TABS_LIMIT}`)
  return tabs
}

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
async function withTab<T>(
  signal: AbortSignal,
  maxTabs: number,
  body: () => Promise<T>,
  onWait?: (ms: number) => void,
): Promise<T> {
  signal.throwIfAborted()
  const queuedAt = Date.now()
  while (openTabs >= maxTabs) {
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
  onWait?.(Date.now() - queuedAt)
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

/** Hosts whose tab is held by a read that needs the host to itself, each with the reads queued behind it (the key is the lock). */
const hostQueues = new Map<string, { wake: () => void; live: boolean }[]>()
/** Reads that are in a challenge right now, per host: a read that starts meanwhile takes the host lock too. */
const challenging = new Map<string, number>()

/**
 * Runs `body` with the host to itself: one tab per walled host, so parallel reads produce one challenge and the rest
 * ride on its cookie. The lock is taken before the global tab slot (`withTab` runs inside `body`), never after, so reads
 * waiting on one walled host hold no slot. A waiter that aborts leaves the queue; the lock is handed on, never dropped.
 */
async function withHost<T>(host: string, signal: AbortSignal, body: () => Promise<T>): Promise<T> {
  signal.throwIfAborted()
  const queue = hostQueues.get(host)
  if (queue) {
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
      queue.push(waiter)
    }).catch((error) => {
      const at = queue.indexOf(waiter)
      if (at >= 0) queue.splice(at, 1)
      throw error
    })
  } else hostQueues.set(host, [])
  try {
    return await body()
  } finally {
    const waiting = hostQueues.get(host)!
    let next = waiting.shift()
    while (next && !next.live) next = waiting.shift()
    if (next) next.wake()
    else hostQueues.delete(host)
  }
}

type Message = { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message: string } }

/** One CDP session on a page's WebSocket: commands answered by id (each with its own timeout), events by name. */
class Session {
  private nextId = 0
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  private readonly handlers = new Map<string, ((params: unknown) => void)[]>()
  private readonly closers = new Set<() => void>()
  private readonly endHandlers: (() => void)[] = []
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
      for (const ended of this.endHandlers) ended()
    })
  }

  /** Runs when the WebSocket closes, by `close()` or because the tab went away. */
  onEnd(handler: () => void) {
    this.endHandlers.push(handler)
  }

  /** Rejects with `signal.reason` when the signal fires first: a handshake nobody answers must not hold its tab slot forever. */
  static async open(url: string, signal: AbortSignal): Promise<Session> {
    const ws = new WebSocket(url)
    try {
      await new Promise<void>((resolve, reject) => {
        const settle = (finish: () => void) => {
          ws.removeEventListener('open', onOpen)
          ws.removeEventListener('error', onError)
          signal.removeEventListener('abort', onAbort)
          finish()
        }
        const onOpen = () => settle(resolve)
        const onError = () => settle(() => reject(new BrowserFailure('the browser tab could not be reached')))
        const onAbort = () => settle(() => reject(signal.reason))
        if (signal.aborted) return onAbort()
        ws.addEventListener('open', onOpen)
        ws.addEventListener('error', onError)
        signal.addEventListener('abort', onAbort, { once: true })
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

const snapshotExpression = (html: boolean) =>
  `JSON.stringify({url: location.href, title: document.title, text: document.body ? document.body.innerText : ""${
    html ? ', html: document.documentElement.outerHTML' : ''
  }})`

type Paused = { requestId: string; frameId?: string; resourceType?: string; request: { url: string } }
type Received = { type?: string; frameId?: string; response: { status: number; remoteIPAddress?: string } }

/** Page script cannot open a WebSocket: the request guard sees no handshake, and a socket to a local service could be read back out of the page. */
const NO_WEBSOCKET =
  'Object.defineProperty(window, "WebSocket", { value: function () { throw new Error("WebSocket is disabled") }, configurable: false })'

/**
 * Script for a tab kept open for a person to click in: it opens no second window. A popup is a tab of the same Chrome
 * with no guard of its own, so `window.open` is closed off for good; a link, area, form or submit button whose target is
 * a new window (its own `target` or `formtarget`, or the document's `<base target>`) is turned to the page's own window
 * before the click or submit acts; a link clicked with a modifier (new tab) or a button other than the first does
 * nothing. What it cannot reach: the browser's own context menu and frames the browser runs in another process.
 * Takes the page's `window` and `document`.
 */
export const NO_POPUPS = `(function (window, document) {
  Object.defineProperty(window, "open", { value: function () { return null }, configurable: false, writable: false })
  var SELF = /^_(self|top|parent)$/i
  var own = function (el, attribute) {
    var target = el.getAttribute(attribute)
    if (target === null && attribute === "target") {
      var base = document.querySelector ? document.querySelector("base[target]") : null
      target = base ? base.getAttribute("target") : null
    }
    if (target && !SELF.test(target)) el.setAttribute(attribute, "_self")
  }
  var act = function (event) {
    // The element clicked, also inside a shadow root (where event.target is the shadow host).
    var node = (event.composedPath ? event.composedPath()[0] : null) || event.target
    if (!node || !node.closest) return
    var link = node.closest("a[href], area[href]")
    if (link) {
      if (event.type === "auxclick" || event.button > 0 || event.ctrlKey || event.metaKey || event.shiftKey) {
        event.preventDefault()
        return
      }
      own(link, "target")
    }
    var submitter = node.closest("button[formtarget], input[formtarget]")
    if (submitter) own(submitter, "formtarget")
    var form = node.closest("form")
    if (form) own(form, "target")
  }
  document.addEventListener("click", act, true)
  document.addEventListener("auxclick", act, true)
  document.addEventListener("submit", function (event) {
    if (event.target && event.target.getAttribute) own(event.target, "target")
    if (event.submitter && event.submitter.getAttribute) own(event.submitter, "formtarget")
  }, true)
  if (window.HTMLFormElement) {
    var submit = window.HTMLFormElement.prototype.submit
    Object.defineProperty(window.HTMLFormElement.prototype, "submit", {
      value: function () { own(this, "target"); return submit.call(this) },
      configurable: false,
      writable: false,
    })
  }
})(window, document)`

/** A new blank tab of the browser: its id and the DevTools address of its page. */
async function openTab(base: string, signal: AbortSignal): Promise<{ id: string; webSocketDebuggerUrl: string }> {
  try {
    const res = await fetch(`${base}/json/new?about:blank`, { method: 'PUT', signal: within(signal, TAB_REQUEST_MS) })
    if (!res.ok) throw new BrowserFailure(`the browser answered HTTP ${res.status}`)
    const body = (await res.json()) as Partial<{ id: string; webSocketDebuggerUrl: string }>
    if (
      typeof body.id !== 'string' ||
      typeof body.webSocketDebuggerUrl !== 'string' ||
      !/^ws:\/\//.test(body.webSocketDebuggerUrl)
    )
      throw new BrowserFailure('the browser opened a tab without a DevTools address')
    return { id: body.id, webSocketDebuggerUrl: body.webSocketDebuggerUrl }
  } catch (error) {
    if (signal.aborted) throw error
    throw error instanceof BrowserFailure ? error : new BrowserFailure(`the browser is unreachable: ${describe(error)}`)
  }
}

const closeTab = (base: string, id: string): Promise<void> =>
  fetch(`${base}/json/close/${id}`, { signal: AbortSignal.timeout(TAB_REQUEST_MS) }).then(
    () => undefined,
    () => undefined,
  )

/** The request guard on one tab's session: what `policy` decided about the page, and the way to send the tab somewhere. */
interface Guard {
  /** The page itself (or a redirect of it) led somewhere the policy refuses. */
  readonly refused: boolean
  /** The status of the main document's last response. */
  readonly status: number
  /** Requests the page has sent and not yet seen finished: the hydration signal next to the text itself. */
  readonly inFlight: Set<string>
  /** Navigates the tab to `url` and waits for its load event (a page that never finishes loading is still read). */
  navigate(url: string): Promise<void>
}

/**
 * Puts the SSRF guard on a tab: every request the page makes (the navigation, each redirect hop, every subresource) is
 * paused and asked of `policy` before it is sent, the address the document came from is checked, and page script cannot
 * open a WebSocket. It rides on the session, so it holds for as long as the session is attached. `onRefused` runs once,
 * when the main document is refused.
 */
async function guardPage(
  session: Session,
  policy: RequestPolicy,
  options: { onRefused?: () => void; noPopups?: boolean } = {},
): Promise<Guard> {
  let refused = false
  let mainFrame = ''
  let status = 0
  const refuse = () => {
    if (refused) return
    refused = true
    options.onRefused?.()
  }
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
      if (!allowed && paused.resourceType === 'Document' && paused.frameId === mainFrame) refuse()
      await session
        .send(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', {
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
    status = received.response.status
    const address = received.response.remoteIPAddress?.replace(/^\[|\]$/g, '')
    if (address && !policy.allowAddress(address)) refuse()
  })
  const inFlight = new Set<string>()
  session.on('Network.requestWillBeSent', (params) => {
    const requestId = (params as { requestId?: string }).requestId
    if (requestId) inFlight.add(requestId)
  })
  const settled = (params: unknown) => inFlight.delete((params as { requestId?: string }).requestId ?? '')
  session.on('Network.loadingFinished', settled)
  session.on('Network.loadingFailed', settled)
  await session.send('Page.enable')
  await session.send('Network.enable')
  await session.send('Page.addScriptToEvaluateOnNewDocument', { source: NO_WEBSOCKET })
  if (options.noPopups) await session.send('Page.addScriptToEvaluateOnNewDocument', { source: NO_POPUPS })
  const tree = await session.send<{ frameTree?: { frame?: { id?: string } } }>('Page.getFrameTree')
  mainFrame = tree.frameTree?.frame?.id ?? ''
  await session.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] })
  return {
    get refused() {
      return refused
    },
    get status() {
      return status
    },
    inFlight,
    async navigate(url) {
      const loaded = session.event('Page.loadEventFired', LOAD_WAIT_MS)
      const nav = await session.send<{ errorText?: string }>('Page.navigate', { url })
      if (nav.errorText && !refused) throw new BrowserFailure(`navigation failed: ${nav.errorText}`)
      await loaded
    },
  }
}

/**
 * One page read through a Chrome DevTools Protocol endpoint (`http://127.0.0.1:<port>`): a tab per read, always closed.
 * The request guard (`guardPage`) rides along on the tab: the browser resolves names and follows redirects itself, so the
 * guard `web.fetch` puts on its own reads has to. A refused document ends the read with `BrowserRefused`; a refused
 * subresource is only blocked.
 */
export async function readViaCdp(
  base: string,
  url: string,
  signal: AbortSignal,
  policy: RequestPolicy,
  timing: { settleMs?: number; challengeMs?: number; pollMs?: number; openMs?: number; maxTabs?: number } = {},
  options: BrowserReadOptions = {},
): Promise<BrowserPage> {
  const host = new URL(url).hostname
  const read = async () => {
    const tab = await openTab(base, signal)
    let session: Session | undefined
    let inChallenge = false
    const onAbort = () => session?.close()
    try {
      signal.addEventListener('abort', onAbort, { once: true })
      const opening = within(signal, timing.openMs ?? TAB_REQUEST_MS)
      try {
        session = await Session.open(tab.webSocketDebuggerUrl, opening)
      } catch (error) {
        // The caller's cancel is rethrown as it is; only the open's own time limit is a failure of the browser.
        if (opening.aborted && !signal.aborted)
          throw new BrowserFailure('the browser tab could not be reached: timed out')
        throw error
      }
      signal.throwIfAborted()
      const guard = await guardPage(session, policy)
      // The window of the headless mini is occluded, so a tab reports `hidden` and throttles its timers; a challenge that
      // counts on them runs slower. Emulating focus makes the page `visible`. Best effort: a browser without it is read as before.
      await session.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => undefined)
      await guard.navigate(url)
      signal.throwIfAborted()

      /** The snapshot as the read's answer, unless the page was refused or answered with an error status that is no challenge. */
      const accept = (page: BrowserPage) => {
        if (guard.refused) throw new BrowserRefused('the page leads to a non-public address')
        if (!page.challenge && guard.status >= 400) throw new BrowserFailure(`the page answered HTTP ${guard.status}`)
        return page
      }
      const began = Date.now()
      const settleMs = timing.settleMs ?? SETTLE_MS
      const challengeMs = timing.challengeMs ?? CHALLENGE_MS
      // The hydration window starts when the challenge is gone: a page that cleared at 30 s still gets `settleMs` to render.
      let settledFrom = began
      let last: BrowserPage | undefined
      let lastLength = -1
      let unchanged = 0
      for (;;) {
        signal.throwIfAborted()
        if (guard.refused) throw new BrowserRefused('the page leads to a non-public address')
        try {
          const evaluated = await session.send<{ result: { value?: string } }>('Runtime.evaluate', {
            expression: snapshotExpression(options.html === true),
            returnByValue: true,
          })
          const snap = JSON.parse(evaluated.result.value ?? '{}') as {
            url?: string
            title?: string
            text?: string
            html?: string
          }
          const text = (snap.text ?? '').trim().slice(0, MAX_TEXT_CHARS)
          const title = snap.title ?? ''
          const challenge = isChallenge(title, text)
          if (last?.challenge && !challenge) settledFrom = Date.now()
          last = { finalUrl: snap.url ?? url, title, text, challenge }
          if (challenge && !inChallenge) {
            inChallenge = true
            challenging.set(host, (challenging.get(host) ?? 0) + 1)
          }
          if (options.html) last.html = (snap.html ?? '').slice(0, MAX_HTML_CHARS)
        } catch (error) {
          // A navigation in flight destroys the page context for a moment; the next poll sees the new page.
          if (signal.aborted) throw error
        }
        unchanged = last && last.text.length === lastLength ? unchanged + 1 : 0
        lastLength = last?.text.length ?? -1
        if (
          last &&
          !last.challenge &&
          last.text.length >= HYDRATED_CHARS &&
          unchanged >= 1 &&
          (guard.inFlight.size === 0 || unchanged >= QUIET_POLLS)
        )
          return accept(last)
        if (Date.now() >= (last?.challenge ? began + challengeMs : settledFrom + settleMs)) break
        await Bun.sleep(timing.pollMs ?? POLL_MS)
      }
      if (!last) throw new BrowserFailure('the page could not be read')
      return accept(last)
    } finally {
      signal.removeEventListener('abort', onAbort)
      session?.close()
      await closeTab(base, tab.id)
      if (inChallenge) {
        const left = (challenging.get(host) ?? 1) - 1
        if (left > 0) challenging.set(host, left)
        else challenging.delete(host)
      }
    }
  }
  const maxTabs = timing.maxTabs ?? DEFAULT_MAX_TABS
  const slotted = () => withTab(signal, maxTabs, read, options.onTabWait)
  // A walled host (marked, or in a challenge right now) is read one tab at a time; the lock comes before the slot.
  return options.challengedHost || challenging.has(host) ? withHost(host, signal, slotted) : slotted()
}

/** A tab kept on a challenged page: its guarding session stays attached until the tab is dropped. */
interface Kept {
  base: string
  id: string
  session: Session
  timer: ReturnType<typeof setTimeout>
}
/** One per host, oldest first (insertion order). */
const kept = new Map<string, Kept>()

/** Closes the kept tab of `host`, if there is one. The map entry goes at once, the browser call is awaited. */
async function dropKept(host: string): Promise<void> {
  const entry = kept.get(host)
  if (!entry) return
  kept.delete(host)
  clearTimeout(entry.timer)
  entry.session.close()
  await closeTab(entry.base, entry.id)
}

/** Closes every kept tab (tests, shutdown). */
export const dropAllKept = async (): Promise<void> => {
  await Promise.all([...kept.keys()].map(dropKept))
}

/** The hosts that have a kept tab right now. */
export const keptHosts = (): string[] => [...kept.keys()]

/**
 * Keeps the page the owner is asked to solve on screen: `url` in a tab of its own, brought to the front, and left
 * open until `dropKept` (a later read of the host passed, `keepMs` ran out, the page was refused, the owner closed it).
 * A kept tab has no read to ride along on, so the request guard stays attached to its session for as long as the tab is
 * kept: every request the page makes while the owner clicks through the wall (and the document it navigates to) is vetted
 * by the same `policy` as in a read, and a refused document closes the tab. The guard covers this tab only: a popup
 * would be a tab of the same Chrome with none, so the page gets `NO_POPUPS` (no `window.open`; a link, form or submit button aimed
 * at a new window, by its own target or `<base target>`, turns to the page's own; a new-tab click does nothing). Frames the browser runs in another process (cross-origin iframes, the captcha
 * widget) are outside this session and its scripts, as they are in a read. One tab per host (a second keep replaces
 * the first) and `MAX_KEPT` overall (the oldest goes). A tab that cannot be kept is closed and the failure thrown.
 */
export async function keepViaCdp(
  base: string,
  url: string,
  signal: AbortSignal,
  policy: RequestPolicy,
  timing: { keepMs?: number; openMs?: number } = {},
): Promise<void> {
  const host = new URL(url).hostname
  const tab = await openTab(base, signal)
  let session: Session | undefined
  try {
    const opening = within(signal, timing.openMs ?? TAB_REQUEST_MS)
    session = await Session.open(tab.webSocketDebuggerUrl, opening)
    const opened = session
    const guard = await guardPage(opened, policy, {
      noPopups: true,
      onRefused: () => {
        if (kept.get(host)?.session === opened) void dropKept(host)
      },
    })
    await guard.navigate(url)
    if (guard.refused) throw new BrowserRefused('the page leads to a non-public address')
    await opened.send('Page.bringToFront')
    signal.throwIfAborted()
  } catch (error) {
    session?.close()
    await closeTab(base, tab.id)
    throw error
  }
  const live = session
  const stale: Promise<void>[] = []
  if (kept.has(host)) stale.push(dropKept(host))
  while (kept.size >= MAX_KEPT) stale.push(dropKept(kept.keys().next().value!))
  const timer = setTimeout(() => void dropKept(host), timing.keepMs ?? HANDOFF_INTERVAL_MS)
  timer.unref?.()
  kept.set(host, { base, id: tab.id, session: live, timer })
  // The owner closing the tab ends the session: forget it, unless a newer tab of the host has taken its place.
  live.onEnd(() => {
    const entry = kept.get(host)
    if (entry?.session !== live) return
    kept.delete(host)
    clearTimeout(entry.timer)
  })
  await Promise.all(stale)
}

/** The kept tabs of a browser the process reads through: kept for the owner, released once a read of the host passes. */
export interface PageHold {
  /** Puts `url` on screen in the browser for the owner (see `keepViaCdp`). Throws when the page cannot be kept. */
  keep(url: string, signal: AbortSignal): Promise<void>
  /** Closes the kept tab of `host`: a read of it passed without a challenge. A host with no kept tab is a no-op. */
  release(host: string): Promise<void>
}

/** The owner's view of one challenged page for `askOnce`: opened when he is asked, closed again if the ask did not go out. */
export const ownerPage = (hold: PageHold | undefined, url: string, signal: AbortSignal): OwnerPage | undefined =>
  hold && {
    open: async () => {
      await hold.keep(url, signal)
      return true
    },
    close: () => hold.release(new URL(url).hostname),
  }

/** The browser reader `AGW_BROWSER_CDP_URL` configures: loopback http only (the endpoint is unauthenticated). */
export function browserFromEnv(
  endpoint: string | undefined,
  policy: RequestPolicy,
  maxTabs?: number,
): BrowserRead | undefined {
  const base = loopbackBase(endpoint)
  if (!base) return undefined
  return (url, signal, options) => readViaCdp(base, url, signal, policy, { maxTabs }, options)
}

/** The kept tabs of the browser `AGW_BROWSER_CDP_URL` configures; the same loopback rule as `browserFromEnv`. */
export function pageHoldFromEnv(endpoint: string | undefined, policy: RequestPolicy): PageHold | undefined {
  const base = loopbackBase(endpoint)
  if (!base) return undefined
  return {
    keep: (url, signal) => keepViaCdp(base, url, signal, policy),
    release: dropKept,
  }
}

function loopbackBase(endpoint: string | undefined): string | undefined {
  const raw = endpoint?.trim()
  if (!raw) return undefined
  let base: URL
  try {
    base = new URL(raw)
  } catch {
    return undefined
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)
  return loopback && base.protocol === 'http:' ? base.origin : undefined
}

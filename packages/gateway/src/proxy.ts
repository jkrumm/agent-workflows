import { BEARER_CHALLENGE } from '@agent-workflows/host/auth'
import { callerAuth } from '@agent-workflows/host/door-tokens'
import {
  BALANCE_MARKER,
  claudeRate,
  costFromUsage,
  isBalanceFailure,
  type ProviderUsage,
  resolveModelAlias,
} from '@agent-workflows/routes/pricing'
import type { IuUpstream } from './config.ts'
import { isRecord } from './json.ts'
import type { Ledger, RecordRow } from './ledger.ts'
import { errorMessage, type Logger } from './log.ts'
import { isClaudeCodeShaped, type Pick, type Pools, sessionId } from './pools/index.ts'
import { decodeBody, type TeeResult, UsageTee } from './tee.ts'
import type { RequestSpan, Telemetry } from './telemetry.ts'

/** The label of the IU passthrough everywhere: a credit pool is itself named `iu`. */
export const IU_API = 'iu-api'
const REFUSED = 'refused'
/** The reason on a path with no pick: IU is the only upstream. */
const PASSTHROUGH = 'passthrough'

/** rules/agent-limits: a hang guard of 30 minutes on silence from upstream, never a cap on a long stream. */
const HANG_GUARD_MS = 30 * 60 * 1000
const MESSAGES_PATH = '/anthropic/v1/messages'
const COUNT_TOKENS_PATH = '/anthropic/v1/messages/count_tokens'
/** Statuses a credit org's balance refusal can carry; only these are read before they are answered. */
const REFUSAL_STATUSES: ReadonlySet<number> = new Set([400, 402, 503])
/** A `Response` refuses a body on these. */
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([101, 204, 205, 304])
const HOP_BY_HOP: ReadonlySet<string> = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])
/** Replaced (the caller's credentials) or recomputed by `fetch`. */
const NOT_FORWARDED: ReadonlySet<string> = new Set(['authorization', 'x-api-key', 'host', 'content-length'])

export interface ProxyOptions {
  pools: Pools
  /** Resolved API keys of the credit pools. */
  poolKeys: ReadonlyMap<string, string | undefined>
  ledger: Ledger
  /** Told about each written row; null when the flush loop is off. */
  outbox: { poke(): void } | null
  telemetry: Telemetry
  logger: Logger
  doorTokens: ReadonlyMap<string, string>
  apiSecret: string
  iu: IuUpstream
  /** `https://api.anthropic.com`; a fake in tests. Not an env: spend must not be redirectable by configuration. */
  anthropicBase: string
  machine: string
  hangGuardMs?: number
}

export interface GatewayProxy {
  /** Answers a gateway path, undefined for any other. */
  handle(request: Request, server: { timeout(request: Request, seconds: number): void }): Promise<Response | undefined>
  /** Requests still streaming: resolves when the last one is settled. */
  drained(): Promise<void>
  /** Cuts every request in flight; each still writes its row with what it knows. */
  abortAll(): void
}

/** Where a path goes: a credit-eligible Anthropic call, or IU by path. */
type Route = { kind: 'messages'; countTokens: boolean } | { kind: 'iu'; url: string; system: string }

/** Who answers one attempt. `label` is the pool id or `iu-api`. */
interface Target {
  label: string
  url: string
  credential: [header: string, value: string]
}

/** One request through the gateway. */
interface Exchange {
  requestId: string
  startedAtMs: number
  caller: string
  session: string | null
  method: string
  path: string
  /** The query string with its `?`; the SDK's beta calls send `?beta=true`. */
  search: string
  inbound: Headers
  /** The bytes that go upstream: the caller's, or the alias rewrite. */
  body: Bytes | undefined
  /** The model as the caller named it. */
  requestedModel: string | null
  /** After the alias. */
  model: string | null
  system: string
  span: RequestSpan
  abort: AbortController
  guard: { arm(): void; disarm(): void }
  /** The request's end: row written, span ended. */
  settled: () => void
}

type Bytes = Uint8Array<ArrayBuffer>

/** How a request ended. */
type Ended = 'complete' | 'aborted' | 'failed'

const errorResponse = (status: number, type: string, message: string, headers?: Record<string, string>): Response =>
  Response.json({ type: 'error', error: { type, message } }, { status, ...(headers ? { headers } : {}) })

/** What goes upstream: the end-to-end headers, the upstream's credential. `x-agw-*` is the gateway's own. */
function upstreamHeaders(inbound: Headers, credential: Target['credential']): Headers {
  const named = (inbound.get('connection') ?? '').split(',').map((name) => name.trim().toLowerCase())
  const headers = new Headers()
  for (const [name, value] of inbound) {
    if (NOT_FORWARDED.has(name) || HOP_BY_HOP.has(name) || named.includes(name) || name.startsWith('x-agw-')) continue
    headers.append(name, value)
  }
  headers.set(...credential)
  return headers
}

function responseHeaders(upstream: Headers, x: { requestId: string }, pool: string): Headers {
  const headers = new Headers()
  for (const [name, value] of upstream) if (!HOP_BY_HOP.has(name)) headers.append(name, value)
  headers.set('x-agw-request-id', x.requestId)
  headers.set('x-agw-pool', pool)
  return headers
}

function parseBody(bytes: Uint8Array, contentType: string | null, always: boolean): Record<string, unknown> | null {
  if (!always && !(contentType ?? '').toLowerCase().includes('json')) return null
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** The doc's one body edit: an exact alias becomes the concrete id; anything else keeps its bytes. */
function rewriteAlias(
  bytes: Bytes,
  parsed: Record<string, unknown> | null,
): { body: Bytes; requested: string | null; model: string | null } {
  const requested = typeof parsed?.model === 'string' ? parsed.model : null
  if (requested === null) return { body: bytes, requested, model: null }
  const model = resolveModelAlias(requested)
  if (model === requested) return { body: bytes, requested, model }
  return { body: new TextEncoder().encode(JSON.stringify({ ...parsed, model })), requested, model }
}

/** The wires that name the model in the path, not the body. */
function modelFromPath(path: string): string | null {
  const gemini = /^\/gemini\/v1beta\/models\/([^/:]+)/.exec(path)
  if (gemini?.[1] !== undefined) return gemini[1]
  const replicate = /^\/replicate\/v1\/models\/(.+?)\/predictions/.exec(path)
  return replicate?.[1] ?? null
}

const laneOf = (caller: string): RecordRow['lane'] =>
  caller === 'agw' ? 'agw_workflow' : caller === 'hermes' ? 'hermes' : 'other'

/**
 * The priced cost: a Claude call at the route rates, the provider's own figure if it states one. A credit pool's
 * response with no rate for its model is charged the same usage at the most expensive Claude rate, so a new model can
 * never run the credit past the meter.
 */
function priced(
  usage: ProviderUsage | null,
  model: string | null,
  claude: boolean,
  creditPool: boolean,
): { usd: number | null; estimated: boolean } {
  if (!claude && !creditPool) return { usd: null, estimated: false }
  const cost = costFromUsage('iu-anthropic', usage, model === null ? undefined : claudeRate(model))
  if (cost.usd !== null || !creditPool) return { usd: cost.usd, estimated: false }
  const estimate = costFromUsage('iu-anthropic', usage, claudeRate('opus'))
  return { usd: estimate.usd, estimated: estimate.usd !== null }
}

/**
 * The request path: door auth, the pick, the byte-exact forward, the usage tee, the ledger row, the span. A stream
 * goes through unbuffered and pull-driven, so a caller that hangs up cancels the upstream instead of paying for the rest.
 */
export function createProxy(options: ProxyOptions): GatewayProxy {
  const { pools, ledger, telemetry, logger, iu, machine } = options
  const hangGuardMs = options.hangGuardMs ?? HANG_GUARD_MS
  const auth = callerAuth({ tokens: options.doorTokens, secret: options.apiSecret })
  const inflight = new Map<Exchange, Promise<void>>()

  const callerOf = (headers: Headers): string | null => {
    const key = headers.get('x-api-key')
    return auth(headers.get('authorization')) ?? (key ? auth(`Bearer ${key}`) : null)
  }

  const routeOf = (pathname: string, search: string): Route | null => {
    if (pathname === MESSAGES_PATH) return { kind: 'messages', countTokens: false }
    if (pathname === COUNT_TOKENS_PATH) return { kind: 'messages', countTokens: true }
    const iuRoutes: [prefix: string, base: string, system: string][] = [
      ['/openai/v1/', iu.root, 'openai'],
      ['/gemini/v1beta/', iu.root, 'gcp.gemini'],
      ['/replicate/v1/', iu.root, 'replicate'],
      ['/decisions/v1/', iu.origin, 'iu.decisions'],
    ]
    for (const [prefix, base, system] of iuRoutes) {
      if (pathname.startsWith(prefix)) return { kind: 'iu', url: `${base}${pathname}${search}`, system }
    }
    return null
  }

  const targetOf = (pick: Exclude<Pick, { kind: 'refuse' }>, x: Exchange): Target => {
    const upstreamPath = `${x.path.slice('/anthropic'.length)}${x.search}`
    if (pick.kind === 'iu') {
      return {
        label: IU_API,
        url: `${iu.anthropicBase}${upstreamPath}`,
        credential: ['authorization', `Bearer ${iu.apiKey}`],
      }
    }
    return {
      label: pick.pool,
      url: `${options.anthropicBase}${upstreamPath}`,
      credential: ['x-api-key', options.poolKeys.get(pick.pool) ?? ''],
    }
  }

  const send = (x: Exchange, target: Target): Promise<Response> => {
    x.guard.arm()
    const init = {
      method: x.method,
      headers: upstreamHeaders(x.inbound, target.credential),
      ...(x.body === undefined ? {} : { body: x.body }),
      redirect: 'manual',
      signal: x.abort.signal,
      // Bun's default decodes the body but keeps `content-encoding`; the caller must get the bytes as they came.
      decompress: false,
    } satisfies RequestInit & { decompress: boolean }
    return fetch(target.url, init).finally(() => x.guard.disarm())
  }

  /** The row and the charge: row first, so the meter's `rowAt` is the row's instant. Never throws into a stream. */
  const writeRow = (x: Exchange, input: { status: number; pick: PickLabel; tee: TeeResult; ended: Ended }): void => {
    const { status, pick, tee, ended } = input
    const creditPool = pick.pool !== IU_API
    const model = tee.model ?? x.model
    const claude = x.path.startsWith('/anthropic/') || (model !== null && claudeRate(model) !== undefined)
    const cost = priced(tee.usage, model, claude, creditPool)
    const tokens = tee.tokens
    const durationMs = Date.now() - x.startedAtMs
    const row: RecordRow = {
      source: 'gateway',
      source_id: x.requestId,
      grain: 'message',
      ts: new Date(x.startedAtMs).toISOString(),
      model_raw: x.requestedModel ?? model,
      model,
      billing: creditPool ? 'api_credit' : 'api_key',
      account: creditPool ? pick.pool : null,
      api_key: creditPool ? null : 'personal',
      machine,
      outcome: status >= 200 && status < 300 && ended === 'complete' && !tee.streamError ? 'ok' : 'error',
      lane: laneOf(x.caller),
      lane_detail: {
        caller: x.caller,
        session: x.session,
        run_id: x.inbound.get('x-agw-run-id'),
        workflow: x.inbound.get('x-agw-workflow'),
        step: x.inbound.get('x-agw-step'),
        purpose: x.inbound.get('x-agw-purpose'),
        pool: pick.pool,
        fallback: creditPool ? null : pick.reason,
        ...(cost.estimated ? { costEstimated: true } : {}),
      },
      run_id: x.inbound.get('x-agw-run-id'),
      input_tokens: tokens?.input ?? 0,
      output_tokens: tokens?.output ?? 0,
      cache_read_tokens: tokens?.cacheRead ?? 0,
      cache_write_5m_tokens: tokens?.cacheWrite5m ?? 0,
      cache_write_1h_tokens: tokens?.cacheWrite1h ?? 0,
      reasoning_tokens: tokens?.reasoning ?? 0,
      duration_ms: durationMs,
      cost_reported_usd: cost.usd,
      raw: { path: x.path, status, ended, usageReported: tokens !== null },
    }
    x.span.set({
      'gen_ai.usage.input_tokens': row.input_tokens,
      'gen_ai.usage.output_tokens': row.output_tokens,
      'agw.gateway.cache_read_tokens': row.cache_read_tokens,
      'agw.gateway.cache_write_tokens': row.cache_write_5m_tokens + row.cache_write_1h_tokens,
      ...(model === null ? {} : { 'gen_ai.response.model': model }),
      ...(cost.usd === null ? {} : { 'agw.cost.usd': cost.usd }),
    })
    let rowAt: Date
    try {
      rowAt = ledger.writeRecord(row)
    } catch (error) {
      // /health degrades; the meter still counts it for this process's life.
      logger.error('ledger write failed; the row is lost', {
        requestId: x.requestId,
        error: errorMessage(error),
        pool: pick.pool,
        usd: cost.usd,
      })
      rowAt = new Date()
    }
    if (creditPool && cost.usd !== null) pools.charge(pick.pool, cost.usd, rowAt)
    options.outbox?.poke()
  }

  /** Closes the request once: the row (unless it is a `count_tokens`), the span, the in-flight entry. */
  const finisher = (x: Exchange, input: { status: number; pick: PickLabel; record: boolean }) => {
    let done = false
    return (tee: TeeResult, ended: Ended): void => {
      if (done) return
      done = true
      try {
        if (input.record) writeRow(x, { status: input.status, pick: input.pick, tee, ended })
      } catch (error) {
        logger.error('row not recorded', { requestId: x.requestId, error: errorMessage(error) })
      }
      x.span.set({ 'agw.gateway.status': input.status })
      x.span.end(input.status >= 400 || ended !== 'complete' || tee.streamError)
      x.settled()
    }
  }

  /** The caller's stream: every upstream chunk goes on as it arrives, the tee reads a copy. */
  const streamed = (
    x: Exchange,
    body: ReadableStream<Uint8Array>,
    tee: UsageTee,
    finish: (tee: TeeResult, ended: Ended) => void,
  ): ReadableStream<Uint8Array> => {
    const reader = body.getReader()
    let first = true
    return new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          x.guard.arm()
          try {
            const { done, value } = await reader.read()
            x.guard.disarm()
            if (done) {
              finish(tee.finish(), 'complete')
              controller.close()
              return
            }
            if (first) {
              first = false
              x.span.set({ 'agw.gateway.ttft_ms': Date.now() - x.startedAtMs })
            }
            tee.push(value)
            controller.enqueue(value)
          } catch (error) {
            x.guard.disarm()
            finish(tee.finish(), x.abort.signal.aborted ? 'aborted' : 'failed')
            controller.error(error)
          }
        },
        async cancel() {
          finish(tee.finish(), 'aborted')
          x.abort.abort()
          await reader.cancel().catch(() => {})
        },
      },
      { highWaterMark: 0 },
    )
  }

  /** Answers the caller from an upstream response, tee attached. */
  const answer = (
    x: Exchange,
    upstream: Response,
    body: ReadableStream<Uint8Array> | null,
    pick: PickLabel,
    record: boolean,
  ): Response => {
    const headers = responseHeaders(upstream.headers, x, pick.pool)
    const tee = new UsageTee({
      contentType: upstream.headers.get('content-type'),
      contentEncoding: upstream.headers.get('content-encoding'),
    })
    const finish = finisher(x, { status: upstream.status, pick, record })
    if (body === null || NULL_BODY_STATUSES.has(upstream.status)) {
      finish(tee.finish(), 'complete')
      return new Response(null, { status: upstream.status, statusText: upstream.statusText, headers })
    }
    const stream = streamed(x, body, tee, finish)
    return new Response(stream, { status: upstream.status, statusText: upstream.statusText, headers })
  }

  const noUsage: TeeResult = { usage: null, tokens: null, model: null, streamError: false }

  /** No response came: the caller left, the guard fired or the network failed. */
  const unreachable = (x: Exchange, pick: PickLabel, record: boolean, error: unknown): Response => {
    const aborted = x.abort.signal.aborted
    const status = aborted ? 504 : 502
    if (!aborted)
      logger.warn('upstream unreachable', { requestId: x.requestId, pool: pick.pool, error: errorMessage(error) })
    finisher(x, { status, pick, record })(noUsage, aborted ? 'aborted' : 'failed')
    return errorResponse(status, 'api_error', aborted ? 'upstream cut' : 'upstream unreachable', {
      'x-agw-request-id': x.requestId,
      'x-agw-pool': pick.pool,
    })
  }

  /** The 402 of `x-agw-fallback: none`: the caller's own route fallback takes over. */
  const refuse = (x: Exchange, reason: string): Response => {
    x.span.set({ 'agw.gateway.pool': REFUSED, 'agw.gateway.pick_reason': reason, 'agw.gateway.status': 402 })
    x.span.end(true)
    x.settled()
    return errorResponse(402, 'balance_error', `${BALANCE_MARKER}: no credit pool eligible`, {
      'x-agw-request-id': x.requestId,
      'x-agw-pool': REFUSED,
    })
  }

  /** Reads a possible refusal: the body is held so it can still be answered byte for byte. */
  const refusalOf = async (
    x: Exchange,
    upstream: Response,
  ): Promise<{ balance: boolean; bytes: Uint8Array | null }> => {
    if (!REFUSAL_STATUSES.has(upstream.status) || upstream.body === null) return { balance: false, bytes: null }
    x.guard.arm()
    const bytes = new Uint8Array(await upstream.arrayBuffer())
    x.guard.disarm()
    let text: string
    try {
      text = new TextDecoder().decode(decodeBody(bytes, upstream.headers.get('content-encoding')))
    } catch {
      return { balance: false, bytes }
    }
    return { balance: isBalanceFailure({ status: upstream.status, text }), bytes }
  }

  const heldBody = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
    new ReadableStream({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      },
    })

  const servesPick = (x: Exchange, pick: Pick): void => {
    if (pick.kind === 'iu' || pick.kind === 'pool') {
      x.span.set({
        'agw.gateway.pool': pick.kind === 'pool' ? pick.pool : IU_API,
        'agw.gateway.pick_reason': pick.reason,
      })
    }
  }

  const recordPick = (x: Exchange, pick: Pick, record: boolean): void => {
    if (!record) return
    const picked = pick.kind === 'pool' ? pick.pool : pick.kind === 'iu' ? IU_API : REFUSED
    try {
      ledger.writePick({
        ts: new Date().toISOString(),
        caller: x.caller,
        session: x.session,
        picked,
        reason: pick.reason,
        machine,
        request_id: x.requestId,
      })
    } catch (error) {
      logger.error('ledger write failed; the pick is lost', { requestId: x.requestId, error: errorMessage(error) })
    }
    options.outbox?.poke()
  }

  /** §Picking a pool: the pick, the forward, and on a balance refusal one more pick and forward. */
  const serveMessages = async (
    x: Exchange,
    picking: { claudeCodeShaped: boolean; fallbackNone: boolean },
    countTokens: boolean,
  ): Promise<Response> => {
    const record = !countTokens
    const input = { caller: x.caller, session: x.session, ...picking }
    const exclude: string[] = []
    let retried = false
    for (;;) {
      const pick = pools.pick({ ...input, exclude })
      recordPick(x, pick, record)
      if (pick.kind === 'refuse') return refuse(x, pick.reason)
      servesPick(x, pick)
      const target = targetOf(pick, x)
      const label: PickLabel = { pool: target.label, reason: pick.reason }
      let upstream: Response
      let held: Uint8Array | null = null
      try {
        upstream = await send(x, target)
        if (pick.kind === 'pool') {
          const refusal = await refusalOf(x, upstream)
          held = refusal.bytes
          if (refusal.balance) {
            pools.drained(pick.pool, pick.cycleStart)
            if (!retried) {
              retried = true
              exclude.push(pick.pool)
              continue
            }
          }
        }
      } catch (error) {
        return unreachable(x, label, record, error)
      }
      if (upstream.ok && record) pools.served(x.caller, x.session, pick.kind === 'pool' ? pick.pool : null)
      return answer(x, upstream, held === null ? upstream.body : heldBody(held), label, record)
    }
  }

  const servePassthrough = async (x: Exchange, url: string): Promise<Response> => {
    const label: PickLabel = { pool: IU_API, reason: PASSTHROUGH }
    x.span.set({ 'agw.gateway.pool': IU_API, 'agw.gateway.pick_reason': PASSTHROUGH })
    const target: Target = { label: IU_API, url, credential: ['authorization', `Bearer ${iu.apiKey}`] }
    try {
      const upstream = await send(x, target)
      return answer(x, upstream, upstream.body, label, true)
    } catch (error) {
      return unreachable(x, label, true, error)
    }
  }

  const open = (request: Request, url: URL, caller: string, system: string): Exchange => {
    const span = telemetry.span(`gateway ${request.method} ${url.pathname}`, request.headers)
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let settle = () => {}
    const settledPromise = new Promise<void>((resolve) => {
      settle = resolve
    })
    const x: Exchange = {
      requestId: Bun.randomUUIDv7(),
      startedAtMs: Date.now(),
      caller,
      session: null,
      method: request.method,
      path: url.pathname,
      search: url.search,
      inbound: request.headers,
      body: undefined,
      requestedModel: null,
      model: null,
      system,
      span,
      abort,
      guard: {
        arm() {
          clearTimeout(timer)
          timer = setTimeout(() => abort.abort(), hangGuardMs)
        },
        disarm: () => clearTimeout(timer),
      },
      settled() {
        clearTimeout(timer)
        inflight.delete(x)
        settle()
      },
    }
    inflight.set(x, settledPromise)
    return x
  }

  const prepare = (x: Exchange, bytes: Bytes | undefined, parsed: Record<string, unknown> | null): void => {
    if (bytes !== undefined) {
      const { body, requested, model } = rewriteAlias(bytes, parsed)
      x.body = body
      x.requestedModel = requested
      x.model = model
    }
    x.requestedModel ??= modelFromPath(x.path)
    x.model ??= x.requestedModel
    x.session = sessionId(x.inbound, parsed)
    x.span.set({
      'gen_ai.system': x.system,
      'agw.gateway.caller': x.caller,
      'agw.gateway.request_id': x.requestId,
      ...(x.session === null ? {} : { 'agw.gateway.session': x.session }),
      ...(x.model === null ? {} : { 'gen_ai.request.model': x.model }),
    })
  }

  return {
    async handle(request, server) {
      const url = new URL(request.url)
      const route = routeOf(url.pathname, url.search)
      const caller = callerOf(request.headers)
      if (caller === null) {
        return route === null
          ? undefined
          : errorResponse(401, 'authentication_error', 'unauthorized', { ...BEARER_CHALLENGE })
      }
      if (route === null) return undefined
      if (route.kind === 'messages' && request.method !== 'POST') {
        return errorResponse(405, 'invalid_request_error', 'POST only')
      }
      // A non-streamed call is silent for as long as the model works, so no proxied request gets an idle cut.
      server.timeout(request, 0)
      const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
      const bytes = hasBody ? new Uint8Array(await request.arrayBuffer()) : undefined
      const anthropic = route.kind === 'messages'
      const parsed = bytes === undefined ? null : parseBody(bytes, request.headers.get('content-type'), anthropic)
      const x = open(request, url, caller, anthropic ? 'anthropic' : route.system)
      const onLeave = () => x.abort.abort()
      request.signal.addEventListener('abort', onLeave, { once: true })
      prepare(x, bytes, parsed)
      if (route.kind === 'iu') return servePassthrough(x, route.url)
      const picking = {
        claudeCodeShaped: isClaudeCodeShaped(request.headers, parsed),
        fallbackNone: request.headers.get('x-agw-fallback')?.trim().toLowerCase() === 'none',
      }
      return serveMessages(x, picking, route.countTokens)
    },

    async drained() {
      await Promise.all(inflight.values())
    },

    abortAll() {
      for (const x of inflight.keys()) x.abort.abort()
    },
  }
}

type PickLabel = { pool: string; reason: string }

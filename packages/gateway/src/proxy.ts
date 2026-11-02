import { createHash } from 'node:crypto'
import { BEARER_CHALLENGE } from '@agent-workflows/host/auth'
import { callerAuth, PLATFORM_CALLER } from '@agent-workflows/host/door-tokens'
import { BALANCE_MARKER, isBalanceFailure, resolveModelAlias } from '@agent-workflows/routes/pricing'
import { chargeOf, type RequestShape } from './charge.ts'
import type { IuUpstream } from './config.ts'
import { isRecord } from './json.ts'
import type { Attribution, Ledger, RecordRow } from './ledger.ts'
import { errorMessage, type Logger } from './log.ts'
import { isClaudeCodeShaped, type Pick, type Pools, sessionId } from './pools/index.ts'
import { decodeBody, type TeeResult, UsageTee } from './tee.ts'
import type { RequestSpan, Telemetry } from './telemetry.ts'

/** The label of the IU passthrough everywhere: a credit pool is itself named `iu`. */
export const IU_API = 'iu-api'
const REFUSED = 'refused'
/** The reason on a path with no pick: IU is the only upstream. */
const PASSTHROUGH = 'passthrough'
/** nginx's status for a caller that left before the request was read; no upstream saw it. */
const CALLER_LEFT = 499
/** What a caller sends is unbounded: past this a session id is stored and bound by its hash, an attribution is dropped. */
const MAX_CALLER_VALUE_CHARS = 200
/** `repoOf` of packages/middleware/src/usage.ts; the bundle rule keeps middleware out of this process. */
const REPO_SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** rules/agent-limits: a hang guard of 30 minutes on silence from upstream, never a cap on a long stream. */
const HANG_GUARD_MS = 30 * 60 * 1000
const MESSAGES_PATH = '/anthropic/v1/messages'
const COUNT_TOKENS_PATH = '/anthropic/v1/messages/count_tokens'
const MODELS_PATH = '/anthropic/v1/models'
/** One path segment: the personal key must not carry an encoded slash to IU. */
const MODEL_ID = /^[A-Za-z0-9._:-]+$/
/** The media agw prices itself, per minute, per character or per image. */
const CALLER_PRICED_PREFIXES = ['/openai/v1/images/', '/openai/v1/audio/', '/gemini/v1beta/', '/replicate/v1/'] as const
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
/** Header carriers of a door token beside `authorization`: the Anthropic, Gemini and Azure-style SDKs. */
const CREDENTIAL_HEADERS = ['x-api-key', 'x-goog-api-key', 'api-key'] as const
/** The query carrier (Gemini-style SDKs). */
const CREDENTIAL_PARAM = 'key'
/** Replaced (the caller's credentials) or recomputed by `fetch`. */
const NOT_FORWARDED: ReadonlySet<string> = new Set(['authorization', ...CREDENTIAL_HEADERS, 'host', 'content-length'])

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
  /** Requests in flight, an upload in progress included: resolves when the last one is settled. */
  drained(): Promise<void>
  /** Cuts every request in flight and finalizes it before returning: row, charge and span, with what it knows. */
  abortAll(): void
}

/** Where a path goes: a credit-eligible Anthropic call, IU's model catalog, or IU by path. */
type Route =
  | { kind: 'messages'; countTokens: boolean }
  | { kind: 'models'; url: string }
  | { kind: 'iu'; url: string; system: string }

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
  /** What an estimate needs of the request. */
  shape: RequestShape
  system: string
  span: RequestSpan
  abort: AbortController
  guard: { arm(): void; disarm(): void }
  /** What an abort means now: the phase the exchange is in sets it. */
  onCut: () => void
  /** Row written, span ended; set once by `close`. */
  closed: boolean
  /** Drops the exchange from the in-flight set. */
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

/** The query string without the credential parameter; every other pair keeps its bytes. */
function withoutCredential(search: string): string {
  const kept = search
    .slice(1)
    .split('&')
    .filter((pair) => pair !== '' && ![...new URLSearchParams(pair).keys()].includes(CREDENTIAL_PARAM))
  return kept.length === 0 ? '' : `?${kept.join('&')}`
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

/** The doc's one body edit, on the Anthropic paths only: an exact alias becomes the concrete id. Else the bytes stay. */
function rewriteAlias(
  bytes: Bytes,
  parsed: Record<string, unknown> | null,
  anthropic: boolean,
): { body: Bytes; requested: string | null; model: string | null } {
  const requested = typeof parsed?.model === 'string' ? parsed.model : null
  if (requested === null) return { body: bytes, requested, model: null }
  if (!anthropic) return { body: bytes, requested, model: requested }
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

/** Every use of a session id (pick, binding, row, span) takes this form. */
function boundedSession(session: string | null): string | null {
  if (session === null || session.length <= MAX_CALLER_VALUE_CHARS) return session
  return `h:${createHash('sha256').update(session).digest('hex').slice(0, 32)}`
}

/** `agw-opencode` is the OpenCode server's token: agw's workflows, through OpenCode. */
const laneOf = (caller: string): RecordRow['lane'] =>
  caller === 'agw' || caller === 'agw-opencode' ? 'agw_workflow' : caller === 'hermes' ? 'hermes' : 'other'

/** `x-agw-project` and `x-agw-workspace` as `usage.records` takes them; an empty or an overlong value is no value. */
function attributionOf(inbound: Headers): Attribution {
  const bounded = (name: string): string | null => {
    const value = inbound.get(name)
    return value === null || value === '' || value.length > MAX_CALLER_VALUE_CHARS ? null : value
  }
  const project = bounded('x-agw-project')
  const declared = bounded('x-agw-workspace')
  const workspace = declared === 'work' || declared === 'private' ? declared : null
  return {
    repo: project !== null && workspace !== 'work' && REPO_SLUG.test(project) ? project : null,
    project_raw: project,
    workspace,
  }
}

/** agw writes this request's row itself, because only it can price it. Any other caller or path keeps the gateway's row. */
const callerWritesUsage = (x: Exchange): boolean =>
  x.caller === PLATFORM_CALLER &&
  CALLER_PRICED_PREFIXES.some((prefix) => x.path.startsWith(prefix)) &&
  x.inbound.get('x-agw-usage')?.trim().toLowerCase() === 'caller'

/** The caller asked for IU itself; the credit pools are skipped as for a Claude-Code-shaped request. */
const callerForcesIu = (inbound: Headers): boolean => inbound.get('x-agw-upstream')?.trim().toLowerCase() === 'iu'

/**
 * The request path: door auth, the pick, the byte-exact forward, the usage tee, the ledger row, the span. A stream
 * goes through unbuffered and pull-driven, so a caller that hangs up cancels the upstream instead of paying for the rest.
 */
export function createProxy(options: ProxyOptions): GatewayProxy {
  const { pools, ledger, telemetry, logger, iu, machine } = options
  const hangGuardMs = options.hangGuardMs ?? HANG_GUARD_MS
  const auth = callerAuth({ tokens: options.doorTokens, secret: options.apiSecret })
  const inflight = new Map<Exchange, Promise<void>>()

  const callerOf = (headers: Headers, query: URLSearchParams): string | null => {
    const bearer = auth(headers.get('authorization'))
    if (bearer !== null) return bearer
    const carried = [...CREDENTIAL_HEADERS.map((name) => headers.get(name)), ...query.getAll(CREDENTIAL_PARAM)]
    for (const token of carried) {
      const caller = token ? auth(`Bearer ${token}`) : null
      if (caller !== null) return caller
    }
    return null
  }

  const routeOf = (pathname: string, search: string): Route | null => {
    if (pathname === MESSAGES_PATH) return { kind: 'messages', countTokens: false }
    if (pathname === COUNT_TOKENS_PATH) return { kind: 'messages', countTokens: true }
    const modelId = pathname.startsWith(`${MODELS_PATH}/`) ? pathname.slice(MODELS_PATH.length + 1) : null
    if (pathname === MODELS_PATH || (modelId !== null && MODEL_ID.test(modelId))) {
      return { kind: 'models', url: `${iu.anthropicBase}${pathname.slice('/anthropic'.length)}${search}` }
    }
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

  /** What the response reported, with a row or without one. Cost stays with the row: it is what the meter counted. */
  const spanUsage = (x: Exchange, tee: TeeResult): void => {
    const tokens = tee.tokens
    const model = tee.model ?? x.model
    x.span.set({
      'gen_ai.usage.input_tokens': tokens?.input ?? 0,
      'gen_ai.usage.output_tokens': tokens?.output ?? 0,
      'agw.gateway.cache_read_tokens': tokens?.cacheRead ?? 0,
      'agw.gateway.cache_write_tokens': (tokens?.cacheWrite5m ?? 0) + (tokens?.cacheWrite1h ?? 0),
      ...(model === null ? {} : { 'gen_ai.response.model': model }),
    })
  }

  /** The row and the charge: row first, so the meter's `rowAt` is the row's instant. Never throws into a stream. */
  const writeRow = (
    x: Exchange,
    input: { status: number; answered: boolean; pick: PickLabel; tee: TeeResult; ended: Ended },
  ): void => {
    const { status, answered, pick, tee, ended } = input
    const creditPool = pick.pool !== IU_API
    const model = tee.model ?? x.model
    const ok = status >= 200 && status < 300
    const billable = ok || !answered
    const cost = chargeOf({ tee, model, creditPool, billable, request: x.shape })
    const chargeUsd = cost.reportedUsd ?? cost.estimateUsd
    const tokens = tee.tokens
    const durationMs = Date.now() - x.startedAtMs
    const lane = laneOf(x.caller)
    const row: RecordRow = {
      source: 'gateway',
      source_id: x.requestId,
      grain: 'message',
      ts: new Date(x.startedAtMs).toISOString(),
      model_raw: x.requestedModel ?? model,
      model,
      ...attributionOf(x.inbound),
      billing: creditPool ? 'api_credit' : 'api_key',
      account: creditPool ? pick.pool : null,
      api_key: creditPool ? null : 'personal',
      machine,
      outcome: ok && ended === 'complete' && !tee.streamError ? 'ok' : 'error',
      lane,
      lane_detail: {
        caller: x.caller,
        // Argo labels an `other` row from this key.
        ...(lane === 'other' ? { raw: x.caller } : {}),
        session: x.session,
        run_id: x.inbound.get('x-agw-run-id'),
        workflow: x.inbound.get('x-agw-workflow'),
        step: x.inbound.get('x-agw-step'),
        purpose: x.inbound.get('x-agw-purpose'),
        pool: pick.pool,
        // `forced` is the caller's choice, not a fallback; `gateway_picks` keeps the reason.
        fallback: creditPool || pick.reason === 'forced' ? null : pick.reason,
        ...(cost.estimateUsd === null ? {} : { costEstimated: true, costEstimatedUsd: cost.estimateUsd }),
      },
      run_id: x.inbound.get('x-agw-run-id'),
      input_tokens: tokens?.input ?? 0,
      output_tokens: tokens?.output ?? 0,
      cache_read_tokens: tokens?.cacheRead ?? 0,
      cache_write_5m_tokens: tokens?.cacheWrite5m ?? 0,
      cache_write_1h_tokens: tokens?.cacheWrite1h ?? 0,
      reasoning_tokens: tokens?.reasoning ?? 0,
      duration_ms: durationMs,
      cost_reported_usd: cost.reportedUsd,
      raw: { path: x.path, status, ended, usageReported: tokens !== null, usageComplete: tee.complete },
    }
    x.span.set({
      ...(chargeUsd === null ? {} : { 'agw.cost.usd': chargeUsd }),
      ...(cost.estimateUsd === null ? {} : { 'agw.cost.estimated': true }),
    })
    let rowAt: Date
    try {
      rowAt = ledger.writeRecord(row, chargeUsd)
    } catch (error) {
      // /health degrades; the meter still counts it for this process's life.
      logger.error('ledger write failed; the row is lost', {
        requestId: x.requestId,
        error: errorMessage(error),
        pool: pick.pool,
        usd: chargeUsd,
      })
      rowAt = new Date()
    }
    if (creditPool && chargeUsd !== null) pools.charge(pick.pool, chargeUsd, rowAt)
    options.outbox?.poke()
  }

  /** The end of an exchange, once, whichever of the stream, the abort listener or the error path gets here first. */
  const close = (x: Exchange, status: number, failed: boolean, write?: () => void): void => {
    if (x.closed) return
    x.closed = true
    try {
      write?.()
    } catch (error) {
      logger.error('row not recorded', { requestId: x.requestId, error: errorMessage(error) })
    }
    x.span.set({ 'agw.gateway.status': status })
    x.span.end(failed)
    x.settled()
  }

  /** Closes the request with its row, unless it is a `count_tokens`. */
  const finisher = (x: Exchange, input: { status: number; answered: boolean; pick: PickLabel; record: boolean }) => {
    return (tee: TeeResult, ended: Ended): void => {
      const failed = input.status >= 400 || ended !== 'complete' || tee.streamError
      close(x, input.status, failed, () => {
        spanUsage(x, tee)
        if (input.record) writeRow(x, { ...input, tee, ended })
      })
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
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined
    // No pull need be pending (a stalled caller, a cut before the first one): the abort itself finishes the exchange.
    x.onCut = () => {
      finish(tee.finish(), 'aborted')
      void reader.cancel().catch(() => {})
      stream?.error(x.abort.signal.reason)
    }
    return new ReadableStream<Uint8Array>(
      {
        start(controller) {
          stream = controller
        },
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
      wire: x.system === 'anthropic' || x.system === 'openai' ? x.system : null,
    })
    const finish = finisher(x, { status: upstream.status, answered: true, pick, record })
    if (body === null || NULL_BODY_STATUSES.has(upstream.status)) {
      finish(tee.finish(), 'complete')
      return new Response(null, { status: upstream.status, statusText: upstream.statusText, headers })
    }
    const stream = streamed(x, body, tee, finish)
    return new Response(stream, { status: upstream.status, statusText: upstream.statusText, headers })
  }

  const noUsage: TeeResult = {
    usage: null,
    tokens: null,
    model: null,
    streamError: false,
    complete: false,
    bytesReceived: 0,
  }
  const CUT_STATUS = 504

  /** Sent upstream, no response yet: an abort closes the exchange here. */
  const awaitingUpstream = (x: Exchange, pick: PickLabel, record: boolean): void => {
    x.onCut = () => finisher(x, { status: CUT_STATUS, answered: false, pick, record })(noUsage, 'aborted')
  }

  /** No response came: the caller left, the guard fired or the network failed. */
  const unreachable = (x: Exchange, pick: PickLabel, record: boolean, error: unknown): Response => {
    const aborted = x.abort.signal.aborted
    const status = aborted ? CUT_STATUS : 502
    if (!aborted)
      logger.warn('upstream unreachable', { requestId: x.requestId, pool: pick.pool, error: errorMessage(error) })
    finisher(x, { status, answered: false, pick, record })(noUsage, aborted ? 'aborted' : 'failed')
    return errorResponse(status, 'api_error', aborted ? 'upstream cut' : 'upstream unreachable', {
      'x-agw-request-id': x.requestId,
      'x-agw-pool': pick.pool,
    })
  }

  /** The 402 of `x-agw-fallback: none`: the caller's own route fallback takes over. */
  const refuse = (x: Exchange, reason: string): Response => {
    x.span.set({ 'agw.gateway.pool': REFUSED, 'agw.gateway.pick_reason': reason })
    close(x, 402, true)
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

  /**
   * §Picking a pool: the pick and the forward. A balance refusal drains that pool and picks again without it, until the
   * pick is no pool: the loop ends after at most one attempt per pool, on IU or on the 402.
   */
  const serveMessages = async (
    x: Exchange,
    picking: { forceIu: boolean; claudeCodeShaped: boolean; fallbackNone: boolean },
    countTokens: boolean,
  ): Promise<Response> => {
    const record = !countTokens
    const input = { caller: x.caller, session: x.session, ...picking }
    const exclude: string[] = []
    for (;;) {
      const pick = pools.pick({ ...input, exclude })
      recordPick(x, pick, record)
      if (pick.kind === 'refuse') return refuse(x, pick.reason)
      servesPick(x, pick)
      const target = targetOf(pick, x)
      const label: PickLabel = { pool: target.label, reason: pick.reason }
      let upstream: Response
      let held: Uint8Array | null = null
      awaitingUpstream(x, label, record)
      try {
        upstream = await send(x, target)
        if (pick.kind === 'pool') {
          const refusal = await refusalOf(x, upstream)
          held = refusal.bytes
          if (refusal.balance) {
            pools.drained(pick.pool, pick.cycleStart)
            exclude.push(pick.pool)
            continue
          }
        }
      } catch (error) {
        return unreachable(x, label, record, error)
      }
      // `served` with no pool clears the binding, and a forced request must leave the session's pool as it found it.
      if (upstream.ok && record && !picking.forceIu) {
        pools.served(x.caller, x.session, pick.kind === 'pool' ? pick.pool : null)
      }
      return answer(x, upstream, held === null ? upstream.body : heldBody(held), label, record)
    }
  }

  const servePassthrough = async (x: Exchange, url: string, record: boolean): Promise<Response> => {
    const label: PickLabel = { pool: IU_API, reason: PASSTHROUGH }
    x.span.set({ 'agw.gateway.pool': IU_API, 'agw.gateway.pick_reason': PASSTHROUGH })
    const target: Target = { label: IU_API, url, credential: ['authorization', `Bearer ${iu.apiKey}`] }
    awaitingUpstream(x, label, record)
    try {
      const upstream = await send(x, target)
      return answer(x, upstream, upstream.body, label, record)
    } catch (error) {
      return unreachable(x, label, record, error)
    }
  }

  const open = (request: Request, url: URL, search: string, caller: string, system: string): Exchange => {
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
      search,
      inbound: request.headers,
      body: undefined,
      requestedModel: null,
      model: null,
      shape: { bytes: 0, maxTokens: null, streamed: false },
      system,
      span,
      abort,
      onCut: () => {},
      closed: false,
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
    // Reading the request: nothing went upstream, so an abort closes it without a row.
    x.onCut = () => close(x, CALLER_LEFT, true)
    abort.signal.addEventListener(
      'abort',
      () => {
        if (!x.closed) x.onCut()
      },
      { once: true },
    )
    request.signal.addEventListener('abort', () => abort.abort(), { once: true })
    return x
  }

  const prepare = (
    x: Exchange,
    bytes: Bytes | undefined,
    parsed: Record<string, unknown> | null,
    anthropic: boolean,
  ): void => {
    if (bytes !== undefined) {
      const { body, requested, model } = rewriteAlias(bytes, parsed, anthropic)
      x.body = body
      x.requestedModel = requested
      x.model = model
    }
    x.requestedModel ??= modelFromPath(x.path)
    x.model ??= x.requestedModel
    x.session = boundedSession(sessionId(x.inbound, parsed))
    x.shape = {
      bytes: bytes?.byteLength ?? 0,
      maxTokens: typeof parsed?.max_tokens === 'number' ? parsed.max_tokens : null,
      streamed: parsed?.stream === true,
    }
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
      const search = withoutCredential(url.search)
      const route = routeOf(url.pathname, search)
      const caller = callerOf(request.headers, url.searchParams)
      if (caller === null) {
        return route === null
          ? undefined
          : errorResponse(401, 'authentication_error', 'unauthorized', { ...BEARER_CHALLENGE })
      }
      if (route === null) return undefined
      if (route.kind === 'messages' && request.method !== 'POST') {
        return errorResponse(405, 'invalid_request_error', 'POST only')
      }
      if (route.kind === 'models' && request.method !== 'GET') {
        return errorResponse(405, 'invalid_request_error', 'GET only')
      }
      // A non-streamed call is silent for as long as the model works, so no proxied request gets an idle cut.
      server.timeout(request, 0)
      const anthropic = route.kind === 'messages'
      const x = open(request, url, search, caller, route.kind === 'iu' ? route.system : 'anthropic')
      const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
      let bytes: Bytes | undefined
      try {
        bytes = hasBody ? new Uint8Array(await request.arrayBuffer()) : undefined
      } catch {
        close(x, CALLER_LEFT, true)
      }
      if (x.closed) return errorResponse(CALLER_LEFT, 'invalid_request_error', 'request not read')
      const parsed = bytes === undefined ? null : parseBody(bytes, request.headers.get('content-type'), anthropic)
      prepare(x, bytes, parsed, anthropic)
      if (route.kind === 'models') return servePassthrough(x, route.url, false)
      if (route.kind === 'iu') return servePassthrough(x, route.url, !callerWritesUsage(x))
      const picking = {
        forceIu: callerForcesIu(request.headers),
        claudeCodeShaped: isClaudeCodeShaped(request.headers, parsed),
        fallbackNone: request.headers.get('x-agw-fallback')?.trim().toLowerCase() === 'none',
      }
      return serveMessages(x, picking, route.countTokens)
    },

    async drained() {
      await Promise.all(inflight.values())
    },

    abortAll() {
      for (const x of [...inflight.keys()]) x.abort.abort()
    },
  }
}

type PickLabel = { pool: string; reason: string }

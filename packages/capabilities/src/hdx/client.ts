import { fail } from '../errors.ts'
import { Attempt, withRetries } from '../transports/http.ts'
import { type HdxEnv, hdxBase, hdxKey, type ResolvedHdxDeps } from './deps.ts'

/** How much of an error body travels in the message: enough for a validation error, not a page. */
const ERROR_DETAIL_CHARS = 2_000
/** An error body is read to this many bytes and no further. */
const ERROR_BODY_BYTES = 64 * 1024
/** A success body is read to this many bytes and no further. */
export const MAX_RESPONSE_BYTES = 4_000_000
const REST_PREFIX = '/api/api/v2'

interface Sent {
  status: number
  text: string
  /** The body was longer than `MAX_RESPONSE_BYTES`, so `text` is a prefix. */
  cut: boolean
}

/**
 * Reads at most `maxBytes` of a body and cancels the rest of the stream. `complete` is asked after each chunk and ends
 * the read as soon as it says so: an SSE stream that stays open after its answer must not hold the call to the timeout.
 */
async function readBody(
  res: Response,
  maxBytes: number,
  complete?: (text: string) => boolean,
): Promise<{ text: string; cut: boolean }> {
  if (!res.body) return { text: '', cut: false }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let bytes = 0
  let cut = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const room = maxBytes - bytes
      if (value.byteLength > room) {
        text += decoder.decode(value.subarray(0, room))
        cut = true
        break
      }
      bytes += value.byteLength
      text += decoder.decode(value, { stream: true })
      if (complete?.(text)) break
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  return { text, cut }
}

/**
 * One HTTP exchange with HyperDX, retried by the package's helper on 429/5xx and transport failures. Redirects are
 * never followed (the bearer key must not leave for another host): a 3xx is an error. A timeout is not retried. A 400
 * with an empty body is the dev ClickStack's connection race, rejected before it was processed, so a retrying call
 * resends it once; a call that must be sent once (`retry: false`) never resends. A non-2xx answer is `UPSTREAM_ERROR`.
 */
async function send(
  deps: ResolvedHdxDeps,
  hdxEnv: HdxEnv,
  signal: AbortSignal,
  request: { url: string; method: string; body?: unknown; accept: string; complete?: (text: string) => boolean },
  options: { retry: boolean },
): Promise<Sent> {
  const key = hdxKey(deps, hdxEnv)
  const once = async (): Promise<Sent> => {
    try {
      const res = await deps.fetch(request.url, {
        method: request.method,
        redirect: 'manual',
        headers: {
          authorization: `Bearer ${key}`,
          accept: request.accept,
          ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(deps.timeoutMs)]),
      })
      const ok = res.status >= 200 && res.status < 300
      const { text, cut } = await readBody(
        res,
        ok ? MAX_RESPONSE_BYTES : ERROR_BODY_BYTES,
        ok ? request.complete : undefined,
      )
      return { status: res.status, text, cut }
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError')
        throw new Attempt(`hdx ${hdxEnv} timed out after ${deps.timeoutMs / 1000} s`, false)
      if (error instanceof Error && error.name === 'AbortError') throw error
      // The cause names the URL; the message names the environment only.
      throw new Attempt(`hdx ${hdxEnv} unreachable`, true)
    }
  }
  const attempt = async (): Promise<Sent> => {
    let sent = await once()
    if (options.retry && sent.status === 400 && sent.text.trim() === '') sent = await once()
    if (sent.status >= 200 && sent.status < 300) return sent
    if (sent.status >= 300 && sent.status < 400)
      throw new Attempt(`hdx ${hdxEnv} answered with a redirect (${sent.status}); not followed`, false, sent.status)
    const retryable = sent.status === 429 || sent.status >= 500
    const detail = sent.text.slice(0, ERROR_DETAIL_CHARS).trim()
    const what = sent.status === 401 || sent.status === 403 ? 'rejected the access key' : 'request failed'
    throw new Attempt(`hdx ${hdxEnv} ${what} (${sent.status})${detail ? `: ${detail}` : ''}`, retryable, sent.status)
  }
  return withRetries(options.retry ? deps.retry : { ...deps.retry, attempts: 1 }, signal, attempt)
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object'

/** The response to request `id` among parsed JSON-RPC values (one message or a batch); else an error with id null. */
function pick(value: unknown, id: number): Record<string, unknown> | undefined {
  const items = (Array.isArray(value) ? value : [value]).filter(isObject)
  return items.find((m) => m.id === id) ?? items.find((m) => m.id === null && m.error !== undefined)
}

/**
 * The JSON-RPC response to `id` in an SSE body (`event: message` / `data: {...}`) or in a bare JSON body (also a
 * batch array). A message for another id is not the answer; an error with id null (the server could not read the
 * request) is.
 */
export function parseRpcMessage(raw: string, id: number): Record<string, unknown> | undefined {
  const text = raw.replace(/\r\n/g, '\n').trim()
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      return pick(JSON.parse(text), id)
    } catch {
      return undefined
    }
  }
  for (const block of text.split('\n\n')) {
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trim())
      .join('\n')
    if (!data) continue
    try {
      const message = pick(JSON.parse(data), id)
      if (message) return message
    } catch {
      // not a JSON event (a comment, a ping): next block
    }
  }
  return undefined
}

/** Whether the SSE text read so far holds a finished event that answers `id` (an event ends at a blank line). */
const answered = (id: number) => (text: string) => {
  const normalized = text.replace(/\r\n/g, '\n')
  const end = normalized.lastIndexOf('\n\n')
  return end !== -1 && parseRpcMessage(normalized.slice(0, end + 2), id) !== undefined
}

/** A JSON-RPC call to the ClickStack MCP endpoint (stateless: no session, no `initialized`). Returns `result`. */
export async function rpc(
  deps: ResolvedHdxDeps,
  hdxEnv: HdxEnv,
  signal: AbortSignal,
  method: string,
  params: Record<string, unknown>,
  options: { retry?: boolean } = {},
): Promise<Record<string, unknown>> {
  const id = 1
  const sent = await send(
    deps,
    hdxEnv,
    signal,
    {
      url: `${hdxBase(deps, hdxEnv)}/api/mcp`,
      method: 'POST',
      body: { jsonrpc: '2.0', id, method, params },
      accept: 'application/json, text/event-stream',
      complete: answered(id),
    },
    { retry: options.retry ?? true },
  )
  const message = parseRpcMessage(sent.text, id)
  if (!message) {
    if (sent.cut)
      throw fail(
        'UPSTREAM_ERROR',
        `hdx ${hdxEnv}: ${method} answer is over ${MAX_RESPONSE_BYTES} bytes; narrow the query`,
        {},
      )
    throw fail('UPSTREAM_ERROR', `hdx ${hdxEnv}: ${method} answered without a JSON-RPC message`, {})
  }
  if (message.error !== undefined) {
    const error = isObject(message.error) ? message.error : {}
    const detail = typeof error.message === 'string' ? error.message.slice(0, ERROR_DETAIL_CHARS) : 'unknown error'
    throw fail(
      'UPSTREAM_ERROR',
      `hdx ${hdxEnv}: ${method} failed (JSON-RPC ${String(error.code ?? '?')}): ${detail}`,
      {},
    )
  }
  return isObject(message.result) ? message.result : {}
}

/**
 * Whether a REST v2 path stays under `/api/api/v2`: after the URL parser has collapsed `..`, and with no encoded
 * slash, backslash or dot segment (`%2f`, `%5c`, `%2e`, any case) that a server might decode after the check.
 */
export function restPathStaysUnder(path: string): boolean {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\') || path.includes('#')) return false
  const pathname = path.split('?')[0]!
  if (/%2f|%5c/i.test(pathname)) return false
  if (pathname.split('/').some((segment) => /^(\.|%2e){1,2}$/i.test(segment))) return false
  const root = new URL('https://hdx.invalid')
  const url = new URL(`${root.origin}${REST_PREFIX}${path}`)
  return url.origin === root.origin && (url.pathname === REST_PREFIX || url.pathname.startsWith(`${REST_PREFIX}/`))
}

function restUrl(base: string, path: string): string {
  if (!restPathStaysUnder(path)) throw new Error('hdx rest: path leaves /api/api/v2')
  return new URL(`${base}${REST_PREFIX}${path}`).toString()
}

/** A REST v2 call. `status` is the 2xx that answered; `text` its body, a prefix when `cut`. */
export async function rest(
  deps: ResolvedHdxDeps,
  hdxEnv: HdxEnv,
  signal: AbortSignal,
  method: string,
  path: string,
  body?: unknown,
  options: { retry?: boolean } = {},
): Promise<Sent> {
  return send(
    deps,
    hdxEnv,
    signal,
    { url: restUrl(hdxBase(deps, hdxEnv), path), method, body, accept: 'application/json' },
    { retry: options.retry ?? true },
  )
}

/** Cuts `text` to `max` characters with a marker the reader (often an agent) cannot miss. */
export function capText(text: string, max: number): { text: string; truncated: boolean; totalChars: number } {
  if (text.length <= max) return { text, truncated: false, totalChars: text.length }
  const marker = `\n[truncated: showing ${max} of ${text.length} characters; narrow the query or raise maxChars]`
  return { text: text.slice(0, max) + marker, truncated: true, totalChars: text.length }
}

/** `capText` for a body that may itself have been cut at the byte cap: the marker says so. */
export function capBody(sent: Sent, max: number): { text: string; truncated: boolean; totalChars: number } {
  const capped = capText(sent.text, max)
  if (!sent.cut) return capped
  return {
    text: `${capped.text}\n[truncated: the response was cut at ${MAX_RESPONSE_BYTES} bytes]`,
    truncated: true,
    totalChars: capped.totalChars,
  }
}

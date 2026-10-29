import { fail } from '../errors.ts'
import { Attempt, withRetries } from '../transports/http.ts'
import { type HdxEnv, hdxBase, hdxKey, type ResolvedHdxDeps } from './deps.ts'

const REQUEST_TIMEOUT_MS = 60_000
/** How much of an error body travels in the message: enough for a validation error, not a page. */
const ERROR_DETAIL_CHARS = 2_000
const REST_PREFIX = '/api/api/v2'

interface Sent {
  status: number
  text: string
}

/**
 * One HTTP exchange with HyperDX, retried by the package's helper on 429/5xx and transport failures (a timeout is not
 * retried). A 400 with an empty body is the dev ClickStack's connection race, not a bad request: it was rejected before
 * it was processed, so one immediate resend is safe for any method. A non-2xx answer is `UPSTREAM_ERROR` with its status.
 */
async function send(
  deps: ResolvedHdxDeps,
  hdxEnv: HdxEnv,
  signal: AbortSignal,
  request: { url: string; method: string; body?: unknown; accept: string },
  options: { retry: boolean },
): Promise<Sent> {
  const key = hdxKey(deps, hdxEnv)
  const once = async (): Promise<Sent> => {
    let res: Response
    try {
      res = await deps.fetch(request.url, {
        method: request.method,
        headers: {
          authorization: `Bearer ${key}`,
          accept: request.accept,
          ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      })
    } catch (error) {
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) throw error
      // The cause names the URL; the message names the environment only.
      throw new Attempt(`hdx ${hdxEnv} unreachable`, true)
    }
    return { status: res.status, text: await res.text().catch(() => '') }
  }
  const attempt = async (): Promise<Sent> => {
    let sent = await once()
    if (sent.status === 400 && sent.text.trim() === '') sent = await once()
    if (sent.status >= 200 && sent.status < 300) return sent
    const retryable = sent.status === 429 || sent.status >= 500
    const detail = sent.text.slice(0, ERROR_DETAIL_CHARS).trim()
    const what = sent.status === 401 || sent.status === 403 ? 'rejected the access key' : 'request failed'
    throw new Attempt(`hdx ${hdxEnv} ${what} (${sent.status})${detail ? `: ${detail}` : ''}`, retryable, sent.status)
  }
  return withRetries(options.retry ? deps.retry : { ...deps.retry, attempts: 1 }, signal, attempt)
}

/** The first JSON-RPC message with `id` in an SSE body (`event: message` / `data: {...}`), or in a bare JSON body. */
export function parseRpcMessage(raw: string, id: number): Record<string, unknown> | undefined {
  const text = raw.replace(/\r\n/g, '\n').trim()
  if (text.startsWith('{')) {
    try {
      return JSON.parse(text) as Record<string, unknown>
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
      const message = JSON.parse(data) as Record<string, unknown>
      if (message.id === id) return message
    } catch {
      // not a JSON event (a comment, a ping): next block
    }
  }
  return undefined
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
    },
    { retry: options.retry ?? true },
  )
  const message = parseRpcMessage(sent.text, id)
  if (!message) throw fail('UPSTREAM_ERROR', `hdx ${hdxEnv}: ${method} answered without a JSON-RPC message`, {})
  if (message.error !== undefined) {
    const error = message.error as { code?: unknown; message?: unknown }
    const detail = typeof error.message === 'string' ? error.message.slice(0, ERROR_DETAIL_CHARS) : 'unknown error'
    throw fail(
      'UPSTREAM_ERROR',
      `hdx ${hdxEnv}: ${method} failed (JSON-RPC ${String(error.code ?? '?')}): ${detail}`,
      {},
    )
  }
  return (message.result ?? {}) as Record<string, unknown>
}

/** Whether a REST v2 path stays under `/api/api/v2` once the URL parser has collapsed any `..` (or `%2e%2e`). */
export function restPathStaysUnder(path: string): boolean {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) return false
  const root = new URL('https://hdx.invalid')
  const url = new URL(`${root.origin}${REST_PREFIX}${path}`)
  return url.origin === root.origin && (url.pathname === REST_PREFIX || url.pathname.startsWith(`${REST_PREFIX}/`))
}

function restUrl(base: string, path: string): string {
  if (!restPathStaysUnder(path)) throw new Error('hdx rest: path leaves /api/api/v2')
  return new URL(`${base}${REST_PREFIX}${path}`).toString()
}

/** A REST v2 call. `status` is the 2xx that answered; `text` its body. */
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

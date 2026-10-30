import { CapabilityError } from '../errors.ts'
import { Attempt, describe, type HttpOptions, withRetries } from '../transports/http.ts'
import { failedImageResponse } from './upstream.ts'

/** The body of a response, read to the end only while it stays within `max` bytes; null once it would not. */
export async function readBytes(res: Response, max: number): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel()
    return null
  }
  const reader = res.body?.getReader()
  if (!reader) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > max) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  return new Uint8Array(Buffer.concat(chunks))
}

/** A JSON body read within `max` bytes. An oversize or garbled body is an `Attempt`; `retryable` says whether a resend is safe. */
export async function readJsonBounded(res: Response, wire: string, max: number, retryable: boolean): Promise<unknown> {
  let bytes: Uint8Array | null
  try {
    bytes = await readBytes(res, max)
  } catch (error) {
    throw new Attempt(`${wire} body could not be read: ${describe(error)}`, retryable)
  }
  if (!bytes) throw new Attempt(`${wire} body is over ${max} bytes`, false)
  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw new Attempt(`${wire} body is not JSON (cut or garbled)`, retryable)
  }
}

/** The one failure that proves a request never reached the server: the connection was refused. */
export function isConnectRefused(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === 'ConnectionRefused' || code === 'ECONNREFUSED'
}

export interface SendOptions<T> {
  retry: Pick<HttpOptions, 'attempts' | 'backoffMs'>
  signal: AbortSignal
  wire: string
  request: () => Promise<Response>
  read: (res: Response) => Promise<T>
  /**
   * What may be sent again. `idempotent` (a GET): anything transient. Otherwise the request may have landed and been
   * billed, so only proof that nothing was started repeats it: a refused connection, and the statuses `status` names.
   */
  idempotent: boolean
  status: (status: number) => boolean
}

/** One billed or free request with its retry rule made explicit; failures are `UPSTREAM_ERROR`s through `withRetries`. */
export function send<T>(options: SendOptions<T>): Promise<T> {
  return withRetries(options.retry, options.signal, async () => {
    let res: Response
    try {
      res = await options.request()
    } catch (error) {
      const retryable = options.idempotent
        ? !(error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name))
        : isConnectRefused(error)
      throw new Attempt(describe(error), retryable, undefined, undefined, true)
    }
    if (!res.ok) {
      const failed = await failedImageResponse(res, options.wire)
      throw options.idempotent || options.status(res.status)
        ? failed
        : new Attempt(failed.message, false, failed.status)
    }
    try {
      return await options.read(res)
    } catch (error) {
      if (error instanceof Attempt) throw error
      // A CapabilityError is the reader's own verdict (a frame that does not fit); anything else is the connection failing.
      throw new Attempt(
        describe(error),
        options.idempotent,
        undefined,
        undefined,
        error instanceof CapabilityError ? undefined : true,
      )
    }
  })
}

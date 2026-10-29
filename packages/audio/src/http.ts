import type { AudioScope } from './scope.ts'

export interface RawResponse {
  status: number
  body: string
}

/** Upper bound on a server-requested retry delay, so a bogus hint cannot stall a caller. */
const MAX_RETRY_DELAY_MS = 15_000

/** A delay in seconds as non-negative ms, or null when it is blank, not a number, or overflows. */
function secondsToMs(value: unknown): number | null {
  if (typeof value === 'string' ? value.trim() === '' : typeof value !== 'number') return null
  const ms = Number(value) * 1000
  return Number.isFinite(ms) ? Math.max(0, ms) : null
}

/** An RFC 9110 Retry-After value: delay-seconds or an HTTP-date. Blank is absent. */
function parseRetryAfter(value: string, now: number): number | null {
  if (value.trim() === '') return null
  const seconds = secondsToMs(value)
  if (seconds !== null) return seconds
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - now) : null
}

/** The server's retry hint from the `Retry-After` header alone, in ms, or null. */
export function retryHintFromHeaders(headers: Headers, now = Date.now()): number | null {
  const header = headers.get('retry-after')
  return header === null ? null : parseRetryAfter(header, now)
}

/** The hint from a 429/503 body: a `retry_after` JSON field, else Replicate's "resets in ~30s" prose. */
export function retryHintFromBody(body: string): number | null {
  try {
    const field = (JSON.parse(body) as { retry_after?: unknown } | null)?.retry_after
    if (field !== undefined && field !== null && field !== '') {
      const ms = secondsToMs(field)
      if (ms !== null) return ms
    }
  } catch {
    // not JSON: the prose form below
  }
  const prose = /resets in\s*~?\s*([\d.]+)\s*s/i.exec(body)
  return secondsToMs(prose?.[1])
}

/** Header first, then the body. */
export function retryHintMs(headers: Headers, body: string): number | null {
  return retryHintFromHeaders(headers) ?? retryHintFromBody(body)
}

const RETRY_HINT_BODY_TIMEOUT_MS = 2_000
export const RETRY_HINT_BODY_MAX_BYTES = 65_536

/**
 * Read a 429/503 body for its retry hint, bounded in time and bytes. Only a body read to its end within both bounds
 * is parsed (a fragment's `retry_after` could be cut mid-token); otherwise the stream is cancelled and the result is
 * null. Never throws.
 */
export async function readBodyHint(
  res: Response,
  timeoutMs = RETRY_HINT_BODY_TIMEOUT_MS,
  maxBytes = RETRY_HINT_BODY_MAX_BYTES,
): Promise<number | null> {
  const body = res.body
  if (!body) return null
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    body.cancel().catch(() => {})
    return null
  }
  let reader: ReadableStreamDefaultReader<Uint8Array>
  try {
    reader = body.getReader()
  } catch {
    return null
  }
  const decoder = new TextDecoder()
  const timedOut = Symbol('timeout')
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<typeof timedOut>((resolve) => {
    timer = setTimeout(() => resolve(timedOut), timeoutMs)
  })
  const deadlineAt = Date.now() + timeoutMs
  let text = ''
  let bytes = 0
  try {
    for (;;) {
      // A source answering every read with an empty chunk could starve the timer, so the clock is checked too.
      if (Date.now() >= deadlineAt) break
      const result = await Promise.race([reader.read(), deadline])
      if (result === timedOut || Date.now() >= deadlineAt) break
      if (result.done) {
        text += decoder.decode()
        return retryHintFromBody(text)
      }
      bytes += result.value.byteLength
      if (bytes > maxBytes) break
      text += decoder.decode(result.value, { stream: true })
    }
  } catch {
    // unreadable body: the fixed backoff
  } finally {
    clearTimeout(timer)
  }
  // Fire and forget: a stream whose cancel() never settles must not hold the retry.
  reader.cancel().catch(() => {})
  return null
}

/** The wait before retrying a 429/503: the server's hint (header first; the body only without one), capped. */
export async function throttleDelay(res: Response, attempt: number): Promise<number> {
  const headerHint = retryHintFromHeaders(res.headers)
  if (headerHint !== null) res.body?.cancel().catch(() => {})
  const hint = headerHint ?? (await readBodyHint(res))
  return Math.min(MAX_RETRY_DELAY_MS, Math.max(500 * attempt, hint ?? 0))
}

/**
 * fetch with backoff on 503/429 (honouring the server's hint) and on transport failures (a reset or a socket closed
 * mid-body is as transient as a 503). The last attempt's error propagates; an aborted signal is never retried.
 */
export async function rawFetch(scope: AudioScope, url: string, init: RequestInit, attempts = 3): Promise<RawResponse> {
  const { fetch, clock } = scope.deps
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, init)
      if ((res.status === 503 || res.status === 429) && attempt < attempts) {
        scope.retried()
        await clock.sleep(await throttleDelay(res, attempt))
        continue
      }
      return { status: res.status, body: await res.text() }
    } catch (error) {
      if (attempt >= attempts || init.signal?.aborted) throw error
      scope.retried()
      await clock.sleep(1000 * attempt)
    }
  }
  throw new Error('unreachable')
}

/** Upstream headers carrying the IU bearer token. */
export const iuHeaders = (scope: AudioScope, extra: Record<string, string> = {}): Record<string, string> => ({
  Authorization: `Bearer ${scope.config.transports.apiKey}`,
  ...extra,
})

export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

import { BALANCE_MARKER, isBalanceFailure } from '@agent-workflows/routes'
import { CapabilityError, fail } from '../errors.ts'

export interface HttpOptions {
  /** Default 3: the first call plus two retries. */
  attempts?: number
  /** Base of the 3x backoff between attempts. Default 500. */
  backoffMs?: number
  /** Streamed wires: abort when no chunk arrives for this long. Default 5 minutes. */
  idleTimeoutMs?: number
  /** Non-streamed wires: a hang guard, never a budget (agent-limits). Default 30 minutes. */
  hangGuardMs?: number
  fetch?: (url: string, init: RequestInit) => Promise<Response>
}

export const DEFAULTS = {
  attempts: 3,
  backoffMs: 500,
  idleTimeoutMs: 5 * 60_000,
  hangGuardMs: 30 * 60_000,
} as const

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])

/** A failed attempt, classified by whoever saw it. */
export class Attempt extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
    /** The vendor's own words of a wrapped 400 (`UPSTREAM_ERROR` data `userError`). */
    readonly userError?: UserError,
    /** The attempt failed below the vendor's answer (no response, a cut body): the message is the client library's text. */
    readonly transport?: true,
    /** The gateway's `x-agw-request-id` of the failed response: what a route fallback names as the call it replaces. */
    readonly requestId?: string,
  ) {
    super(message)
  }
}

/** What a vendor-wrapped 400 says, structured: its message, its code and, for a moderation block, the stage and categories. */
export interface UserError {
  message: string
  code?: string
  /** A block names its stage, its categories, or both; whichever the vendor sent. */
  moderation?: { stage?: string; categories?: string[] }
}

/**
 * A non-2xx response. 410 (dead model) and client errors fail fast; IU relays some upstream 400s as 503. A provider
 * balance failure (`isBalanceFailure`: 402, 503 "Insufficient Balance", Anthropic's 400 "credit balance is too low to
 * access the Anthropic API", or OpenAI's 429 `insufficient_quota`; the check runs before the retry decision, so that 429
 * is not retried as a rate limit) fails fast too: retrying an empty account only bills the wait, and the caller moves to
 * the route's fallback. Its message carries `BALANCE_MARKER`, which `isBalanceError` re-classifies on a 400 or 429 too: the
 * body is cut to 300 chars, so the marker is what survives when the sentence sits past the cut.
 */
export async function failedResponse(res: Response, wire: string): Promise<Attempt> {
  const body = await res.text().catch(() => '')
  const detail = body.slice(0, 300)
  const requestId = res.headers.get('x-agw-request-id') ?? undefined
  if (isBalanceFailure({ status: res.status, text: body })) {
    return new Attempt(
      `${wire} ${BALANCE_MARKER} (${res.status}): ${detail}`,
      false,
      res.status,
      undefined,
      undefined,
      requestId,
    )
  }
  const retryable = RETRYABLE_STATUS.has(res.status) && !detail.includes('invalid_request_error')
  const prefix = res.status === 410 ? 'model deprecated (410)' : `${wire} request failed (${res.status})`
  return new Attempt(`${prefix}: ${detail}`, retryable, res.status, undefined, undefined, requestId)
}

/**
 * The attempt for a request that threw: a hang guard or an abort is spent wait (not retried, not `transport`); anything
 * else is retryable. One that never got a response (a refused or reset connection) is marked `transport`, so the
 * exhausted call is an outage a route's fallback answers (`isOutageError`); a throw after the response began (a stream
 * cut mid-answer) is retried but not marked: the vendor may have billed it.
 */
export function requestFailure(error: unknown, responded = false): Attempt {
  const spent = isAbort(error)
  return new Attempt(describe(error), !spent, undefined, undefined, spent || responded ? undefined : true)
}

/** A transport failure that a route's fallback answers: the classifier over a failed call's status and message. */
export function isBalanceError(error: unknown): boolean {
  if (!(error instanceof CapabilityError) || error.code !== 'UPSTREAM_ERROR') return false
  const status = (error.data as { status?: unknown } | undefined)?.status
  return isBalanceFailure({ ...(typeof status === 'number' ? { status } : {}), text: error.message })
}

/** The statuses of an upstream that is down, not a request that is wrong: a bad gateway, an unavailable service, a gateway timeout. */
const OUTAGE_STATUS = new Set([502, 503, 504])

/**
 * A failed call whose primary route is out: the retries ran out (`exhausted`: a fail-fast answer, such as the 503 that
 * wraps an `invalid_request_error`, never qualifies) on a 502/503/504 that is not a balance refusal, or on a connection
 * that never reached the vendor (`transport`; a hang guard or an idle stop is spent wait, not an outage). A route's
 * fallback answers it, once. 429 and 500 stay with the retries: no 429 in the 14-day ledger audit, and a 500 is as
 * likely the request as the host.
 */
export function isOutageError(error: unknown): boolean {
  if (!(error instanceof CapabilityError) || error.code !== 'UPSTREAM_ERROR' || isBalanceError(error)) return false
  const data = error.data as { status?: unknown; transport?: unknown; exhausted?: unknown } | undefined
  if (data?.exhausted !== true) return false
  if (data.transport === true) return true
  return typeof data.status === 'number' && OUTAGE_STATUS.has(data.status)
}

/**
 * The gateway's request id of the response a failed call died on (`x-agw-request-id`; the 402 of a drained credit has
 * one and a `gateway_picks` row under it). A route fallback sends it as `Attribution.routeFallback`, so the fallback
 * row joins the refusal. Absent when the failure did not come back through the gateway.
 */
export function refusedRequestId(error: unknown): string | undefined {
  if (!(error instanceof CapabilityError)) return undefined
  const id = (error.data as { requestId?: unknown } | undefined)?.requestId
  return typeof id === 'string' ? id : undefined
}

/**
 * The JSON body of a 200. A body that cannot be read or parsed (a reset mid-body, a cut) is retryable;
 * the caller decides what a parsed-but-invalid body means.
 */
export async function readJson(res: Response, wire: string): Promise<unknown> {
  let text: string
  try {
    text = await res.text()
  } catch (error) {
    throw new Attempt(`${wire} body could not be read: ${describe(error)}`, true)
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new Attempt(`${wire} body is not JSON (cut or garbled)`, true)
  }
}

/** Run `attempt` until it succeeds, fails fast, or the attempts are used up; 0.5 s, 1.5 s, 4.5 s apart. */
export async function withRetries<T>(options: HttpOptions, signal: AbortSignal, attempt: () => Promise<T>): Promise<T> {
  const attempts = options.attempts ?? DEFAULTS.attempts
  const backoffMs = options.backoffMs ?? DEFAULTS.backoffMs
  for (let i = 0; ; i++) {
    if (signal.aborted) throw fail('CANCELLED', 'cancelled')
    try {
      return await attempt()
    } catch (error) {
      if (signal.aborted) throw fail('CANCELLED', 'cancelled')
      if (error instanceof CapabilityError) throw error
      const failure = error instanceof Attempt ? error : new Attempt(describe(error), !isAbort(error))
      if (!failure.retryable || i >= attempts - 1) {
        throw fail('UPSTREAM_ERROR', failure.message, {
          ...(failure.status === undefined ? {} : { status: failure.status }),
          ...(failure.requestId === undefined ? {} : { requestId: failure.requestId }),
          ...(failure.userError ? { userError: failure.userError } : {}),
          ...(failure.transport ? { transport: true as const } : {}),
          ...(failure.retryable ? { exhausted: true as const } : {}),
        })
      }
      await sleep(backoffMs * 3 ** i, signal)
    }
  }
}

/** The hang guard or the idle watchdog fired: the wait is already spent, so it is not retried. */
export const isAbort = (error: unknown) =>
  error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')

export const describe = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Resolves after `ms`, or early when the signal aborts (the loop then reports CANCELLED). */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
  })
}

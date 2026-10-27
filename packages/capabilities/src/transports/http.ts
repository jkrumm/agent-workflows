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
  ) {
    super(message)
  }
}

/** A non-2xx response. 410 (dead model) and client errors fail fast; IU relays some upstream 400s as 503. */
export async function failedResponse(res: Response, wire: string): Promise<Attempt> {
  const detail = (await res.text().catch(() => '')).slice(0, 300)
  const retryable = RETRYABLE_STATUS.has(res.status) && !detail.includes('invalid_request_error')
  const prefix = res.status === 410 ? 'model deprecated (410)' : `${wire} request failed (${res.status})`
  return new Attempt(`${prefix}: ${detail}`, retryable, res.status)
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
        throw fail('UPSTREAM_ERROR', failure.message, failure.status === undefined ? {} : { status: failure.status })
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

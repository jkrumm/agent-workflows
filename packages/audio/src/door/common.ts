import { errorMessage } from '../http.ts'
import type { AudioDeps, AudioScope } from '../scope.ts'

/** `x-audio-source` wins; then the process's own mapping (e.g. a bearer token); then `unknown`. */
export const callerOf = (deps: AudioDeps, req: Request): string =>
  req.headers.get('x-audio-source') ?? deps.caller?.(req) ?? 'unknown'

export const requestIdOf = (deps: AudioDeps, req: Request): string => deps.requestId?.(req) ?? crypto.randomUUID()

/** OpenAI's error envelope, `invalid_request_error`, 400 unless said otherwise. */
export const invalid = (message: string, status = 400): Response =>
  Response.json({ error: { message, type: 'invalid_request_error' } }, { status })

/** What audio-gateway's top-level catch answered: 500 `proxy_error` with the message. */
export function internalError(scope: AudioScope, error: unknown): Response {
  const message = errorMessage(error)
  scope.log.error('audio request failed', { requestId: scope.requestId, caller: scope.caller, error: message })
  return Response.json({ error: { message, type: 'proxy_error' } }, { status: 500 })
}

/** The speech body is JSON of at most a few thousand characters; the host's global limit is sized for the STT upload. */
export const SPEECH_BODY_MAX_BYTES = 1024 * 1024

/**
 * The request body as text, or `null` when it exceeds `maxBytes`: judged by the declared `content-length` before any
 * byte is read, and by the bytes actually read for a chunked body (the stream is cancelled at the first byte over).
 */
export async function readBoundedText(req: Request, maxBytes: number): Promise<string | null> {
  const declared = Number(req.headers.get('content-length'))
  if (req.headers.has('content-length') && Number.isFinite(declared) && declared > maxBytes) return null
  if (!req.body) return ''
  const reader = req.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let bytes = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return text + decoder.decode()
    bytes += value.byteLength
    if (bytes > maxBytes) {
      reader.cancel().catch(() => {})
      return null
    }
    text += decoder.decode(value, { stream: true })
  }
}

/** Bounds how many holders run at once; the rest queue in arrival order. */
export interface Semaphore {
  /** Resolves with the release once a slot is free; `null` when `signal` aborted while queued (no slot is held). */
  acquire(signal: AbortSignal): Promise<(() => void) | null>
}

export function createSemaphore(limit: number): Semaphore {
  let active = 0
  const queue: Array<() => void> = []
  const release = () => {
    const next = queue.shift()
    if (next) next()
    else active--
  }
  return {
    acquire(signal) {
      if (signal.aborted) return Promise.resolve(null)
      if (active < limit) {
        active++
        return Promise.resolve(releaseOnce(release))
      }
      return new Promise((resolve) => {
        const grant = () => {
          signal.removeEventListener('abort', leave)
          resolve(releaseOnce(release))
        }
        const leave = () => {
          const at = queue.indexOf(grant)
          if (at >= 0) queue.splice(at, 1)
          resolve(null)
        }
        queue.push(grant)
        signal.addEventListener('abort', leave, { once: true })
      })
    },
  }
}

const releaseOnce = (release: () => void): (() => void) => {
  let done = false
  return () => {
    if (done) return
    done = true
    release()
  }
}

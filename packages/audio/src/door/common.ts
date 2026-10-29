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

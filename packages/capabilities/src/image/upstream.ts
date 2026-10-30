import { Attempt, failedResponse, type UserError } from '../transports/http.ts'

/**
 * True for either shape the vendor proxy uses to wrap a 400-class validation error inside a 503 (image-gateway's
 * `isWrappedUserErrorBody`, probe-verified): the historical `user_error` substring (`image_generation_user_error`,
 * `moderation_blocked`), and the gpt-image-2.5-era body prefixed `[OpenAI Vendor Group Key StatusCode: BadRequest]` whose
 * embedded JSON carries `"type":"invalid_request_error"` with no `user_error` at all. A retry fails the same way.
 */
export function isWrappedUserErrorBody(text: string): boolean {
  if (text.includes('user_error')) return true
  return text.includes('StatusCode: BadRequest') && text.includes('"invalid_request_error"')
}

/** What a wrapped 400's embedded JSON says: its message, its code and the moderation stage and categories when it is a block; null when it has no parseable error object. */
export function parseWrappedUserError(text: string): UserError | null {
  const start = text.indexOf('{')
  if (start === -1) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start))
  } catch {
    return null
  }
  const error = (parsed as { error?: Record<string, unknown> } | null)?.error
  if (!error || typeof error !== 'object') return null
  const details = error.moderation_details as { moderation_stage?: unknown; categories?: unknown } | undefined
  return {
    message: typeof error.message === 'string' ? error.message : `request rejected: ${text.slice(0, 300)}`,
    ...(typeof error.code === 'string' ? { code: error.code } : {}),
    ...(typeof details?.moderation_stage === 'string' && Array.isArray(details.categories)
      ? {
          moderation: {
            stage: details.moderation_stage,
            categories: details.categories.filter((c): c is string => typeof c === 'string'),
          },
        }
      : {}),
  }
}

/** What a wrapped 400's embedded JSON says, as one line: its message, its code, and the moderation stage and categories when it is a block. */
export function describeWrappedUserError(text: string): string {
  const parsed = parseWrappedUserError(text)
  if (!parsed) return `request rejected: ${text.slice(0, 300)}`
  const code = parsed.code ? ` [${parsed.code}]` : ''
  const stage = parsed.moderation ? ` (moderation stage ${parsed.moderation.stage}` : ''
  const categories = parsed.moderation
    ? `${stage ? ', ' : ' ('}categories ${parsed.moderation.categories.join(', ')}`
    : ''
  const detail = stage || categories ? `${stage}${categories})` : ''
  return `${parsed.message}${code}${detail}`
}

/**
 * A non-2xx image or Replicate response as a failed attempt: the transport's classification (410 and client errors fail
 * fast, a provider balance failure too, 429/5xx retry), except that a vendor-wrapped 400 (a 503 that is really a
 * validation or moderation error) is never retried and carries the vendor's own message.
 */
export async function failedImageResponse(res: Response, wire: string): Promise<Attempt> {
  const text = await res.text().catch(() => '')
  if (res.status !== 410 && isWrappedUserErrorBody(text)) {
    return new Attempt(
      `${wire} ${describeWrappedUserError(text)}`,
      false,
      res.status,
      parseWrappedUserError(text) ?? undefined,
    )
  }
  return failedResponse(new Response(text, { status: res.status }), wire)
}

import { z } from 'zod'

/**
 * The typed errors every capability can raise. Codes are the contract the CLI generator maps to exit
 * codes; each is declared on the oRPC procedure so it lands in the OpenAPI document.
 */
export const ERRORS = {
  /** IU credentials or the route table/override are unusable. Nothing was sent. */
  NOT_CONFIGURED: { status: 503, message: 'Capability is not configured' },
  /** The provider could not be reached or answered with an error status, after retries. */
  UPSTREAM_ERROR: {
    status: 502,
    message: 'Upstream model call failed',
    data: z.object({
      status: z.number().int().optional(),
      /** The call never got an answer (a refused connection, a reset, a body that could not be read): the message is the client library's text, not the vendor's. */
      transport: z.literal(true).optional(),
      /** The failure was retryable and every attempt of the retry policy was used (a 429, 500, 502, 503 or 504, a dead connection): what a route's outage fallback reads. Absent on a fail-fast answer. */
      exhausted: z.literal(true).optional(),
      /** The primary was refused for provider balance and the fallback failed too (`FallbackFailedError`); the cause is the fallback's error. */
      reason: z.literal('fallback_failed').optional(),
      /** A vendor-wrapped 400 or an error frame of a stream: the vendor's own words, structured (a moderation block names its stage and categories). */
      userError: z
        .object({
          message: z.string(),
          code: z.string().optional(),
          moderation: z.object({ stage: z.string().optional(), categories: z.array(z.string()).optional() }).optional(),
        })
        .optional(),
    }),
  },
  /** The call worked but the answer was unusable after one re-ask (schema or parse failure). */
  INVALID_OUTPUT: {
    status: 502,
    message: 'Model output rejected',
    data: z.object({ attempts: z.number().int(), reason: z.string() }),
  },
  /** `max_tokens` ended the answer: `starved` when reasoning ate all of it and no text came back. */
  OUTPUT_TRUNCATED: {
    status: 502,
    message: 'Model output truncated',
    data: z.object({ reason: z.enum(['starved', 'truncated']) }),
  },
  /** A URL the capability will not fetch (a scheme other than http(s), credentials, an internal or non-public host). Nothing was sent. */
  URL_REFUSED: { status: 422, message: 'URL refused' },
  /** An input the capability cannot use and the schema cannot express: a file that is missing, too large or not an image. Nothing was sent. */
  INVALID_INPUT: { status: 422, message: 'Input rejected' },
  /** The thing asked for does not exist (a package a registry has never heard of, a crate with no stable version). The call worked; the answer is "no". */
  NOT_FOUND: { status: 404, message: 'Not found' },
  /** The caller's signal aborted the call. */
  CANCELLED: { status: 499, message: 'Cancelled' },
} as const

export type ErrorCode = keyof typeof ERRORS

type ErrorData<C extends ErrorCode> = (typeof ERRORS)[C] extends { data: infer D extends z.ZodType }
  ? z.input<D>
  : undefined

/**
 * What handlers and adapters throw. A plain class, so handlers never import the HTTP framework; the
 * procedure layer converts it to oRPC's typed error, and `Registry.call` converts back.
 */
export class CapabilityError<C extends string = string> extends Error {
  constructor(
    readonly code: C,
    message: string,
    readonly data?: unknown,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'CapabilityError'
  }
}

const CAUSE_MAX_CHARS = 300

const SECRETS: [RegExp, string][] = [
  [/\bBearer\s+[\w.~+/=-]+/gi, 'Bearer [redacted]'],
  [/\bBasic\s+[A-Za-z0-9+/]{8,}={0,2}/gi, 'Basic [redacted]'],
  [/\bsk-[\w-]{6,}/g, 'sk-[redacted]'],
  // `api_key=`, `token=` in a URL and env-style `IU_API_KEY=`, `ARGO_API_SECRET=`, `GITHUB_TOKEN=`.
  [/\b([\w-]*(?:key|token|secret|password)[\w-]*)=[^\s&"',;]+/gi, '$1=[redacted]'],
  // An Authorization header is redacted whole, whatever its scheme (`Token`, `Digest`, a bare value): the value after
  // the colon up to a quote or separator. The Bearer and Basic rules above already left `Bearer [redacted]`.
  [/\b((?:proxy-)?authorization):(?!\s*(?:Bearer|Basic) \[redacted\])\s*[^\n"',;]+/gi, '$1: [redacted]'],
  // `password: x`, `x-api-key: "x"` (a log line or a dumped header).
  [
    /\b([\w-]*(?:key|token|secret|password)[\w-]*)\s*:(?!\s*["']?\[redacted\])\s*["']?[^\s&"',;]+["']?/gi,
    '$1: [redacted]',
  ],
  // JSON: `"token": "…"`, `"api_key":"…"`, `"authorization": "…"`.
  [/("[\w-]*(?:key|token|secret|password|authorization)[\w-]*"\s*:\s*)"(?:[^"\\]|\\.)*"/gi, '$1"[redacted]"'],
]

/** Secret-shaped substrings of `text` redacted: bearer and basic credentials, `sk-` keys, `key=value` and `key: value` pairs and JSON credential fields. The one table every outbound error text and span passes. */
export function redactSecrets(text: string): string {
  let out = text
  for (const [pattern, replacement] of SECRETS) out = out.replace(pattern, replacement)
  return out
}

/**
 * What an untyped throw says about itself, short enough for a journal row and safe to hand a caller: `Name: message`,
 * with URL query strings and credential-looking values removed and the whole cut to `CAUSE_MAX_CHARS`. The stack
 * stays in the log line, never in the answer.
 */
export function causeOf(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error
  const message = error instanceof Error ? error.message : String(error)
  // The error's own name stays readable (`JsonWebTokenError: jwt expired`): only the message is scrubbed.
  const scrubbed = redactSecrets(message.replace(/(https?:\/\/[^\s?#"'<>)]+)[?#][^\s"'<>)]*/gi, '$1'))
  const text = `${name}: ${scrubbed}`.replace(/\s+/g, ' ').trim()
  return text.length > CAUSE_MAX_CHARS ? `${text.slice(0, CAUSE_MAX_CHARS)}…` : text
}

export function fail<C extends ErrorCode>(
  code: C,
  message: string,
  ...data: ErrorData<C> extends undefined ? [] : [ErrorData<C>]
): CapabilityError<C> {
  return new CapabilityError(code, message, data[0])
}

/** What `call` throws and the HTTP body carries: `{ defined, code, status, message, data }`. */
export class CapabilityCallError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly defined: boolean,
    readonly data?: unknown,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'CapabilityCallError'
  }

  toJSON() {
    return { defined: this.defined, code: this.code, status: this.status, message: this.message, data: this.data }
  }
}

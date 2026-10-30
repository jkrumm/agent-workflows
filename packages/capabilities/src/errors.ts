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
      /** A vendor-wrapped 400 or an error frame of a stream: the vendor's own words, structured (a moderation block names its stage and categories). */
      userError: z
        .object({
          message: z.string(),
          code: z.string().optional(),
          moderation: z.object({ stage: z.string(), categories: z.array(z.string()) }).optional(),
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

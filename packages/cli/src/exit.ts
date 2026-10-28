/**
 * The exit-code table (ADR-004 item 3, spike 7). It is the contract every caller branches on:
 * changing a code is a breaking change.
 */
export const EXIT = {
  ok: 0,
  general: 1,
  usage: 2,
  auth: 3,
  not_found: 4,
  conflict: 5,
  confirmation_required: 6,
  network: 7,
  rate_limited: 8,
  contract_mismatch: 9,
  pending: 10,
} as const

export type ExitKind = keyof typeof EXIT
export type ErrorKind = Exclude<ExitKind, 'ok'>

export const EXIT_MEANING: Record<ExitKind, string> = {
  ok: 'success',
  general: 'other failure: a 5xx, or a run that ended failed or cancelled (its state is on stdout)',
  usage: 'unknown command or flag, bad value, or a 400/422',
  auth: 'no secret found, or a 401/403',
  not_found: '404',
  conflict: '409',
  confirmation_required: 'mutating command without --commit while stdin is not a TTY; nothing was sent',
  network: 'the host could not be reached',
  rate_limited: '429; retry after details.retryAfterS',
  contract_mismatch: 'the host serves another contract and the command does not parse against it',
  pending: 'the run is still going when the wait budget ran out; stdout has its state, hint the resume command',
}

export interface ErrorFields {
  code?: string | null
  hint?: string
  details?: Record<string, unknown>
  /** A usage error a stale cached contract would explain: the runner refreshes once and parses again. */
  stale?: boolean
}

/** Every failure leaves through this: one JSON line on stderr and the kind's exit code. */
export class AgwError extends Error {
  readonly code: string | null
  readonly hint: string
  readonly details: Record<string, unknown>
  readonly stale: boolean

  constructor(
    readonly kind: ErrorKind,
    message: string,
    fields: ErrorFields = {},
  ) {
    super(message)
    this.name = 'AgwError'
    this.code = fields.code ?? null
    this.hint = fields.hint ?? ''
    this.details = fields.details ?? {}
    this.stale = fields.stale ?? false
  }

  get exitCode(): number {
    return EXIT[this.kind]
  }

  // Not `line()`: that name collides with JavaScriptCore's `Error.line` under Bun (spike 7).
  toErrorLine(): string {
    const { kind, code, message, hint, details } = this
    return JSON.stringify({ error: { kind, code, message, hint, details } })
  }
}

export const usage = (message: string, hint = '', stale = false) => new AgwError('usage', message, { hint, stale })

/** HTTP status → error kind (spike 7's table; the server's `code` decides 412 as well). */
export function kindForStatus(status: number, code: string | null): ErrorKind {
  if (status === 412 || code === 'CONTRACT_MISMATCH') return 'contract_mismatch'
  if (status === 401 || status === 403) return 'auth'
  if (status === 404) return 'not_found'
  if (status === 409) return 'conflict'
  if (status === 429) return 'rate_limited'
  if (status === 400 || status === 422) return 'usage'
  return 'general'
}

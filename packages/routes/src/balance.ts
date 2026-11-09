/**
 * What the transports write into an error message once a failure is classified as provider balance: the text form
 * every later reader (a step's failure reason, the review degrade) recognises without the status.
 */
export const BALANCE_MARKER = 'provider balance exhausted'

/** A 503 body that names the balance: IU's `… Insufficient Balance (PaymentRequired) on <provider>`, or either word. */
const BALANCE_WORDING = /insufficient balance|paymentrequired/i
/** Without a status only IU's own body shape counts: both words together, never a lone "payment required". */
const IU_BODY = /insufficient balance\s*\(paymentrequired\)/i
/** A text-only 402 (OpenCode's turn error): the status token and the wording, together. */
const STATUS_402 = /\b402\b/
const PAYMENT_WORDING = /payment required|insufficient balance/i
/** Anthropic's refusal of a drained Console org: a 400 `invalid_request_error` whose message is "Your credit balance is too low to access the Anthropic API. …". */
const CREDIT_BALANCE_LOW = /credit balance is too low to access the Anthropic API/i

/**
 * OpenAI's exhausted-account answer: HTTP 429 whose error has `type`/`code` `insufficient_quota` ("You exceeded your
 * current quota, please check your plan and billing details."). Wording from OpenAI's documented error, not probed on the
 * IU relay (an account cannot be drained on purpose). An ordinary 429 (`rate_limit_exceeded`, "Too many requests") has
 * neither token.
 */
const INSUFFICIENT_QUOTA = /\binsufficient_quota\b/i
/** Without a status the token counts only as the error's own `type`/`code` field (JSON or `type: insufficient_quota`)... */
const QUOTA_FIELD = /["']?\b(?:type|code)\b["']?\s*[:=]\s*["']?insufficient_quota\b/i
/** ...or next to OpenAI's sentence about the quota / billing. */
const QUOTA_WORDING = /exceeded your current quota|check your plan and billing/i

/**
 * The one provider-balance classifier. With a status: 402, 503 whose body says "Insufficient Balance" /
 * "PaymentRequired" (or carries `BALANCE_MARKER`), or 400 whose body says "credit balance is too low to access the Anthropic API"
 * (Anthropic's drained-org refusal, anchored on its full sentence start so free text that merely mentions a low balance
 * does not trigger a fallback) or carries `BALANCE_MARKER` (the transports' own message, re-classified with its status; any
 * other 400 is not balance), or 429 whose body carries the token `insufficient_quota` (OpenAI's exhausted account; a
 * plain rate-limit 429 stays not balance) or `BALANCE_MARKER`; any other status is not balance. Without one (an OpenCode turn
 * error, a step's failure reason, a CLI's stderr) the transports' `BALANCE_MARKER`, IU's body shape
 * ("Insufficient Balance (PaymentRequired)"), Anthropic's full "credit balance is too low to access the Anthropic API" sentence, or a 402 token together with
 * "payment required" / "insufficient balance" count, as does `insufficient_quota` as an error's `type`/`code` field or
 * together with OpenAI's "exceeded your current quota" / "check your plan and billing"; a 402, the wording, or a bare
 * `insufficient_quota` mention alone does not. The 429 rule is OpenAI's documented error, not probed on the IU relay.
 */
export function isBalanceFailure(failure: { status?: number; text: string }): boolean {
  if (failure.status === 402) return true
  if (failure.status === 503) return BALANCE_WORDING.test(failure.text) || failure.text.includes(BALANCE_MARKER)
  if (failure.status === 400) return CREDIT_BALANCE_LOW.test(failure.text) || failure.text.includes(BALANCE_MARKER)
  if (failure.status === 429) return INSUFFICIENT_QUOTA.test(failure.text) || failure.text.includes(BALANCE_MARKER)
  if (failure.status !== undefined) return false
  const { text } = failure
  return (
    QUOTA_FIELD.test(text) ||
    (INSUFFICIENT_QUOTA.test(text) && QUOTA_WORDING.test(text)) ||
    text.includes(BALANCE_MARKER) ||
    IU_BODY.test(text) ||
    CREDIT_BALANCE_LOW.test(text) ||
    (STATUS_402.test(text) && PAYMENT_WORDING.test(text))
  )
}

/** The `reason` a failed fallback carries: the call ran on the fallback after a balance refusal, and the fallback failed too. */
export const FALLBACK_FAILED = 'fallback_failed'

/** The classifier's wording, replaced in a fallback's failure text so the wrapper never reads as balance itself. */
const BALANCE_WORDS = new RegExp(
  [
    BALANCE_MARKER,
    'insufficient balance',
    'paymentrequired',
    'payment required',
    'credit balance is too low to access the Anthropic API',
    'insufficient_quota',
    'exceeded your current quota',
    'check your plan and billing',
  ].join('|'),
  'gi',
)

/**
 * The primary was refused for balance, the call moved to the fallback, and the fallback failed too (billed, for its own
 * reason). `cause` is the FALLBACK's error. The message names both models and the fallback's failure, with the balance
 * wording redacted: `isBalanceFailure({ text: message })` is false, so nothing downstream re-reads it as the primary's
 * balance refusal (and nothing falls back a second time).
 */
export class FallbackFailedError extends Error {
  readonly reason = FALLBACK_FAILED
  readonly route: string
  readonly primaryModel: string
  readonly fallbackModel: string
  /** The gateway request id of the primary's refusal, when it had one. */
  readonly primaryRequestId?: string

  constructor(args: {
    route: string
    primaryModel: string
    fallbackModel: string
    primaryRequestId?: string
    cause: unknown
  }) {
    const detail = (args.cause instanceof Error ? args.cause.message : String(args.cause))
      .slice(0, 300)
      .replace(BALANCE_WORDS, '[redacted]')
    super(
      `${args.route}: the fallback ${args.fallbackModel} failed after ${args.primaryModel} was refused: ${detail}`,
      { cause: args.cause },
    )
    this.name = 'FallbackFailedError'
    this.route = args.route
    this.primaryModel = args.primaryModel
    this.fallbackModel = args.fallbackModel
    if (args.primaryRequestId !== undefined) this.primaryRequestId = args.primaryRequestId
  }
}

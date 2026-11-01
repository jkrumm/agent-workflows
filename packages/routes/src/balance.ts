/**
 * What the transports write into an error message once a failure is classified as provider balance: the text form
 * every later reader (a step's failure reason, the review degrade) recognises without the status.
 */
export const BALANCE_MARKER = 'provider balance exhausted'

/** A 503 body that names the balance: IU's `… Insufficient Balance (PaymentRequired) on <provider>`, or either word. */
const BALANCE_WORDING = /insufficient balance|paymentrequired/i
/** Without a status only IU's own body shape counts: both words together, never a lone "payment required". */
const IU_BODY = /insufficient balance\s*\(paymentrequired\)/i
/** A text-only 402 (OpenCode's turn error, `ocr`'s stderr): the status token and the wording, together. */
const STATUS_402 = /\b402\b/
const PAYMENT_WORDING = /payment required|insufficient balance/i
/** Anthropic's refusal of a drained Console org: a 400 `invalid_request_error` whose message is "Your credit balance is too low …". */
const CREDIT_BALANCE_LOW = /credit balance is too low/i

/**
 * The one provider-balance classifier. With a status: 402, 503 whose body says "Insufficient Balance" /
 * "PaymentRequired" (or carries `BALANCE_MARKER`), or 400 whose body says "credit balance is too low" (Anthropic's
 * drained-org refusal; any other 400 is not balance); any other status is not balance. Without one (an OpenCode turn
 * error, a step's failure reason, a CLI's stderr) the transports' `BALANCE_MARKER`, IU's body shape
 * ("Insufficient Balance (PaymentRequired)"), Anthropic's "credit balance is too low", or a 402 token together with
 * "payment required" / "insufficient balance" count; a 402 or the wording alone does not.
 */
export function isBalanceFailure(failure: { status?: number; text: string }): boolean {
  if (failure.status === 402) return true
  if (failure.status === 503) return BALANCE_WORDING.test(failure.text) || failure.text.includes(BALANCE_MARKER)
  if (failure.status === 400) return CREDIT_BALANCE_LOW.test(failure.text)
  if (failure.status !== undefined) return false
  const { text } = failure
  return (
    text.includes(BALANCE_MARKER) ||
    IU_BODY.test(text) ||
    CREDIT_BALANCE_LOW.test(text) ||
    (STATUS_402.test(text) && PAYMENT_WORDING.test(text))
  )
}

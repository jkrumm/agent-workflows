/**
 * What the transports write into an error message once a failure is classified as provider balance: the text form
 * every later reader (a step's failure reason, the review degrade) recognises without the status.
 */
export const BALANCE_MARKER = 'provider balance exhausted'

/** IU's 503 for an empty provider account: `… Insufficient Balance (PaymentRequired) on <provider>`. */
const BALANCE_TEXT = /insufficient balance|paymentrequired|payment required/i
/** A 402 named in a message that carries no status of its own (an OpenCode turn error, a step's failure reason). */
const STATUS_402 = /(?:\(|\bHTTP |\bstatus:? )402\b/i

/**
 * The one provider-balance classifier: HTTP 402, or a 503 whose body says "Insufficient Balance" / "PaymentRequired".
 * Without a status (an error string from OpenCode, a step's failure reason) the text decides: the balance wording,
 * the transports' `BALANCE_MARKER`, or a 402 status written into the message. Any other failure is not balance.
 */
export function isBalanceFailure(failure: { status?: number; text: string }): boolean {
  if (failure.status === 402) return true
  if (failure.status === 503) return BALANCE_TEXT.test(failure.text)
  if (failure.status !== undefined) return false
  return BALANCE_TEXT.test(failure.text) || failure.text.includes(BALANCE_MARKER) || STATUS_402.test(failure.text)
}

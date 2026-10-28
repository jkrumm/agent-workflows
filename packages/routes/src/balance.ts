/**
 * What the transports write into an error message once a failure is classified as provider balance: the text form
 * every later reader (a step's failure reason, the review degrade) recognises without the status.
 */
export const BALANCE_MARKER = 'provider balance exhausted'

/** A 503 body that names the balance: IU's `… Insufficient Balance (PaymentRequired) on <provider>`, or either word. */
const BALANCE_WORDING = /insufficient balance|paymentrequired/i
/** Without a status only IU's own body shape counts: both words together, never a lone "payment required". */
const IU_BODY = /insufficient balance\s*\(paymentrequired\)/i

/**
 * The one provider-balance classifier. With a status: 402, or 503 whose body says "Insufficient Balance" /
 * "PaymentRequired" (or carries `BALANCE_MARKER`); any other status is not balance. Without one (an OpenCode turn
 * error, a step's failure reason, a CLI's stderr) only the transports' `BALANCE_MARKER` or IU's body shape
 * ("Insufficient Balance (PaymentRequired)") count: free text that merely mentions a 402 or "payment required" (a diff,
 * an echoed prompt) is not balance.
 */
export function isBalanceFailure(failure: { status?: number; text: string }): boolean {
  if (failure.status === 402) return true
  if (failure.status === 503) return BALANCE_WORDING.test(failure.text) || failure.text.includes(BALANCE_MARKER)
  if (failure.status !== undefined) return false
  return failure.text.includes(BALANCE_MARKER) || IU_BODY.test(failure.text)
}

import { isRecord } from './json.ts'

/**
 * A credit org's monthly spend limit, as Anthropic documents the refusal (platform.claude.com/docs/en/api/rate-limits,
 * §Spend limits; not probed live, an org cannot be capped on purpose):
 *
 * - a limit the owner set: HTTP 400, `invalid_request_error`, message "You have reached your specified API usage
 *   limits" (or "... specified workspace API usage limits") and when access resumes;
 * - the tier's own cap: HTTP 429, `rate_limit_error`, `error.details.error_code` `enforced_spend_limit_reached`.
 *
 * The 429 is told from an ordinary rate limit by the error code, never by the status. Kept here and not in
 * `isBalanceFailure`: the agw routes fall back onto GPT on that, and a spend limit is the gateway's to route around.
 */
const OWNER_LIMIT = /^You have reached your specified (?:workspace )?API usage limits/i
const TIER_CAP_CODE = 'enforced_spend_limit_reached'

function errorOf(text: string): Record<string, unknown> | null {
  try {
    const body: unknown = JSON.parse(text)
    return isRecord(body) && isRecord(body.error) ? body.error : null
  } catch {
    return null
  }
}

export function isSpendLimitFailure(failure: { status: number; text: string }): boolean {
  if (failure.status !== 400 && failure.status !== 429) return false
  const error = errorOf(failure.text)
  if (error === null) return false
  if (failure.status === 400) return typeof error.message === 'string' && OWNER_LIMIT.test(error.message.trimStart())
  return isRecord(error.details) && error.details.error_code === TIER_CAP_CODE
}

/** 00:00 UTC on the first of the month after `at`: when the organization's monthly spend limit resets. */
export const nextMonthStart = (at: Date): Date => new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1))

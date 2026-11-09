import { describe, expect, test } from 'bun:test'
import { BALANCE_MARKER, FALLBACK_FAILED, FallbackFailedError, isBalanceFailure } from './balance.ts'

// IU's body on an empty provider account, as it arrived 2026-10-28.
const IU_503 = 'IU request failed (503) — Insufficient Balance (PaymentRequired) on Requesty-Global'

// Anthropic's body on a drained Console org with no payment method: HTTP 400, not 402.
const ANTHROPIC_MESSAGE =
  'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.'
const ANTHROPIC_400 = JSON.stringify({
  type: 'error',
  error: { type: 'invalid_request_error', message: ANTHROPIC_MESSAGE },
})

describe('isBalanceFailure', () => {
  test('402 is balance, whatever the body', () => {
    expect(isBalanceFailure({ status: 402, text: '' })).toBe(true)
    expect(isBalanceFailure({ status: 402, text: '{"error":"payment required"}' })).toBe(true)
  })

  test('503 is balance only when the body says so', () => {
    expect(isBalanceFailure({ status: 503, text: IU_503 })).toBe(true)
    expect(isBalanceFailure({ status: 503, text: '{"error":{"code":"PaymentRequired"}}' })).toBe(true)
    expect(isBalanceFailure({ status: 503, text: 'Service Unavailable' })).toBe(false)
    expect(isBalanceFailure({ status: 503, text: '' })).toBe(false)
  })

  test('other statuses are never balance, even with the wording', () => {
    for (const status of [400, 500, 502, 504]) expect(isBalanceFailure({ status, text: IU_503 })).toBe(false)
  })

  test('a 400 is balance only when it says the credit balance is too low', () => {
    expect(isBalanceFailure({ status: 400, text: ANTHROPIC_400 })).toBe(true)
    expect(isBalanceFailure({ status: 400, text: ANTHROPIC_MESSAGE.toUpperCase() })).toBe(true)
    const other = JSON.stringify({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'max_tokens: must be greater than 0' },
    })
    expect(isBalanceFailure({ status: 400, text: other })).toBe(false)
    expect(isBalanceFailure({ status: 400, text: '' })).toBe(false)
    // Free text that merely mentions a low balance is not Anthropic's sentence.
    expect(isBalanceFailure({ status: 400, text: 'the credit balance is too low, top it up' })).toBe(false)
  })

  test('a 400 carrying the marker is balance: the transport message re-classified with its status', () => {
    expect(isBalanceFailure({ status: 400, text: `iu-openai ${BALANCE_MARKER} (400): {"type":"error"}` })).toBe(true)
    // Round trip: failedResponse truncates the body to 300 chars, so the phrase may be cut; the marker survives.
    const body = `${' '.repeat(300)}${ANTHROPIC_MESSAGE}`
    expect(isBalanceFailure({ status: 400, text: body })).toBe(true)
    const message = `anthropic ${BALANCE_MARKER} (400): ${body.slice(0, 300)}`
    expect(message).not.toMatch(/credit balance is too low/i)
    expect(isBalanceFailure({ status: 400, text: message })).toBe(true)
  })

  test('the Anthropic phrase counts only on a 400 or without a status', () => {
    expect(isBalanceFailure({ text: ANTHROPIC_MESSAGE })).toBe(true)
    expect(isBalanceFailure({ text: `opencode session ses_x failed: ${ANTHROPIC_400}` })).toBe(true)
    for (const status of [200, 429, 500]) expect(isBalanceFailure({ status, text: ANTHROPIC_400 })).toBe(false)
    expect(isBalanceFailure({ text: 'the credit balance is too low, top it up' })).toBe(false)
    expect(isBalanceFailure({ text: 'credit balance is too low' })).toBe(false)
  })

  test('without a status: the marker, IU’s body shape, or a 402 token with the wording', () => {
    expect(isBalanceFailure({ text: IU_503 })).toBe(true)
    expect(isBalanceFailure({ text: `opencode session ses_x failed: ${IU_503}` })).toBe(true)
    expect(isBalanceFailure({ text: `iu-openai ${BALANCE_MARKER} (503): x` })).toBe(true)
    // A text-only 402 from OpenCode.
    expect(isBalanceFailure({ text: 'APICallError: HTTP 402 Payment Required' })).toBe(true)
    expect(isBalanceFailure({ text: 'llm error: status 402: insufficient balance' })).toBe(true)
    for (const text of [
      'HTTP 402 from provider',
      'iu-openai request failed (402): ',
      'Payment Required',
      'Insufficient Balance',
      '{"code":"PaymentRequired"}',
      'iu-openai request failed (503): busy',
      'src/app.ts:402 has a bug',
      'error 4020: payment required',
    ]) {
      expect(isBalanceFailure({ text })).toBe(false)
    }
  })

  test('a quoted 402 with the wording counts: the classifier is never fed diff text', () => {
    // The status-less callers are step failure reasons. Failure reasons carry no diff text:
    // an agent step's schema failure is zod's message (no values), the synthesis output is a plain string, the
    // adversary's errors name no answer text, and an OpenCode turn error is the provider's. A diff that quotes the
    // refusal would read as one, so it must never be classified.
    expect(isBalanceFailure({ text: '+  throw new Error("HTTP 402 Payment Required")' })).toBe(true)
  })
})

// OpenAI's documented body for an exhausted account (HTTP 429); wording from the docs, not probed on the IU relay.
const OPENAI_QUOTA = JSON.stringify({
  error: {
    message: 'You exceeded your current quota, please check your plan and billing details.',
    type: 'insufficient_quota',
    code: 'insufficient_quota',
  },
})
const OPENAI_RATE_LIMIT = JSON.stringify({
  error: {
    message: 'Rate limit reached for gpt in organization org-x. Too many requests.',
    type: 'requests',
    code: 'rate_limit_exceeded',
  },
})

describe('isBalanceFailure: OpenAI insufficient_quota', () => {
  test('a 429 carrying insufficient_quota is balance; an ordinary rate-limit 429 is not', () => {
    expect(isBalanceFailure({ status: 429, text: OPENAI_QUOTA })).toBe(true)
    expect(isBalanceFailure({ status: 429, text: `iu-openai ${BALANCE_MARKER} (429): {"error":` })).toBe(true)
    expect(isBalanceFailure({ status: 429, text: OPENAI_RATE_LIMIT })).toBe(false)
    expect(isBalanceFailure({ status: 429, text: 'Too many requests' })).toBe(false)
    expect(isBalanceFailure({ status: 429, text: '' })).toBe(false)
  })

  test('insufficient_quota on any other status is not balance', () => {
    for (const status of [400, 403, 500, 502]) expect(isBalanceFailure({ status, text: OPENAI_QUOTA })).toBe(false)
  })

  test('without a status: the error field, or the token with the quota wording; a bare mention is not', () => {
    expect(isBalanceFailure({ text: OPENAI_QUOTA })).toBe(true)
    expect(isBalanceFailure({ text: 'APIError: type: insufficient_quota' })).toBe(true)
    expect(isBalanceFailure({ text: 'insufficient_quota: You exceeded your current quota' })).toBe(true)
    expect(isBalanceFailure({ text: 'error code insufficient_quota' })).toBe(false)
    expect(isBalanceFailure({ text: 'You exceeded your current quota' })).toBe(false)
    expect(isBalanceFailure({ text: OPENAI_RATE_LIMIT })).toBe(false)
    expect(isBalanceFailure({ text: 'the doc mentions insufficient_quota_handler()' })).toBe(false)
  })
})

describe('FallbackFailedError', () => {
  const make = (message: string) =>
    new FallbackFailedError({
      route: 'cheap.classify',
      primaryModel: 'claude-x',
      fallbackModel: 'gpt-y',
      primaryRequestId: 'req-1',
      cause: new Error(message),
    })

  test('names both models and the fallback failure; carries reason, cause and the primary request id', () => {
    const error = make('iu-openai request failed (500): boom')
    expect(error.reason).toBe(FALLBACK_FAILED)
    expect(error.message).toContain('claude-x')
    expect(error.message).toContain('gpt-y')
    expect(error.message).toContain('boom')
    expect((error.cause as Error).message).toBe('iu-openai request failed (500): boom')
    expect(error).toMatchObject({
      route: 'cheap.classify',
      primaryModel: 'claude-x',
      fallbackModel: 'gpt-y',
      primaryRequestId: 'req-1',
    })
  })

  test('its message is never balance, even when the fallback itself was refused for balance', () => {
    for (const cause of [
      'boom',
      `iu-openai ${BALANCE_MARKER} (402): {"error":"payment required"}`,
      IU_503,
      ANTHROPIC_MESSAGE,
      OPENAI_QUOTA,
      'HTTP 402 Payment Required',
    ]) {
      const { message } = make(cause)
      expect(message).not.toContain(BALANCE_MARKER)
      expect(isBalanceFailure({ text: message })).toBe(false)
      for (const status of [400, 402, 429, 503])
        expect(isBalanceFailure({ status, text: message })).toBe(status === 402)
    }
  })
})

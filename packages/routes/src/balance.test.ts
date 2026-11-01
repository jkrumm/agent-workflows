import { describe, expect, test } from 'bun:test'
import { BALANCE_MARKER, isBalanceFailure } from './balance.ts'

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
    for (const status of [400, 429, 500, 502, 504]) expect(isBalanceFailure({ status, text: IU_503 })).toBe(false)
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
    // A text-only 402 from OpenCode or the ocr CLI.
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
    // The status-less callers are step failure reasons and ocr's stderr. Review's failure reasons carry no diff text:
    // an agent step's schema failure is zod's message (no values), the synthesis output is a plain string, the
    // adversary's errors name no answer text, and an OpenCode turn error is the provider's. A diff that quotes the
    // refusal would read as one, so it must never be classified.
    expect(isBalanceFailure({ text: '+  throw new Error("HTTP 402 Payment Required")' })).toBe(true)
  })
})

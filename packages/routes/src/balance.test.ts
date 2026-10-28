import { describe, expect, test } from 'bun:test'
import { BALANCE_MARKER, isBalanceFailure } from './balance.ts'

// IU's body on an empty provider account, as it arrived 2026-10-28.
const IU_503 = 'IU request failed (503) — Insufficient Balance (PaymentRequired) on Requesty-Global'

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

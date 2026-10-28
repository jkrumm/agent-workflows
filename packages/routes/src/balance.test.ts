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

  test('without a status the text decides', () => {
    expect(isBalanceFailure({ text: IU_503 })).toBe(true)
    expect(isBalanceFailure({ text: `iu-openai ${BALANCE_MARKER} (503): x` })).toBe(true)
    expect(isBalanceFailure({ text: 'APICallError: HTTP 402 from provider' })).toBe(true)
    expect(isBalanceFailure({ text: 'iu-openai request failed (402): ' })).toBe(true)
    expect(isBalanceFailure({ text: 'iu-openai request failed (503): busy' })).toBe(false)
    expect(isBalanceFailure({ text: 'src/app.ts:402 has a bug' })).toBe(false)
  })
})

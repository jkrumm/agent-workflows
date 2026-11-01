import { describe, expect, test } from 'bun:test'
import { claudeRate, resolveModelAlias } from '@agent-workflows/routes/pricing'
import { chargeOf, type RequestShape } from '../src/charge.ts'
import type { TeeResult, TokenColumns } from '../src/tee.ts'

const opus = claudeRate('opus')
if (opus === undefined) throw new Error('no opus rate')
const rate = { ...opus, cacheWrite1hPerM: opus.cacheWrite1hPerM ?? 0, cacheWritePerM: opus.cacheWritePerM ?? 0 }
const MTOK = 1_000_000
const none: TokenColumns = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, reasoning: 0 }
const request: RequestShape = { bytes: 3 * MTOK, maxTokens: 10, streamed: true }

const estimate = (tokens: Partial<TokenColumns> | null, bytesReceived = 0) => {
  const tee: TeeResult = {
    usage: null,
    tokens: tokens === null ? null : { ...none, ...tokens },
    model: null,
    streamError: false,
    complete: false,
    bytesReceived,
  }
  const model = resolveModelAlias('opus')
  return chargeOf({ tee, model, creditPool: true, billable: true, request }).estimateUsd
}

describe('an estimate keeps the categories the stream reported', () => {
  test('a 1 h cache write is priced at the 1 h rate, not as input or a 5 m write', () => {
    expect(rate.cacheWrite1hPerM).not.toBe(rate.cacheWritePerM)
    expect(estimate({ cacheWrite1h: MTOK })).toBeCloseTo(rate.cacheWrite1hPerM, 9)
  })

  test('a 5 m write and a cache read at theirs', () => {
    expect(estimate({ cacheWrite5m: MTOK })).toBeCloseTo(rate.cacheWritePerM, 9)
    expect(estimate({ cacheRead: MTOK })).toBeCloseTo(rate.cacheReadPerM ?? 0, 9)
  })

  test('all of them together, with the output inferred from the bytes as plain output', () => {
    const usd = estimate({ input: MTOK, cacheRead: MTOK, cacheWrite5m: MTOK, cacheWrite1h: MTOK, output: 1 }, 3 * MTOK)
    expect(usd).toBeCloseTo(
      rate.inputPerM + (rate.cacheReadPerM ?? 0) + rate.cacheWritePerM + rate.cacheWrite1hPerM + rate.outputPerM,
      9,
    )
  })

  test('seen output above the bytes stands', () => {
    expect(estimate({ input: 1, output: 2 * MTOK }, 3)).toBeCloseTo(
      (rate.inputPerM * 1) / MTOK + 2 * rate.outputPerM,
      9,
    )
  })

  test('nothing seen: the request bytes are the input', () => {
    expect(estimate(null)).toBeCloseTo(rate.inputPerM, 9)
    expect(estimate(none)).toBeCloseTo(rate.inputPerM, 9)
  })
})

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
  return chargeOf({ tee, model, routedModel: null, creditPool: true, billable: true, request }).estimateUsd
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

describe('off /anthropic a complete block is priced at the route rate of the requested model', () => {
  // GPT-6.1 Terra's route rate: in 1.00, cached in 0.05, out 5.00 USD/M.
  const terraUsd = (600 * 1 + 400 * 0.05 + 200 * 5) / MTOK
  // A raw provider block: `ProviderUsage` does not type every field a wire sends (`input_tokens_details.cached_tokens`).
  const charge = (usage: object, routedModel: string | null, model: string | null = routedModel) =>
    chargeOf({
      tee: {
        usage,
        tokens: null,
        model,
        streamError: false,
        complete: true,
        bytesReceived: 1,
      },
      model,
      routedModel,
      creditPool: false,
      billable: true,
      request,
    })
  const chat = { prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 400 } }

  test('chat completions: the cached reads come out of the prompt at the cache rate', () => {
    expect(charge(chat, 'gpt-6.1-terra')).toEqual({ reportedUsd: expect.closeTo(terraUsd, 12), estimateUsd: null })
  })

  test('the Responses API: its input_tokens includes the cached reads, as prompt_tokens does', () => {
    const responses = {
      input_tokens: 1000,
      output_tokens: 200,
      input_tokens_details: { cached_tokens: 400 },
      output_tokens_details: { reasoning_tokens: 50 },
    }
    expect(charge(responses, 'gpt-6.1-terra').reportedUsd).toBeCloseTo(terraUsd, 12)
  })

  test('the provider cost still wins', () => {
    expect(charge({ ...chat, cost: 0.5 }, 'gpt-6.1-terra').reportedUsd).toBe(0.5)
    expect(charge({ input_tokens: 1, output_tokens: 1, input_tokens_details: {}, cost: 0.25 }, 'x').reportedUsd).toBe(
      0.25,
    )
  })

  test('a model without a route rate, or no requested model, stays unpriced', () => {
    expect(charge(chat, 'gpt-x').reportedUsd).toBeNull()
    expect(charge(chat, 'gpt-image-2.5-flare').reportedUsd).toBeNull()
    expect(charge(chat, null, 'gpt-6.1-terra').reportedUsd).toBeNull()
  })

  test('an incomplete block is not priced, and off a credit pool nothing is estimated', () => {
    const tee: TeeResult = {
      usage: chat,
      tokens: null,
      model: null,
      streamError: false,
      complete: false,
      bytesReceived: 9,
    }
    const args = { tee, model: 'gpt-6.1-terra', routedModel: 'gpt-6.1-terra', creditPool: false, billable: true }
    expect(chargeOf({ ...args, request })).toEqual({ reportedUsd: null, estimateUsd: null })
  })

  test('a Claude model keeps the Claude rate', () => {
    const usage = { input_tokens: 1000, output_tokens: 200 }
    const opusUsd = (1000 * rate.inputPerM + 200 * rate.outputPerM) / MTOK
    expect(charge(usage, 'claude-opus-5-5').reportedUsd).toBeCloseTo(opusUsd, 12)
    expect(charge(usage, null, resolveModelAlias('opus')).reportedUsd).toBeCloseTo(opusUsd, 12)
  })
})

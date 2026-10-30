import { describe, expect, test } from 'bun:test'
import { additiveTokens, usageFromOpenCodeMessages } from '../src/index.ts'
import { cachedTurn, partlyPriced, toolTurns } from './fixtures/opencode-messages.ts'

describe('usageFromOpenCodeMessages', () => {
  test('converts the additive message tokens to raw provider counts', () => {
    expect(usageFromOpenCodeMessages(cachedTurn)).toEqual({
      model: 'deepseek-v4.1-flash',
      tokens: { input: 257 + 21376, output: 2, cacheRead: 21376, cacheWrite: 0, reasoning: 0 },
      cost: 0.000103878,
      costSource: 'provider',
      toolCalls: 0,
    })
  })

  test('sums turns, counts tool blocks, keeps cache writes in their bucket, takes the route model', () => {
    const usage = usageFromOpenCodeMessages(toolTurns, { model: 'iu/deepseek-v4.1-flash' })
    expect(usage).toEqual({
      model: 'iu/deepseek-v4.1-flash',
      tokens: {
        input: 1200 + 800 + 64 + 150 + 2000,
        output: 40 + 300 + 25 + 60,
        cacheRead: 2800,
        cacheWrite: 64,
        reasoning: 360,
      },
      cost: 0.0021 + 0.0009,
      costSource: 'provider',
      toolCalls: 2,
    })
  })

  test('round trip: the usage projection gets back what OpenCode billed, reasoning counted once', () => {
    const row = additiveTokens({ cacheWrite: 0, ...usageFromOpenCodeMessages(toolTurns).tokens })
    // The total input + output + cache_write + reasoning; OpenCode's own (non-cache-read) total is the same.
    const opencodeTotal = 1200 + 40 + 300 + 64 + (150 + 25 + 60)
    expect(row.input_tokens + row.output_tokens + row.cache_write_5m_tokens + row.reasoning_tokens).toBe(opencodeTotal)
    expect(row.reasoning_tokens).toBe(360)
    expect(row.cache_write_5m_tokens).toBe(64)
    expect(row.input_tokens).toBe(1200 + 150)
    expect(row.output_tokens).toBe(65)
  })

  test('one unpriced message makes the step unpriced, never a silent undercount', () => {
    const usage = usageFromOpenCodeMessages(partlyPriced)
    expect(usage.cost).toBeNull()
    expect(usage.costSource).toBe('unknown')
    expect(usage.tokens.input).toBe(30)
    expect(usage.model).toBeUndefined()
  })

  test('no assistant message: zero usage', () => {
    expect(usageFromOpenCodeMessages([{ type: 'user' }, { type: 'idle' }]).tokens).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
    })
  })
})

import { describe, expect, test } from 'bun:test'
import { CLAUDE_MODELS, claudeRate, costFromUsage, resolveModelAlias } from './index.ts'
import { type Rate, rateSchema } from './schema.ts'

const HAIKU = 'claude-haiku-5-5'
const SONNET = 'claude-sonnet-5-5'
const OPUS = 'claude-opus-5-5'

describe('the Claude models', () => {
  test('three current models, read-only', () => {
    expect([...CLAUDE_MODELS].sort()).toEqual([HAIKU, OPUS, SONNET])
    expect(Object.isFrozen(CLAUDE_MODELS)).toBe(true)
  })

  test('every rate is a valid rate with a 1h write at 2x input and a 5m write at 1.25x', () => {
    for (const id of CLAUDE_MODELS) {
      const rate = claudeRate(id)
      expect(rateSchema.safeParse(rate).success).toBe(true)
      expect(rate?.cacheWrite1hPerM).toBeCloseTo((rate?.inputPerM ?? 0) * 2, 10)
      expect(rate?.cacheWritePerM).toBeCloseTo((rate?.inputPerM ?? 0) * 1.25, 10)
    }
  })

  test('rates as published, USD per MTok', () => {
    expect(claudeRate(HAIKU)).toEqual({
      inputPerM: 0.1,
      outputPerM: 0.5,
      cacheReadPerM: 0.01,
      cacheWritePerM: 0.125,
      cacheWrite1hPerM: 0.2,
      longPromptTokens: 100_000,
      longPrompt: { inputMultiplier: 5, outputMultiplier: 5 },
    })
    expect(claudeRate(SONNET)).toEqual({
      inputPerM: 2,
      outputPerM: 10,
      cacheReadPerM: 0.1,
      cacheWritePerM: 2.5,
      cacheWrite1hPerM: 4,
    })
    expect(claudeRate(OPUS)).toEqual({
      inputPerM: 4,
      outputPerM: 20,
      cacheReadPerM: 0.2,
      cacheWritePerM: 5,
      cacheWrite1hPerM: 8,
    })
  })
})

describe('resolveModelAlias', () => {
  test('an alias is its id', () => {
    expect(resolveModelAlias('haiku')).toBe(HAIKU)
    expect(resolveModelAlias('sonnet')).toBe(SONNET)
    expect(resolveModelAlias('opus')).toBe(OPUS)
  })

  test('anything else comes back untouched: ids, case variants, inherited property names, the empty string', () => {
    for (const model of [
      SONNET,
      'Haiku',
      'OPUS',
      ' sonnet',
      'sonnet ',
      'constructor',
      'toString',
      '__proto__',
      '',
      'gpt-6.1-terra',
    ]) {
      expect(resolveModelAlias(model)).toBe(model)
    }
  })
})

describe('claudeRate', () => {
  test('by id or alias; unknown models and inherited names have none', () => {
    expect(claudeRate('sonnet')).toEqual(claudeRate(SONNET))
    expect(claudeRate('Sonnet')).toBeUndefined()
    expect(claudeRate('constructor')).toBeUndefined()
    expect(claudeRate('gpt-6.1-terra')).toBeUndefined()
  })

  test('returns a copy: mutating it changes nothing shared', () => {
    const rate = claudeRate(HAIKU)
    if (!rate?.longPrompt) throw new Error('test setup: no tier')
    rate.inputPerM = 999
    rate.longPrompt.inputMultiplier = 999
    expect(claudeRate(HAIKU)?.inputPerM).toBe(0.1)
    expect(claudeRate(HAIKU)?.longPrompt?.inputMultiplier).toBe(5)
  })
})

describe("pricing an Anthropic response the way the gateway does: costFromUsage('iu-anthropic', usage, claudeRate(model))", () => {
  const price = (model: string, usage: Parameters<typeof costFromUsage>[1]) =>
    costFromUsage('iu-anthropic', usage, claudeRate(model))

  test('Sonnet with 5m and 1h cache writes, cache reads and output', () => {
    const cost = price('sonnet', {
      input_tokens: 1_200,
      output_tokens: 800,
      cache_read_input_tokens: 50_000,
      cache_creation_input_tokens: 30_000,
      cache_creation: { ephemeral_5m_input_tokens: 10_000, ephemeral_1h_input_tokens: 20_000 },
    })
    // 1200*2 + 50000*0.1 + 10000*2.5 + 20000*4 + 800*10 = 120_400 micro-USD
    expect(cost.source).toBe('rate')
    expect(cost.usd).toBeCloseTo(0.1204, 10)
  })

  test('Opus: the same split at its own rates', () => {
    const cost = price(OPUS, {
      input_tokens: 500,
      output_tokens: 2_000,
      cache_creation_input_tokens: 4_000,
      cache_creation: { ephemeral_5m_input_tokens: 1_000, ephemeral_1h_input_tokens: 3_000 },
    })
    // 500*4 + 1000*5 + 3000*8 + 2000*20 = 71_000
    expect(cost.usd).toBeCloseTo(0.071, 10)
  })

  test('Haiku over 100K prompt tokens: the whole request at 5x, 1h writes included', () => {
    const cost = price('haiku', {
      input_tokens: 20_000,
      output_tokens: 500,
      cache_read_input_tokens: 80_000,
      cache_creation_input_tokens: 10_000,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 10_000 },
    })
    // ((20000*0.1 + 80000*0.01 + 10000*0.2) + 500*0.5) * 5 = 25_250
    expect(cost.usd).toBeCloseTo(0.02525, 10)
  })

  test('Haiku: exactly 100K is the base card, one token more is the tier', () => {
    const at = (input: number) => price(HAIKU, { input_tokens: input, output_tokens: 0 })
    expect(at(100_000).usd).toBeCloseTo(0.01, 10)
    expect(at(100_001).usd).toBeCloseTo(0.0500005, 10)
  })

  test('Sonnet and Opus have no tier: a 900K prompt bills the base rate', () => {
    expect(price(SONNET, { input_tokens: 900_000, output_tokens: 0 }).usd).toBeCloseTo(1.8, 10)
    expect(price(OPUS, { input_tokens: 900_000, output_tokens: 0 }).usd).toBeCloseTo(3.6, 10)
  })

  test('the alias and the id price the same', () => {
    const usage = { input_tokens: 10, output_tokens: 10 }
    expect(price('opus', usage)).toEqual(price(OPUS, usage))
  })

  test('the provider cost still wins; an unknown model has no rate, so no cost', () => {
    expect(price(SONNET, { cost: 0.5, input_tokens: 1, output_tokens: 1 })).toEqual({ usd: 0.5, source: 'provider' })
    expect(price('not-a-claude', { input_tokens: 1, output_tokens: 1 })).toEqual({ usd: null, source: 'unknown' })
  })
})

describe('1h cache writes', () => {
  const rate: Rate = { inputPerM: 1, outputPerM: 1, cacheReadPerM: 0.1, cacheWritePerM: 1.25, cacheWrite1hPerM: 2 }
  const cost = (usage: Parameters<typeof costFromUsage>[1], r = rate) => costFromUsage('iu-anthropic', usage, r)

  test('without the split every cache write is 5m, as before', () => {
    expect(cost({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000 })).toEqual({
      usd: 1.25,
      source: 'rate',
    })
  })

  test('a rate without a 1h rate prices 1h writes at the write rate', () => {
    const { cacheWrite1hPerM: _drop, ...flat } = rate
    const usage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 1_000_000,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1_000_000 },
    }
    expect(cost(usage, flat)).toEqual({ usd: 1.25, source: 'rate' })
    expect(cost(usage)).toEqual({ usd: 2, source: 'rate' })
  })

  test('the total wins over a lower 5m count: the remainder after 1h is 5m, never dropped', () => {
    expect(
      cost({
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 2_000_000,
        cache_creation: { ephemeral_5m_input_tokens: 500_000, ephemeral_1h_input_tokens: 1_000_000 },
      }),
    ).toEqual({ usd: 3.25, source: 'rate' })
  })

  test('without the total the split is the writes', () => {
    expect(
      cost({
        input_tokens: 0,
        output_tokens: 0,
        cache_creation: { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 1_000_000 },
      }),
    ).toEqual({ usd: 3.25, source: 'rate' })
  })

  test('null split fields and a null split behave as absent', () => {
    expect(
      cost({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000, cache_creation: null }),
    ).toEqual({ usd: 1.25, source: 'rate' })
    expect(
      cost({
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 1_000_000,
        cache_creation: { ephemeral_5m_input_tokens: null, ephemeral_1h_input_tokens: null },
      }),
    ).toEqual({ usd: 1.25, source: 'rate' })
  })

  test('unknown, never free: 1h writes above the total, or writes with no write rate at all', () => {
    expect(
      cost({
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 10,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 11 },
      }),
    ).toEqual({ usd: null, source: 'unknown' })
    const { cacheWritePerM: _a, cacheWrite1hPerM: _b, ...none } = rate
    expect(
      cost(
        {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 10,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 10 },
        },
        none,
      ),
    ).toEqual({ usd: null, source: 'unknown' })
  })

  test('a 1h-only rate prices 1h writes but a 5m write against it is unknown', () => {
    const { cacheWritePerM: _a, ...only1h } = rate
    const split = (m5: number, h1: number) => ({
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: m5 + h1,
      cache_creation: { ephemeral_5m_input_tokens: m5, ephemeral_1h_input_tokens: h1 },
    })
    expect(cost(split(0, 1_000_000), only1h)).toEqual({ usd: 2, source: 'rate' })
    expect(cost(split(1, 1_000_000), only1h)).toEqual({ usd: null, source: 'unknown' })
  })
})

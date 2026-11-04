import { describe, expect, test } from 'bun:test'
import { additiveTokens, carriesUsage, type OpenCodeMessage, usageFromOpenCodeMessages } from '../src/index.ts'
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
    const usage = usageFromOpenCodeMessages(toolTurns, { model: 'iu/gpt-6.1-terra' })
    expect(usage).toEqual({
      model: 'gpt-6.1-terra',
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

  test('the model is the canonical id: the route model or a message echo, prefix, snapshot date and [1m] stripped', () => {
    const echoed: OpenCodeMessage[] = [{ ...(cachedTurn[1] as OpenCodeMessage), modelID: 'openai.gpt-6.1-terra' }]
    expect(usageFromOpenCodeMessages(echoed).model).toBe('gpt-6.1-terra')
    expect(usageFromOpenCodeMessages(echoed, { model: 'vertex_ai_eu/gpt-6.1-terra' }).model).toBe('gpt-6.1-terra')
    const claude = usageFromOpenCodeMessages(echoed, { model: 'sonnet' }).model as string
    expect(usageFromOpenCodeMessages(echoed, { model: `${claude}-20261001[1m]` }).model).toBe(claude)
    expect(usageFromOpenCodeMessages(echoed, { model: 'sonnet' }).model).toBe(claude)
    expect(claude).toMatch(/^claude-sonnet-/)
  })

  test('route comes from the options, next to model; without one the usage has no route key', () => {
    expect(usageFromOpenCodeMessages(cachedTurn, { route: 'check' }).route).toBe('check')
    expect(usageFromOpenCodeMessages(cachedTurn)).not.toHaveProperty('route')
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

describe('a compaction message carries its summary calls', () => {
  // OpenCode 2.0.32: `type: 'compaction'` with the usage of the compaction request(s) as one total, measured live.
  const compaction = (over: Partial<OpenCodeMessage> = {}): OpenCodeMessage => ({
    type: 'compaction',
    status: 'completed',
    model: { id: 'claude-haiku-5-5~ctx80000' },
    cost: 0.004,
    tokens: { input: 900, output: 300, reasoning: 0, cache: { read: 5000, write: 100 } },
    ...over,
  })
  const answer: OpenCodeMessage = {
    type: 'assistant',
    model: { id: 'claude-haiku-5-5~ctx80000' },
    cost: 0.001,
    tokens: { input: 50, output: 20, reasoning: 0, cache: { read: 400, write: 0 } },
    content: [{ type: 'text' }],
  }

  test('its tokens and cost count once, beside the assistant messages', () => {
    const usage = usageFromOpenCodeMessages([{ type: 'user' }, compaction(), answer, { type: 'idle' }])
    expect(usage.tokens).toEqual({
      input: 900 + 5000 + 100 + 50 + 400,
      output: 300 + 20,
      cacheRead: 5400,
      cacheWrite: 100,
      reasoning: 0,
    })
    expect(usage.cost).toBeCloseTo(0.005, 12)
    expect(usage.costSource).toBe('provider')
  })

  test('carriesUsage: assistant and settled compaction messages; not a running one, a user message or an idle', () => {
    expect(carriesUsage({ type: 'assistant' })).toBe(true)
    expect(carriesUsage({ type: 'compaction', status: 'completed' })).toBe(true)
    expect(carriesUsage({ type: 'compaction', status: 'failed' })).toBe(true)
    expect(carriesUsage({ type: 'compaction', status: 'running' })).toBe(false)
    expect(carriesUsage({ type: 'user' })).toBe(false)
    expect(carriesUsage({ type: 'idle' })).toBe(false)
  })

  test('a failed compaction that spent counts; a running one, or one that spent nothing, adds nothing', () => {
    expect(usageFromOpenCodeMessages([compaction({ status: 'failed' })]).tokens.input).toBe(6000)
    const idle = [
      compaction({ status: 'running', tokens: undefined, cost: undefined }),
      compaction({ status: 'failed', tokens: undefined, cost: undefined }),
    ]
    expect(usageFromOpenCodeMessages(idle)).toMatchObject({
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      cost: 0,
      toolCalls: 0,
    })
  })

  test('the real model is the options one, not the alias a message names; tool calls stay the assistants', () => {
    const calls: OpenCodeMessage = { ...answer, content: [{ type: 'tool' }, { type: 'tool' }, { type: 'text' }] }
    const usage = usageFromOpenCodeMessages([compaction(), calls], {
      model: 'claude-haiku-5-5',
      route: 'research.agent',
    })
    expect(usage).toMatchObject({ model: 'claude-haiku-5-5', route: 'research.agent', toolCalls: 2 })
  })

  test('a compaction call without a cost makes the step unpriced, as an assistant message would', () => {
    const usage = usageFromOpenCodeMessages([compaction({ cost: undefined }), answer])
    expect(usage.cost).toBeNull()
    expect(usage.costSource).toBe('unknown')
  })
})

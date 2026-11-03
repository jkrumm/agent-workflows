import { describe, expect, test } from 'bun:test'
import { usageFromOpenCodeMessages } from '@agent-workflows/middleware'
import { CLAUDE_MODELS, CONTEXT_LIMITS, claudeRate } from '@agent-workflows/routes'
import {
  buildServerConfig,
  COMPACTION_BUFFER,
  contextAlias,
  fallbackModelRef,
  modelRef,
  PROVIDER_ANTHROPIC,
  windowFor,
} from '../src/config.ts'
import { priceOpenCodeMessages } from '../src/host.ts'

type Row = {
  name?: string
  modelID?: string
  limit?: { context?: number; output?: number }
  cost?: unknown
  variants?: unknown
  compatibility?: unknown
}
const anthropicRows = () =>
  (buildServerConfig() as { providers: Record<string, { models: Record<string, Row> }> }).providers[PROVIDER_ANTHROPIC]
    ?.models as Record<string, Row>

/** OpenCode 2.0.32 `calculateCeiling` (packages/core/src/session/compaction.ts) with `compaction.buffer` set. */
const ceilingOf = (window: number, buffer: number) => window - buffer
/** OpenCode 2.0.32 `SUMMARY_OUTPUT_MAX` (packages/core/src/session/model-request.ts): all a summary call can ask for. */
const SUMMARY_OUTPUT_MAX = 32_000

describe('the bounded rows of the server config', () => {
  test('every Claude model has one alias row per allowed bound, sending the real model id with its own window', () => {
    const rows = anthropicRows()
    for (const model of CLAUDE_MODELS) {
      for (const limit of CONTEXT_LIMITS) {
        const row = rows[contextAlias(model, limit)]
        expect(row?.modelID).toBe(model)
        expect(row?.limit?.context).toBe(windowFor(limit))
      }
    }
    expect(contextAlias('claude-haiku-5-5', 80_000)).toBe('claude-haiku-5-5~ctx80000')
  })

  test('there are no alias rows beyond models x allowed bounds', () => {
    const aliases = Object.keys(anthropicRows()).filter((key) => key.includes('~ctx'))
    expect(aliases.sort()).toEqual(
      CLAUDE_MODELS.flatMap((model) => CONTEXT_LIMITS.map((limit) => contextAlias(model, limit))).sort(),
    )
    expect(aliases).toHaveLength(CLAUDE_MODELS.length * CONTEXT_LIMITS.length)
  })

  test('an alias row prices, varies and behaves like its base row, and the base row has no window', () => {
    const rows = anthropicRows()
    for (const model of CLAUDE_MODELS) {
      const base = rows[model] as Row
      expect(base.limit?.context).toBeUndefined()
      expect(base.modelID).toBeUndefined()
      for (const limit of CONTEXT_LIMITS) {
        const { modelID: _id, limit: aliasLimit, ...alias } = rows[contextAlias(model, limit)] as Row
        const { limit: baseLimit, ...rest } = base
        expect(alias).toEqual(rest)
        expect(aliasLimit?.output).toBe(baseLimit?.output)
      }
    }
    expect((rows[contextAlias('claude-haiku-5-5', CONTEXT_LIMITS[0])] as Row).cost).toBeDefined()
  })

  test('only the Anthropic provider has aliases, and compaction stays on with a buffer that leaves a summary its room', () => {
    const config = buildServerConfig() as { providers: Record<string, { models: Record<string, unknown> }> }
    for (const [id, p] of Object.entries(config.providers)) {
      if (id !== PROVIDER_ANTHROPIC) expect(Object.keys(p.models).some((k) => k.includes('~ctx'))).toBe(false)
    }
    // Only `buffer`: no `auto: false` (the session must compact) and no `keep`.
    expect((config as { compaction?: unknown }).compaction).toEqual({ buffer: COMPACTION_BUFFER })
    // The summary call asks for min(32k, window - request): the buffer is the room, 32k is all it can use, the summary
    // prompt takes a few thousand of it (10,733 of a 16k buffer, measured, `test/live-context-limit.test.ts`).
    expect(COMPACTION_BUFFER).toBeGreaterThanOrEqual(SUMMARY_OUTPUT_MAX + 5_000)
  })

  test("the window puts OpenCode's compaction ceiling at bound / 1.25, the buffer below the window", () => {
    expect(windowFor(100_000)).toBe(80_000 + COMPACTION_BUFFER)
    for (const limit of CONTEXT_LIMITS) {
      const window = windowFor(limit)
      expect(ceilingOf(window, COMPACTION_BUFFER)).toBe(Math.floor(limit / 1.25))
      // Headroom for a chars/4 undercount of 25% of everything, up to the bound.
      expect(Math.ceil(ceilingOf(window, COMPACTION_BUFFER) * 1.25)).toBeLessThanOrEqual(limit)
    }
  })
})

describe('every window leaves a ceiling', () => {
  test('a row with a limit.context has a window above twice the buffer, so no ceiling is zero or negative', () => {
    const providers = (buildServerConfig() as { providers: Record<string, { models: Record<string, Row> }> }).providers
    const windows = Object.entries(providers).flatMap(([provider, { models }]) =>
      Object.entries(models).flatMap(([id, row]) => (row.limit?.context === undefined ? [] : [{ provider, id, row }])),
    )
    expect(windows.length).toBe(CLAUDE_MODELS.length * CONTEXT_LIMITS.length)
    for (const { id, row } of windows) {
      expect({ id, ok: (row.limit?.context as number) > 2 * COMPACTION_BUFFER }).toEqual({ id, ok: true })
    }
  })
})

describe('modelRef with a contextLimit', () => {
  const bound = CONTEXT_LIMITS[0]
  const patch = { 'review.angle': { contextLimit: bound } }

  test("the session's model is the alias, with the route's effort as the variant; the route keeps the real model", () => {
    const { route, model } = modelRef('review.angle', patch)
    expect(model.providerID).toBe(PROVIDER_ANTHROPIC)
    expect(model.id).toBe(contextAlias(route.model, bound))
    expect(model.variant).toBe(route.effort as string)
    expect(route.model).toBe('claude-haiku-5-5')
    expect(anthropicRows()[model.id]).toBeDefined()
  })

  test('without a bound the model is the plain id, as before', () => {
    expect(modelRef('check').model.id).toBe('claude-haiku-5-5')
    expect(modelRef('review.angle', { 'review.angle': { contextLimit: null } }).model.id).toBe('claude-haiku-5-5')
  })

  test('the fallback is not bounded: its model is its own plain id', () => {
    const fallback = fallbackModelRef('review.angle', patch)
    expect(fallback).toBeDefined()
    expect(fallback?.model.id).toBe(fallback?.route.model as string)
    expect(fallback?.model.id).not.toContain('~ctx')
  })

  test('every variant of every alias an arm can reach exists on its row', () => {
    for (const limit of CONTEXT_LIMITS) {
      const { model } = modelRef('review.angle', { 'review.angle': { contextLimit: limit } })
      const variants = (anthropicRows()[model.id] as Row).variants as { id: string }[]
      expect(variants.map((v) => v.id)).toContain(model.variant as string)
    }
  })
})

describe('usage and pricing stay on the real model', () => {
  const rate = claudeRate('claude-haiku-5-5')
  // A message as OpenCode reports it for an alias session: the alias is the model it names, cost from the row (= base).
  const message = (cost: number) =>
    ({
      type: 'assistant',
      model: { id: 'claude-haiku-5-5~ctx80000', providerID: PROVIDER_ANTHROPIC },
      tokens: { input: 1000, output: 200, reasoning: 0, cache: { read: 50_000, write: 2000 } },
      cost,
    }) as never

  test('a step on an alias is priced exactly as on the base row (the message carries no model into the price)', () => {
    const base = { ...(message(0.01) as object), model: { id: 'claude-haiku-5-5' } } as never
    expect(priceOpenCodeMessages([message(0.01)], rate ?? null)).toEqual(priceOpenCodeMessages([base], rate ?? null))
    expect(priceOpenCodeMessages([message(0)], rate ?? null)?.byRate).toBe(true)
  })

  test("the usage's model is the route's real one, the handle's, not the alias a message names", () => {
    const usage = usageFromOpenCodeMessages([message(0.01)], { model: 'claude-haiku-5-5', route: 'review.angle' })
    expect(usage.model).toBe('claude-haiku-5-5')
    expect(usage.costSource).toBe('provider')
  })
})

describe('a compaction message is priced like an assistant one', () => {
  const rate = claudeRate('claude-haiku-5-5') ?? null
  const tokens = { input: 900, output: 300, reasoning: 0, cache: { read: 5000, write: 100 } }
  const compaction = (cost: number) => ({ type: 'compaction', status: 'completed', cost, tokens }) as never
  const assistant = (cost: number) => ({ type: 'assistant', cost, tokens }) as never

  test("OpenCode's cost counts, and a cost of 0 is priced by the rate", () => {
    expect(priceOpenCodeMessages([compaction(0.004), assistant(0.001)], rate)).toEqual({ cost: 0.005, byRate: false })
    const same = priceOpenCodeMessages([assistant(0)], rate)
    expect(priceOpenCodeMessages([compaction(0)], rate)).toEqual(same)
    expect(same?.byRate).toBe(true)
  })

  test('a running compaction (no tokens) adds nothing', () => {
    expect(priceOpenCodeMessages([{ type: 'compaction', status: 'running' } as never], rate)).toEqual({
      cost: 0,
      byRate: false,
    })
  })
})

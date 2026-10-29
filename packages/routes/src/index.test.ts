import { describe, expect, test } from 'bun:test'
import {
  costFromUsage,
  DEFAULT_ROUTES,
  fallbackRoute,
  OVERRIDES_ENV,
  type RouteId,
  RouteOverrideError,
  resolveRoute,
  routeFingerprint,
  routeIds,
  routeSchema,
  UnknownRouteError,
  validateOverrides,
} from './index.ts'
import { ROUTE_ID } from './schema.ts'

function entry(id: RouteId) {
  const e = DEFAULT_ROUTES[id]
  if (!e) throw new Error(`test setup: no route ${id}`)
  return e
}

const env = (routes?: unknown) => (routes === undefined ? {} : { [OVERRIDES_ENV]: JSON.stringify(routes) })

describe('table', () => {
  test('every entry is valid and every id well-formed', () => {
    for (const id of routeIds()) {
      expect(ROUTE_ID.test(id)).toBe(true)
      expect(routeSchema.safeParse(DEFAULT_ROUTES[id]).success).toBe(true)
    }
  })

  test('covers the seats Waves 2-4 need', () => {
    const needed: RouteId[] = ['cheap.summarize', 'cheap.title', 'cheap.classify', 'decide', 'review.angle', 'check']
    for (const id of needed) expect(routeIds()).toContain(id)
  })

  test('every wire is represented', () => {
    const wires = new Set(routeIds().map((id) => DEFAULT_ROUTES[id]?.wire))
    expect([...wires].sort()).toEqual(['iu-anthropic', 'iu-decision', 'iu-openai', 'opencode'])
  })
})

describe('resolveRoute', () => {
  test('returns the entry with its id', () => {
    expect(resolveRoute('decide', {})).toEqual({ id: 'decide', ...entry('decide') })
  })

  test('unknown id is a typed error', () => {
    expect(() => resolveRoute('nope' as RouteId, {})).toThrow(UnknownRouteError)
    expect(() => resolveRoute('constructor' as RouteId, {})).toThrow(UnknownRouteError)
  })

  test('override changes model and effort, leaves the table alone', () => {
    const e = env({ 'review.angle': { model: 'some-model', effort: 'high' } })
    expect(resolveRoute('review.angle', e)).toMatchObject({ model: 'some-model', effort: 'high', wire: 'opencode' })
    expect(resolveRoute('review.angle', {}).model).toBe(entry('review.angle').model)
  })

  test('the deep angle route is its own seat: Sonnet, priced, overridden independently of review.angle', () => {
    const deep = resolveRoute('review.angle.deep', {})
    expect(deep).toMatchObject({ wire: 'opencode', model: 'claude-sonnet-5-5-eu' })
    expect(deep.rate).toEqual({
      inputPerM: 2,
      outputPerM: 10,
      cacheReadPerM: 0.1,
      cacheWritePerM: 2.5,
      longPromptTokens: 1_000_000,
    })
    expect(deep.fallback?.wire).toBe('opencode')
    // a 150K-token angle prompt (past Haiku's 100K step) is priced, not unknown
    expect(costFromUsage('opencode', { input_tokens: 150_000, output_tokens: 1_000 }, deep.rate)).toMatchObject({
      source: 'rate',
    })
    const e = env({ 'review.angle.deep': { model: 'some-model' } })
    expect(resolveRoute('review.angle.deep', e)).toMatchObject({ model: 'some-model' })
    expect(resolveRoute('review.angle.deep', e).rate).toBeUndefined() // a new model drops the old rate
    expect(resolveRoute('review.angle', e).model).toBe(entry('review.angle').model)
    expect(routeFingerprint('review.angle.deep', e)).not.toBe(routeFingerprint('review.angle.deep', {}))
    expect(routeFingerprint('review.angle', e)).toBe(routeFingerprint('review.angle', {}))
  })

  test('null clears an optional field', () => {
    const e = env({ 'cheap.classify': { maxOutputTokens: null } })
    expect(resolveRoute('cheap.classify', e).maxOutputTokens).toBeUndefined()
  })

  test('a new model drops the old rate unless a new one comes with it', () => {
    expect(resolveRoute('decide', env({ decide: { model: 'other' } })).rate).toBeUndefined()
    const rate = { inputPerM: 1, outputPerM: 2 }
    expect(resolveRoute('decide', env({ decide: { model: 'other', rate } })).rate).toEqual(rate)
    expect(resolveRoute('decide', env({ decide: { effort: null } })).rate).toEqual(DEFAULT_ROUTES.decide?.rate)
  })

  test('an override is validated like the table', () => {
    for (const bad of [
      { 'review.angle': { effort: 'turbo' } },
      { 'review.angle': { model: '' } },
      { 'review.angle': { maxOutputTokens: -1 } },
      { 'review.angle': { maxOutputTokens: 200_001 } },
      { 'review.angle': { wire: 'iu-openai' } },
      { decide: { rate: { inputPerM: -1, outputPerM: 0 } } },
      { 'review.angle': { colour: 'red' } },
      { decide: { effort: 'high' } },
      { nope: { model: 'x' } },
    ]) {
      expect(() => resolveRoute('check', env(bad))).toThrow(RouteOverrideError)
    }
  })

  test('overriding wire says why', () => {
    expect(() => resolveRoute('check', env({ check: { wire: 'iu-openai' } }))).toThrow(/wire cannot be overridden/)
  })

  test('a non-finite rate in the variable is rejected', () => {
    const raw = '{"decide":{"rate":{"inputPerM":1e999,"outputPerM":1}}}'
    expect(() => resolveRoute('decide', { [OVERRIDES_ENV]: raw })).toThrow(RouteOverrideError)
  })

  test('the variable is parsed per call, not cached', () => {
    expect(resolveRoute('check', env({ check: { model: 'a' } })).model).toBe('a')
    expect(resolveRoute('check', env({ check: { model: 'b' } })).model).toBe('b')
    expect(resolveRoute('check', {}).model).toBe(entry('check').model)
  })

  test('mutating a resolved route changes neither the table nor the fingerprint', () => {
    const before = routeFingerprint('decide', {})
    const resolved = resolveRoute('decide', {})
    resolved.model = 'tampered'
    if (resolved.rate) resolved.rate.inputPerM = 0
    expect(resolveRoute('decide', {})).toEqual({ id: 'decide', ...entry('decide') })
    expect(entry('decide').rate?.inputPerM).toBe(0.04)
    expect(routeFingerprint('decide', {})).toBe(before)
  })

  test('every opencode route carries its own rate: the host prices its sessions with it', () => {
    for (const id of routeIds()) if (entry(id).wire === 'opencode') expect(entry(id).rate).toBeDefined()
  })

  test('the table is deeply frozen', () => {
    expect(Object.isFrozen(DEFAULT_ROUTES)).toBe(true)
    for (const id of routeIds()) {
      expect(Object.isFrozen(entry(id))).toBe(true)
      const { rate } = entry(id)
      if (rate) expect(Object.isFrozen(rate)).toBe(true)
    }
  })

  test('malformed JSON is a typed error for every route', () => {
    expect(() => resolveRoute('check', { [OVERRIDES_ENV]: '{nope' })).toThrow(RouteOverrideError)
    expect(() => resolveRoute('check', { [OVERRIDES_ENV]: '[]' })).toThrow(RouteOverrideError)
  })

  test('a malformed variable never puts input text in the error, from resolveRoute either', () => {
    for (const raw of ['{nope', '{"check": leakysecret}', 'leakysecret', '{"check":{"model":"leakysecret"']) {
      let message = ''
      try {
        resolveRoute('check', { [OVERRIDES_ENV]: raw })
      } catch (error) {
        expect(error).toBeInstanceOf(RouteOverrideError)
        message = (error as Error).message
      }
      expect(message).toBe('AGW_ROUTES: not valid JSON')
    }
  })

  test('blank variable means no overrides', () => {
    expect(resolveRoute('check', { [OVERRIDES_ENV]: '  ' }).id).toBe('check')
  })
})

describe('routeFingerprint', () => {
  test('is stable and hex sha256', () => {
    expect(routeFingerprint('check', {})).toMatch(/^[0-9a-f]{64}$/)
    expect(routeFingerprint('check', {})).toBe(routeFingerprint('check', {}))
  })

  test('changes with model, effort and id; ignores key order in the override', () => {
    const base = routeFingerprint('review.angle', {})
    const flipped = routeFingerprint('review.angle', env({ 'review.angle': { effort: 'max' } }))
    expect(flipped).not.toBe(base)
    expect(routeFingerprint('review.angle', env({ 'review.angle': { model: 'm' } }))).not.toBe(base)
    expect(routeFingerprint('review.synthesis', {})).not.toBe(routeFingerprint('review.angle', {}))
    const a = routeFingerprint('decide', env({ decide: { model: 'm', rate: { inputPerM: 1, outputPerM: 2 } } }))
    const b = routeFingerprint('decide', env({ decide: { rate: { outputPerM: 2, inputPerM: 1 }, model: 'm' } }))
    expect(a).toBe(b)
  })

  test('an override that restates the table does not change it', () => {
    const e = env({ 'review.angle': { model: entry('review.angle').model } })
    expect(routeFingerprint('review.angle', e)).toBe(routeFingerprint('review.angle', {}))
  })
})

describe('costFromUsage', () => {
  const rate = { inputPerM: 0.04, outputPerM: 0.04 }

  test('provider cost wins, including a real zero', () => {
    expect(costFromUsage('iu-openai', { cost: 0.0123, prompt_tokens: 10, completion_tokens: 5 }, rate)).toEqual({
      usd: 0.0123,
      source: 'provider',
    })
    expect(costFromUsage('iu-openai', { cost: 0 })).toEqual({ usd: 0, source: 'provider' })
  })

  test('falls back to the rate across usage key conventions', () => {
    const expected = { usd: (1000 * 0.04 + 500 * 0.04) / 1e6, source: 'rate' } as const
    expect(costFromUsage('iu-decision', { inputTokens: 1000, outputTokens: 500 }, rate)).toEqual(expected)
    expect(costFromUsage('iu-decision', { prompt_tokens: 1000, completion_tokens: 500 }, rate)).toEqual(expected)
    expect(costFromUsage('iu-anthropic', { input_tokens: 1000, output_tokens: 500, cost: null }, rate)).toEqual(
      expected,
    )
  })

  test('a free decision model is a rate cost of 0, not unknown', () => {
    expect(costFromUsage('iu-decision', { inputTokens: 5, outputTokens: 1 }, { inputPerM: 0, outputPerM: 0 })).toEqual({
      usd: 0,
      source: 'rate',
    })
  })

  test('neither provider cost nor rate is unknown, never 0', () => {
    expect(costFromUsage('iu-openai', { prompt_tokens: 10, completion_tokens: 5 })).toEqual({
      usd: null,
      source: 'unknown',
    })
    expect(costFromUsage('iu-openai', undefined, rate)).toEqual({ usd: null, source: 'unknown' })
    expect(costFromUsage('iu-decision', {}, rate)).toEqual({ usd: null, source: 'unknown' })
  })

  test('a malformed provider cost is ignored', () => {
    expect(costFromUsage('iu-openai', { cost: Number.NaN, input_tokens: 1, output_tokens: 1 }, rate).source).toBe(
      'rate',
    )
    expect(costFromUsage('iu-openai', { cost: -1 }).source).toBe('unknown')
  })

  describe('cache tokens', () => {
    const cached = { inputPerM: 1, outputPerM: 5, cacheReadPerM: 0.1, cacheWritePerM: 1.25 }
    const usd = (v: number) => ({ usd: expect.closeTo(v / 1e6, 12), source: 'rate' as const })

    test('Anthropic: input_tokens excludes the cache counts, each bucket has its own rate', () => {
      const usage = {
        input_tokens: 1000,
        output_tokens: 200,
        cache_read_input_tokens: 4000,
        cache_creation_input_tokens: 500,
      }
      expect(costFromUsage('iu-anthropic', usage, cached)).toEqual(usd(1000 * 1 + 4000 * 0.1 + 500 * 1.25 + 200 * 5))
    })

    test('OpenAI: prompt_tokens includes cached_tokens, which are priced at the read rate instead', () => {
      const usage = { prompt_tokens: 5000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 4000 } }
      expect(costFromUsage('iu-openai', usage, cached)).toEqual(usd(1000 * 1 + 4000 * 0.1 + 200 * 5))
    })

    test('a missing cache rate with cache tokens present is unknown, never free', () => {
      const noCache = { inputPerM: 1, outputPerM: 5 }
      expect(
        costFromUsage('iu-anthropic', { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 5 }, noCache),
      ).toEqual({
        usd: null,
        source: 'unknown',
      })
      expect(
        costFromUsage(
          'iu-anthropic',
          { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 5 },
          {
            ...noCache,
            cacheReadPerM: 0.1,
          },
        ),
      ).toEqual({ usd: null, source: 'unknown' })
    })

    test('zero cache tokens need no cache rate', () => {
      const usage = {
        input_tokens: 10,
        output_tokens: 1,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: null,
      }
      expect(costFromUsage('iu-anthropic', usage, { inputPerM: 1, outputPerM: 5 })).toEqual(usd(10 * 1 + 1 * 5))
    })

    test('cache counts above the cache-inclusive prompt total are unknown, not clamped to zero input', () => {
      const usage = { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 101 } }
      expect(costFromUsage('iu-openai', usage, cached)).toEqual({ usd: null, source: 'unknown' })
    })

    test('a prompt above 100K tokens including cache is unknown; exactly 100K is priced', () => {
      const long = { input_tokens: 1000, output_tokens: 5, cache_read_input_tokens: 99_000 }
      expect(costFromUsage('iu-anthropic', long, cached)).toEqual(usd(1000 * 1 + 99_000 * 0.1 + 5 * 5))
      expect(costFromUsage('iu-anthropic', { ...long, input_tokens: 1001 }, cached)).toEqual({
        usd: null,
        source: 'unknown',
      })
      expect(costFromUsage('iu-openai', { prompt_tokens: 100_001, completion_tokens: 5 }, cached)).toEqual({
        usd: null,
        source: 'unknown',
      })
    })

    test('the provider cost still wins over cache pricing', () => {
      const usage = { cost: 0.5, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 5 }
      expect(costFromUsage('iu-anthropic', usage, cached)).toEqual({ usd: 0.5, source: 'provider' })
      expect(costFromUsage('iu-anthropic', { ...usage, input_tokens: 200_000 }, cached)).toEqual({
        usd: 0.5,
        source: 'provider',
      })
    })
  })
})

describe('fallback', () => {
  const singleCall: RouteId[] = [
    'cheap.classify',
    'cheap.summarize',
    'cheap.title',
    'review.router',
    'review.adversary',
  ]
  const agentSteps: RouteId[] = ['review.angle', 'review.synthesis', 'check']

  test('every iu-openai, iu-anthropic and opencode route has one; decide has none', () => {
    for (const id of routeIds()) {
      const route = resolveRoute(id, {})
      expect(route.fallback === undefined).toBe(route.wire === 'iu-decision')
    }
  })

  test('single calls fall back to a priced call on the chat wire, agent steps to an opencode step', () => {
    for (const id of [...singleCall, 'review.ocr' as const]) {
      expect(resolveRoute(id, {}).fallback).toMatchObject({ wire: 'iu-openai', effort: 'medium' })
    }
    for (const id of agentSteps) expect(resolveRoute(id, {}).fallback).toMatchObject({ wire: 'opencode' })
    for (const id of [...singleCall, ...agentSteps]) {
      const fallback = resolveRoute(id, {}).fallback
      expect(fallback?.model).not.toBe(resolveRoute(id, {}).model)
      expect(fallback?.rate).toMatchObject({
        inputPerM: 1,
        outputPerM: 5,
        cacheReadPerM: 0.05,
        longPromptTokens: 272_000,
      })
    }
  })

  test('fallbackRoute is the fallback as a route of the same id, marked, without a fallback of its own', () => {
    const route = resolveRoute('cheap.classify', {})
    const fallback = fallbackRoute(route)
    expect(fallback).toEqual({ id: 'cheap.classify', ...(route.fallback as object), isFallback: true } as never)
    expect(fallback?.fallback).toBeUndefined()
    expect(fallbackRoute(resolveRoute('decide', {}))).toBeUndefined()
  })

  test('AGW_ROUTES patches a fallback like a primary, and only the part it names', () => {
    const e = env({ 'cheap.classify': { fallback: { model: 'other-model', effort: 'high' } } })
    const route = resolveRoute('cheap.classify', e)
    expect(route.model).toBe(entry('cheap.classify').model)
    expect(route.fallback).toMatchObject({ wire: 'iu-openai', model: 'other-model', effort: 'high' })
    // A new fallback model without a rate drops the old rate, as on the primary.
    expect(route.fallback?.rate).toBeUndefined()
    expect(routeFingerprint('cheap.classify', e)).not.toBe(routeFingerprint('cheap.classify', {}))
  })

  test('a primary patch leaves the fallback alone; null removes the fallback', () => {
    const patched = resolveRoute('review.angle', env({ 'review.angle': { model: 'some-model' } }))
    expect(patched.fallback).toEqual(entry('review.angle').fallback as never)
    expect(resolveRoute('review.angle', env({ 'review.angle': { fallback: null } })).fallback).toBeUndefined()
  })

  test('a fallback override is validated like the table', () => {
    for (const bad of [
      { 'cheap.classify': { fallback: { wire: 'opencode' } } },
      { 'cheap.classify': { fallback: { effort: 'turbo' } } },
      { 'cheap.classify': { fallback: { fallback: { model: 'x' } } } },
      { decide: { fallback: { model: 'x' } } },
    ]) {
      expect(() => resolveRoute('cheap.classify', env(bad))).toThrow(RouteOverrideError)
    }
  })

  test('the table refuses a fallback of the other step kind', () => {
    const base = { wire: 'iu-openai', model: 'm' }
    expect(routeSchema.safeParse({ ...base, fallback: { wire: 'opencode', model: 'f' } }).success).toBe(false)
    expect(routeSchema.safeParse({ ...base, fallback: { wire: 'iu-anthropic', model: 'f' } }).success).toBe(true)
  })

  test('the long-prompt tier of a rate moves the unpriced line', () => {
    const rate = resolveRoute('cheap.classify', {}).fallback?.rate
    const usage = (prompt: number) => ({ prompt_tokens: prompt, completion_tokens: 1_000 })
    expect(costFromUsage('iu-openai', usage(200_000), rate)).toEqual({ usd: 0.205, source: 'rate' })
    expect(costFromUsage('iu-openai', usage(272_001), rate)).toEqual({ usd: null, source: 'unknown' })
    expect(costFromUsage('iu-openai', usage(200_000), { inputPerM: 1, outputPerM: 5 })).toEqual({
      usd: null,
      source: 'unknown',
    })
  })
})

describe('validateOverrides', () => {
  test('unset, blank and {} touch nothing', () => {
    expect(validateOverrides({})).toEqual([])
    expect(validateOverrides({ [OVERRIDES_ENV]: '  ' })).toEqual([])
    expect(validateOverrides(env({}))).toEqual([])
  })

  test('returns the route ids the override touches, a fallback patch included', () => {
    expect(validateOverrides(env({ check: { effort: 'low' }, 'cheap.classify': { model: 'm' } }))).toEqual([
      'check',
      'cheap.classify',
    ])
  })

  test('checks every patch, not only the first: an unknown id and a bad spec each throw, naming the id', () => {
    const unknown = () => validateOverrides(env({ check: { effort: 'low' }, 'no.such': { model: 'x' } }))
    expect(unknown).toThrow(RouteOverrideError)
    expect(unknown).toThrow('"no.such"')
    const bad = () => validateOverrides(env({ check: { model: 'x' }, decide: { effort: 'high' } }))
    expect(bad).toThrow(RouteOverrideError)
    expect(bad).toThrow('"decide"')
  })

  test('malformed JSON names the problem and never the parser message or any of the input', () => {
    for (const raw of ['{nope', '{"check": leakysecret}', 'leakysecret', '{"check":{"model":"leakysecret"']) {
      let message = ''
      try {
        validateOverrides({ [OVERRIDES_ENV]: raw })
      } catch (error) {
        expect(error).toBeInstanceOf(RouteOverrideError)
        message = (error as Error).message
      }
      expect(message).toBe('AGW_ROUTES: not valid JSON')
    }
  })

  test('a shape or value error carries no override value', () => {
    for (const bad of [
      { check: { effort: 'leakysecret' } },
      { check: { colour: 'leakysecret' } },
      { check: 'leakysecret' },
      'leakysecret',
      ['leakysecret'],
    ]) {
      let message = ''
      try {
        validateOverrides(env(bad))
      } catch (error) {
        expect(error).toBeInstanceOf(RouteOverrideError)
        message = (error as Error).message
      }
      expect(message).not.toBe('')
      expect(message).not.toContain('leakysecret')
    }
  })
})

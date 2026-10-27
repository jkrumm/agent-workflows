import { describe, expect, test } from 'bun:test'
import {
  costFromUsage,
  DEFAULT_ROUTES,
  OVERRIDES_ENV,
  RouteOverrideError,
  resolveRoute,
  routeFingerprint,
  routeIds,
  routeSchema,
  UnknownRouteError,
} from './index.ts'
import { ROUTE_ID } from './schema.ts'

function entry(id: string) {
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
    for (const id of ['cheap.summarize', 'cheap.title', 'cheap.classify', 'decide', 'review.angle', 'check']) {
      expect(routeIds()).toContain(id)
    }
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
    expect(() => resolveRoute('nope', {})).toThrow(UnknownRouteError)
    expect(() => resolveRoute('constructor', {})).toThrow(UnknownRouteError)
  })

  test('override changes model and effort, leaves the table alone', () => {
    const e = env({ 'review.angle': { model: 'some-model', effort: 'high' } })
    expect(resolveRoute('review.angle', e)).toMatchObject({ model: 'some-model', effort: 'high', wire: 'opencode' })
    expect(resolveRoute('review.angle', {}).model).toBe(entry('review.angle').model)
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
      { 'review.angle': { colour: 'red' } },
      { decide: { effort: 'high' } },
      { nope: { model: 'x' } },
    ]) {
      expect(() => resolveRoute('check', env(bad))).toThrow(RouteOverrideError)
    }
  })

  test('malformed JSON is a typed error for every route', () => {
    expect(() => resolveRoute('check', { [OVERRIDES_ENV]: '{nope' })).toThrow(RouteOverrideError)
    expect(() => resolveRoute('check', { [OVERRIDES_ENV]: '[]' })).toThrow(RouteOverrideError)
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
})

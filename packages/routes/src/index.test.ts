import { describe, expect, test } from 'bun:test'
import {
  costFromUsage,
  DEFAULT_ROUTES,
  fallbackRoute,
  opencodeModels,
  type RouteId,
  RouteOverrideError,
  resolveRoute,
  routeFingerprint,
  routeIds,
  routeSchema,
  UnknownRouteError,
  validateArm,
} from './index.ts'
import { ROUTE_ID, rateSchema } from './schema.ts'

function entry(id: RouteId) {
  const e = DEFAULT_ROUTES[id]
  if (!e) throw new Error(`test setup: no route ${id}`)
  return e
}

/** An opencode model the table serves that `id` does not already run: where an arm may move an agent route. */
function otherAgentModel(id: RouteId): string {
  const model = [...opencodeModels()].find((m) => m !== entry(id).model)
  if (!model) throw new Error(`test setup: no other opencode model than ${id}'s`)
  return model
}

describe('table', () => {
  test('every entry is valid and every id well-formed', () => {
    for (const id of routeIds()) {
      expect(ROUTE_ID.test(id)).toBe(true)
      expect(routeSchema.safeParse(DEFAULT_ROUTES[id]).success).toBe(true)
    }
  })

  test('covers the routes Waves 2-4 need', () => {
    const needed: RouteId[] = ['cheap.summarize', 'cheap.title', 'cheap.classify', 'decide', 'review.angle', 'check']
    for (const id of needed) expect(routeIds()).toContain(id)
  })

  test('every wire the table uses is represented', () => {
    const wires = new Set(routeIds().map((id) => DEFAULT_ROUTES[id]?.wire))
    expect([...wires].sort()).toEqual([
      'anthropic',
      'iu-decision',
      'iu-gemini',
      'iu-openai',
      'iu-replicate',
      'opencode',
    ])
  })
})

describe('resolveRoute', () => {
  test('returns the entry with its id', () => {
    expect(resolveRoute('decide', {})).toEqual({
      id: 'decide',
      ...entry('decide'),
    })
  })

  test('unknown id is a typed error', () => {
    expect(() => resolveRoute('nope' as RouteId, {})).toThrow(UnknownRouteError)
    expect(() => resolveRoute('constructor' as RouteId, {})).toThrow(UnknownRouteError)
  })

  test('a patch changes model and effort, leaves the table alone', () => {
    const model = otherAgentModel('review.angle')
    const e = { 'review.angle': { model, effort: 'high' } }
    expect(resolveRoute('review.angle', e)).toMatchObject({ model, effort: 'high', wire: 'opencode' })
    expect(resolveRoute('review.angle').model).toBe(entry('review.angle').model)
  })

  test('without a patch, or with an empty one, the table', () => {
    for (const patch of [undefined, null, {}])
      expect(resolveRoute('check', patch)).toEqual({ id: 'check', ...entry('check') })
  })

  test('the deep angle route is its own route: Sonnet medium, priced, overridden independently of review.angle', () => {
    const deep = resolveRoute('review.angle.deep', {})
    expect(deep).toMatchObject({
      wire: 'opencode',
      model: 'claude-sonnet-5-5',
      effort: 'medium',
    })
    expect(deep.rate).toMatchObject({ inputPerM: 2, outputPerM: 10, cacheReadPerM: 0.1 })
    // the fallback is GPT on IU, runs the same kind of step, and carries Terra's tiered card
    expect(deep.fallback).toMatchObject({
      wire: 'opencode',
      model: 'gpt-6.1-terra',
      effort: 'medium',
    })
    // the long-prompt tier applies above 272K prompt tokens: the whole request bills 2x input, 1.5x output
    expect(costFromUsage('opencode', { input_tokens: 1_500_000, output_tokens: 1_000 }, deep.fallback?.rate)).toEqual({
      usd: (1_500_000 * 1 * 2 + 1_000 * 5 * 1.5) / 1e6,
      source: 'rate',
    })
    const model = otherAgentModel('review.angle.deep')
    const e = { 'review.angle.deep': { model } }
    expect(resolveRoute('review.angle.deep', e)).toMatchObject({ model })
    // a new model takes the table's rate for that model, never the old one, never none
    expect(resolveRoute('review.angle.deep', e).rate).toBeDefined()
    expect(resolveRoute('review.angle.deep', e).rate).not.toEqual(deep.rate)
    expect(resolveRoute('review.angle', e).model).toBe(entry('review.angle').model)
    expect(routeFingerprint('review.angle.deep', e)).not.toBe(routeFingerprint('review.angle.deep', {}))
    expect(routeFingerprint('review.angle', e)).toBe(routeFingerprint('review.angle', {}))
  })

  test('null clears an optional field', () => {
    const e = { 'cheap.classify': { maxOutputTokens: null } }
    expect(resolveRoute('cheap.classify', e).maxOutputTokens).toBeUndefined()
  })

  test("a new model takes the table's rate for that model; a priced route never moves to a model the table prices no such way", () => {
    // A model the table does not name is refused on every wire, before any price is looked at: it goes into the table first.
    expect(() => resolveRoute('decide', { decide: { model: 'other' } })).toThrow(
      'arm: route "decide": model "other" is not in the route table (add it to the table first)',
    )
    expect(() => resolveRoute('cheap.classify', { 'cheap.classify': { fallback: { model: 'other' } } })).toThrow(
      'route "cheap.classify" fallback: model "other" is not in the route table',
    )
    // A table model priced per call, not per token: the text route would lose its rate.
    expect(() => resolveRoute('cheap.classify', { 'cheap.classify': { model: entry('image.upscale').model } })).toThrow(
      'route "cheap.classify": the route table has no rate for the patched model, and this route is priced by one',
    )
    expect(resolveRoute('decide', { decide: { effort: null } }).rate).toEqual(DEFAULT_ROUTES.decide?.rate)
    const sonnet = resolveRoute('cheap.classify', { 'cheap.classify': { model: 'claude-sonnet-5-5', effort: 'low' } })
    expect(sonnet.rate).toEqual(resolveRoute('review.angle.deep').rate as never)
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
      expect(() => resolveRoute('check', bad as never)).toThrow(RouteOverrideError)
    }
  })

  test('overriding wire says why', () => {
    expect(() => resolveRoute('check', { check: { wire: 'iu-openai' } })).toThrow(/wire cannot be overridden/)
  })

  test('a non-finite rate is rejected', () => {
    expect(() => resolveRoute('decide', { decide: { rate: { inputPerM: Infinity, outputPerM: 1 } } })).toThrow(
      RouteOverrideError,
    )
  })

  test('each call resolves the patch it is given, nothing is cached', () => {
    const [a, b] = [...opencodeModels()].filter((m) => m !== entry('check').model)
    expect(resolveRoute('check', { check: { model: a } }).model).toBe(a as string)
    expect(resolveRoute('check', { check: { model: b } }).model).toBe(b as string)
    expect(resolveRoute('check').model).toBe(entry('check').model)
  })

  test('an agent route moves only to a model the OpenCode server serves, naming the route and the model', () => {
    // A table model that only single calls use (the FAST tier's fallback) is not one the server serves.
    const callOnly = entry('cheap.classify').fallback?.model as string
    expect(opencodeModels().has(callOnly)).toBe(false)
    expect(() => resolveRoute('check', { check: { model: callOnly } })).toThrow(
      `arm: route "check": model "${callOnly}" is not served by the OpenCode server`,
    )
    expect(() => resolveRoute('check', { check: { fallback: { effort: 'low', rate: null } } })).toThrow(
      /route "check" fallback: rate cannot be patched on the opencode wire/,
    )
    expect(() => resolveRoute('check', { check: { fallback: { model: callOnly } } })).toThrow(
      `route "check" fallback: model "${callOnly}" is not served`,
    )
    for (const key of ['rate', 'maxOutputTokens']) {
      const value = key === 'rate' ? { inputPerM: 1, outputPerM: 1 } : 1000
      expect(() => resolveRoute('check', { check: { [key]: value } })).toThrow(
        `route "check": ${key} cannot be patched`,
      )
    }
    // effort moves freely: the server registers every effort variant of each model
    expect(resolveRoute('check', { check: { effort: 'max' } }).effort).toBe('max')
  })

  test('mutating a resolved route changes neither the table nor the fingerprint', () => {
    const before = routeFingerprint('decide', {})
    const resolved = resolveRoute('decide', {})
    resolved.model = 'tampered'
    if (resolved.rate) resolved.rate.inputPerM = 0
    expect(resolveRoute('decide', {})).toEqual({
      id: 'decide',
      ...entry('decide'),
    })
    expect(entry('decide').rate?.inputPerM).toBe(0.042)
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

  test('a patch that is not an object of patches is a typed error for every route, carrying none of its values', () => {
    for (const raw of ['leakysecret', ['leakysecret'], { check: 'leakysecret' }, 42]) {
      let message = ''
      try {
        resolveRoute('check', raw as never)
      } catch (error) {
        expect(error).toBeInstanceOf(RouteOverrideError)
        message = (error as Error).message
      }
      expect(message).toStartWith('arm: ')
      expect(message).not.toContain('leakysecret')
    }
  })
})

describe('routeFingerprint', () => {
  test('is stable and hex sha256', () => {
    expect(routeFingerprint('check', {})).toMatch(/^[0-9a-f]{64}$/)
    expect(routeFingerprint('check', {})).toBe(routeFingerprint('check', {}))
  })

  test('changes with model, effort and id; ignores key order in the override', () => {
    const base = routeFingerprint('review.angle', {})
    const flipped = routeFingerprint('review.angle', { 'review.angle': { effort: 'max' } })
    expect(flipped).not.toBe(base)
    const model = otherAgentModel('review.angle')
    expect(routeFingerprint('review.angle', { 'review.angle': { model } })).not.toBe(base)
    expect(routeFingerprint('review.synthesis', {})).not.toBe(routeFingerprint('review.angle', {}))
    const a = routeFingerprint('decide', { decide: { maxOutputTokens: null, rate: { inputPerM: 1, outputPerM: 2 } } })
    const b = routeFingerprint('decide', { decide: { rate: { outputPerM: 2, inputPerM: 1 }, maxOutputTokens: null } })
    expect(a).toBe(b)
  })

  test('an override that restates the table does not change it', () => {
    const e = { 'review.angle': { model: entry('review.angle').model } }
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
    expect(costFromUsage('iu-openai', { cost: 0 })).toEqual({
      usd: 0,
      source: 'provider',
    })
  })

  test('falls back to the rate across usage key conventions', () => {
    const expected = {
      usd: (1000 * 0.04 + 500 * 0.04) / 1e6,
      source: 'rate',
    } as const
    expect(costFromUsage('iu-decision', { inputTokens: 1000, outputTokens: 500 }, rate)).toEqual(expected)
    expect(costFromUsage('iu-decision', { prompt_tokens: 1000, completion_tokens: 500 }, rate)).toEqual(expected)
    expect(costFromUsage('anthropic', { input_tokens: 1000, output_tokens: 500, cost: null }, rate)).toEqual(expected)
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
    expect(costFromUsage('iu-openai', undefined, rate)).toEqual({
      usd: null,
      source: 'unknown',
    })
    expect(costFromUsage('iu-decision', {}, rate)).toEqual({
      usd: null,
      source: 'unknown',
    })
  })

  test('a malformed provider cost is ignored', () => {
    expect(costFromUsage('iu-openai', { cost: Number.NaN, input_tokens: 1, output_tokens: 1 }, rate).source).toBe(
      'rate',
    )
    expect(costFromUsage('iu-openai', { cost: -1 }).source).toBe('unknown')
  })

  describe('cache tokens', () => {
    const cached = {
      inputPerM: 1,
      outputPerM: 5,
      cacheReadPerM: 0.1,
      cacheWritePerM: 1.25,
    }
    const usd = (v: number) => ({
      usd: expect.closeTo(v / 1e6, 12),
      source: 'rate' as const,
    })

    test('Anthropic: input_tokens excludes the cache counts, each bucket has its own rate', () => {
      const usage = {
        input_tokens: 1000,
        output_tokens: 200,
        cache_read_input_tokens: 4000,
        cache_creation_input_tokens: 500,
      }
      expect(costFromUsage('anthropic', usage, cached)).toEqual(usd(1000 * 1 + 4000 * 0.1 + 500 * 1.25 + 200 * 5))
    })

    test('OpenAI: prompt_tokens includes cached_tokens, which are priced at the read rate instead', () => {
      const usage = {
        prompt_tokens: 5000,
        completion_tokens: 200,
        prompt_tokens_details: { cached_tokens: 4000 },
      }
      expect(costFromUsage('iu-openai', usage, cached)).toEqual(usd(1000 * 1 + 4000 * 0.1 + 200 * 5))
    })

    test('a missing cache rate with cache tokens present is unknown, never free', () => {
      const noCache = { inputPerM: 1, outputPerM: 5 }
      expect(
        costFromUsage('anthropic', { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 5 }, noCache),
      ).toEqual({
        usd: null,
        source: 'unknown',
      })
      expect(
        costFromUsage(
          'anthropic',
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
      expect(costFromUsage('anthropic', usage, { inputPerM: 1, outputPerM: 5 })).toEqual(usd(10 * 1 + 1 * 5))
    })

    test('cache counts above the cache-inclusive prompt total are unknown, not clamped to zero input', () => {
      const usage = {
        prompt_tokens: 100,
        completion_tokens: 5,
        prompt_tokens_details: { cached_tokens: 101 },
      }
      expect(costFromUsage('iu-openai', usage, cached)).toEqual({
        usd: null,
        source: 'unknown',
      })
    })

    test('a rate without a longPrompt tier is flat at any size', () => {
      const long = {
        input_tokens: 1001,
        output_tokens: 5,
        cache_read_input_tokens: 99_000,
      }
      expect(costFromUsage('anthropic', long, cached)).toEqual(usd(1001 * 1 + 99_000 * 0.1 + 5 * 5))
      expect(costFromUsage('iu-openai', { prompt_tokens: 5_000_001, completion_tokens: 5 }, cached)).toEqual(
        usd(5_000_001 * 1 + 5 * 5),
      )
    })

    test('the provider cost still wins over cache pricing', () => {
      const usage = {
        cost: 0.5,
        input_tokens: 1,
        output_tokens: 1,
        cache_read_input_tokens: 5,
      }
      expect(costFromUsage('anthropic', usage, cached)).toEqual({
        usd: 0.5,
        source: 'provider',
      })
      expect(costFromUsage('anthropic', { ...usage, input_tokens: 200_000 }, cached)).toEqual({
        usd: 0.5,
        source: 'provider',
      })
    })
  })
})

describe('fallback', () => {
  // The audio door's routes have no fallback: STT has its own model chain, and TTS, prep and summary keep audio-gateway's
  // behaviour (no balance fallback; packages/audio calls IU directly, not through the capability transports).
  test('every text route has one; decide, audio.* (but the prep) and the image/Replicate models have none', () => {
    for (const id of routeIds()) {
      const route = resolveRoute(id, {})
      // an audio route has none; an image or Replicate model (`price`) has no text model to move to
      expect(route.fallback === undefined).toBe(
        route.wire === 'iu-decision' ||
          (id.startsWith('audio.') && id !== 'audio.tts.prep') ||
          route.price !== undefined,
      )
    }
  })

  const deepseekRate = { inputPerM: 0.3, outputPerM: 1.2, cacheReadPerM: 0.006 }
  const terraRate = {
    inputPerM: 1,
    outputPerM: 5,
    cacheReadPerM: 0.05,
    longPromptTokens: 272_000,
    longPrompt: { inputMultiplier: 2, outputMultiplier: 1.5 },
  }
  const lunaRate = { inputPerM: 0.1, outputPerM: 0.5, cacheReadPerM: 0.01 }

  // The Claude tiers (owner decision 2026-11-01): a single call speaks the anthropic wire, an agent step stays on
  // OpenCode; a drained credit is a 402 and the fallback is GPT on IU by tier.
  test('a Claude tier falls back to GPT by tier: FAST to Luna low, EASY to Terra low, HARD to Terra medium', () => {
    const luna = { wire: 'iu-openai', model: 'gpt-6-luna', effort: 'low', maxOutputTokens: 32_000, rate: lunaRate }
    const terraLow = {
      wire: 'iu-openai',
      model: 'gpt-6.1-terra',
      effort: 'low',
      maxOutputTokens: 32_000,
      rate: terraRate,
    }
    const terraMedium = { ...terraLow, effort: 'medium' }
    for (const id of ['cheap.classify', 'cheap.title', 'factory.classify'] as const) {
      expect(resolveRoute(id, {})).toMatchObject({ wire: 'anthropic', model: 'claude-haiku-5-5', effort: 'none' })
      expect(resolveRoute(id, {}).fallback).toMatchObject(luna)
    }
    // image.enhance is FAST with effort high (the planner's own setting), its fallback Luna at high
    expect(resolveRoute('image.enhance', {})).toMatchObject({
      wire: 'anthropic',
      model: 'claude-haiku-5-5',
      effort: 'high',
    })
    expect(resolveRoute('image.enhance', {}).fallback).toMatchObject({ ...luna, effort: 'high' })
    for (const id of [
      'cheap.summarize',
      'cheap.extract',
      'overview.classify',
      'triage',
      'review.router',
      'review.ocr',
    ] as const) {
      expect(resolveRoute(id, {})).toMatchObject({ wire: 'anthropic', model: 'claude-haiku-5-5', effort: 'high' })
      expect(resolveRoute(id, {}).fallback).toMatchObject(terraLow)
    }
    for (const id of [
      'narrative',
      'prose.write',
      'podcast.research',
      'podcast.editorial',
      'podcast.outline',
      'podcast.write',
    ] as const) {
      expect(resolveRoute(id, {})).toMatchObject({ wire: 'anthropic', model: 'claude-sonnet-5-5', effort: 'medium' })
      expect(resolveRoute(id, {}).fallback).toMatchObject(terraMedium)
    }
    expect(resolveRoute('prose.write', {}).effort).toBe('medium')
    for (const id of ['review.angle.deep', 'review.synthesis', 'research.agent', 'retro.analyze'] as const) {
      expect(resolveRoute(id, {})).toMatchObject({ wire: 'opencode', model: 'claude-sonnet-5-5', effort: 'medium' })
      expect(resolveRoute(id, {}).fallback).toMatchObject({ ...terraMedium, wire: 'opencode', rate: terraRate })
    }
    for (const id of ['check', 'brain.agent', 'review.angle', 'otel.agent'] as const) {
      expect(resolveRoute(id, {})).toMatchObject({ wire: 'opencode', model: 'claude-haiku-5-5', effort: 'high' })
      expect(resolveRoute(id, {}).fallback).toMatchObject({ ...terraLow, wire: 'opencode', rate: terraRate })
    }
    // Wave 6 seat picks: the diagram agent is FAST.agent (Haiku, no thinking), the podcast metadata EASY.call
    expect(resolveRoute('diagram.agent', {})).toMatchObject({
      wire: 'opencode',
      model: 'claude-haiku-5-5',
      effort: 'none',
    })
    expect(resolveRoute('diagram.agent', {}).fallback).toMatchObject({ ...terraLow, wire: 'opencode', rate: terraRate })
    expect(resolveRoute('podcast.metadata', {})).toMatchObject({
      wire: 'anthropic',
      model: 'claude-haiku-5-5',
      effort: 'high',
    })
    expect(resolveRoute('podcast.metadata', {}).fallback).toMatchObject(terraLow)
  })

  // Cross-lab seats that stay on GPT by design: the adversary and the second podcast reviewer are the CRITIC (Terra medium).
  test('review.adversary and podcast.review.b stay on GPT on the chat wire; audio.tts.prep is the FAST tier', () => {
    expect(resolveRoute('podcast.review.b', {})).toMatchObject({
      wire: 'iu-openai',
      model: 'gpt-6.1-terra',
      effort: 'medium',
    })
    expect(resolveRoute('podcast.review.b', {}).fallback).toMatchObject({
      wire: 'iu-openai',
      model: 'gpt-6-luna',
      effort: 'medium',
    })
    expect(resolveRoute('review.adversary', {})).toMatchObject({
      wire: 'iu-openai',
      model: 'gpt-6.1-terra',
      effort: 'medium',
      maxOutputTokens: 16_000,
    })
    expect(resolveRoute('review.adversary', {}).fallback).toMatchObject({
      wire: 'iu-openai',
      model: 'gpt-6-luna',
      effort: 'medium',
      maxOutputTokens: 32_000,
    })
    expect(resolveRoute('audio.tts.prep', {})).toMatchObject({
      wire: 'anthropic',
      model: 'claude-haiku-5-5',
      effort: 'none',
    })
    expect(resolveRoute('audio.tts.prep', {}).fallback).toMatchObject({
      wire: 'iu-openai',
      model: 'gpt-6-luna',
      effort: 'low',
    })
  })

  test('the DeepSeek route (prose.review) falls back to Terra medium on the chat wire', () => {
    expect(resolveRoute('prose.review', {})).toMatchObject({ model: 'deepseek-v4.1-flash', rate: deepseekRate })
    expect(resolveRoute('prose.review', {}).fallback).toMatchObject({
      wire: 'iu-openai',
      model: 'gpt-6.1-terra',
      effort: 'medium',
      maxOutputTokens: 32_000,
      rate: terraRate,
    })
  })

  test("a fallback never has the primary's own model", () => {
    for (const id of routeIds()) {
      const route = resolveRoute(id, {})
      if (route.fallback) expect({ id, same: route.fallback.model === route.model }).toEqual({ id, same: false })
    }
  })

  // Owner direction (2026-10-29): no region-pinned ids, nothing via Requesty. A route is proven by its response header,
  // not its id; the ids below are the ones the endpoint's header named Requesty (probed 2026-10-29).
  test('no route or fallback anywhere in the table is region-pinned', () => {
    for (const id of routeIds()) {
      const route = resolveRoute(id, {})
      for (const r of [route, route.fallback]) if (r) expect(r.model).not.toMatch(/-eu$|^eu\//)
    }
  })

  // The Requesty check covers ONLY the four routes Wave 9 moved (route and fallback). The one other `deepseek-v4.1-flash`
  // route (prose.review) is Requesty-Global too and stays: its decision is the lead's, not this guard's. The four run on the GPT stack and fall back to the other GPT model.
  test('the four routes moved off Requesty (router, adversary, ocr, classify) and their fallbacks name no Requesty model', () => {
    const requesty = /^(eu\/)?deepseek-v4\.1-flash|^DeepSeek-V4|^pplx-decider|^kimi-k3|^kimi-k2\.7/i
    for (const id of ['review.router', 'review.adversary', 'review.ocr', 'cheap.classify'] as const) {
      const route = resolveRoute(id, {})
      expect(route.model).not.toMatch(requesty)
      // the fallback is a GPT model on the chat wire
      expect(route.fallback?.wire).toBe('iu-openai')
      expect(route.fallback?.model).not.toBe(route.model)
      expect(route.fallback?.model).not.toMatch(requesty)
    }
    // triage is owner-directed off Requesty too; on Claude it falls back to Terra low on the chat wire
    expect(resolveRoute('triage', {}).fallback).toMatchObject({ wire: 'iu-openai', model: 'gpt-6.1-terra' })
  })

  test('the adversary fallback keeps the 32k output ceiling', () => {
    expect(resolveRoute('review.adversary', {}).fallback).toMatchObject({
      model: 'gpt-6-luna',
      maxOutputTokens: 32_000,
    })
  })

  test('fallbackRoute is the fallback as a route of the same id, marked, without a fallback of its own', () => {
    const route = resolveRoute('cheap.classify', {})
    const fallback = fallbackRoute(route)
    expect(fallback).toEqual({
      id: 'cheap.classify',
      ...(route.fallback as object),
      isFallback: true,
    } as never)
    expect(fallback?.fallback).toBeUndefined()
    expect(fallbackRoute(resolveRoute('decide', {}))).toBeUndefined()
  })

  test('a patch reaches a fallback like a primary, and only the part it names', () => {
    // The FAST tier's fallback moves to the Terra model the table names, at an effort of its own.
    const terra = entry('review.angle').fallback?.model as string
    const e = { 'cheap.classify': { fallback: { model: terra, effort: 'high' } } }
    const route = resolveRoute('cheap.classify', e)
    expect(route.model).toBe(entry('cheap.classify').model)
    expect(route.fallback).toMatchObject({ wire: 'iu-openai', model: terra, effort: 'high' })
    // The table's rate for that model, as on the primary.
    expect(route.fallback?.rate).toEqual(entry('review.angle').fallback?.rate as never)
    expect(routeFingerprint('cheap.classify', e)).not.toBe(routeFingerprint('cheap.classify', {}))
  })

  test('a primary patch leaves the fallback alone; null removes the fallback', () => {
    const patched = resolveRoute('review.angle', { 'review.angle': { model: otherAgentModel('review.angle') } })
    expect(patched.fallback).toEqual(entry('review.angle').fallback as never)
    expect(resolveRoute('review.angle', { 'review.angle': { fallback: null } }).fallback).toBeUndefined()
  })

  test('a fallback override is validated like the table', () => {
    for (const bad of [
      { 'cheap.classify': { fallback: { wire: 'opencode' } } },
      { 'cheap.classify': { fallback: { effort: 'turbo' } } },
      { 'cheap.classify': { fallback: { fallback: { model: 'x' } } } },
      { decide: { fallback: { model: 'x' } } },
    ]) {
      expect(() => resolveRoute('cheap.classify', bad as never)).toThrow(RouteOverrideError)
    }
  })

  test('the table refuses a fallback of the other step kind', () => {
    const base = { wire: 'iu-openai', model: 'm' }
    expect(
      routeSchema.safeParse({
        ...base,
        fallback: { wire: 'opencode', model: 'f' },
      }).success,
    ).toBe(false)
    expect(
      routeSchema.safeParse({
        ...base,
        fallback: { wire: 'anthropic', model: 'f' },
      }).success,
    ).toBe(true)
  })

  test('the long-prompt tier of a rate is where the price steps up', () => {
    const rate = resolveRoute('cheap.summarize', {}).fallback?.rate
    const usage = (prompt: number) => ({
      prompt_tokens: prompt,
      completion_tokens: 1_000,
    })
    expect(costFromUsage('iu-openai', usage(200_000), rate)).toEqual({
      usd: 0.205,
      source: 'rate',
    })
    // above 272K the whole request bills 2x input and 1.5x output
    expect(costFromUsage('iu-openai', usage(272_000), rate)).toEqual({
      usd: 0.277,
      source: 'rate',
    })
    expect(costFromUsage('iu-openai', usage(272_001), rate)).toEqual({
      usd: (272_001 * 2 + 1_000 * 7.5) / 1e6,
      source: 'rate',
    })
    // a rate without the tier is flat at the same size
    expect(
      costFromUsage('iu-openai', usage(300_000), {
        inputPerM: 1,
        outputPerM: 5,
      }),
    ).toEqual({
      usd: 0.305,
      source: 'rate',
    })
  })
})

describe('the long-prompt tier of Terra (>272K prompt tokens bill 2x input and cache, 1.5x output)', () => {
  const terra = resolveRoute('brain.agent', {}).fallback?.rate
  const at = (inputTokens: number, cacheRead = 0, cacheWrite = 0) =>
    costFromUsage(
      'anthropic',
      {
        input_tokens: inputTokens,
        output_tokens: 1_000,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheWrite,
      },
      terra,
    )
  const price = (input: number, read: number, write: number, output: number, tier: boolean) => ({
    usd: ((input * 1 + read * 0.05 + write * 1.25) * (tier ? 2 : 1) + output * 5 * (tier ? 1.5 : 1)) / 1e6,
    source: 'rate' as const,
  })

  test('exactly 272K is the base card; one token more is the tier, not unknown', () => {
    expect(at(272_000)).toEqual(price(272_000, 0, 0, 1_000, false))
    expect(at(272_001)).toEqual(price(272_001, 0, 0, 1_000, true))
  })

  test('cache reads and writes count toward the prompt and are repriced with it', () => {
    expect(at(1_000, 271_000)).toEqual(price(1_000, 271_000, 0, 1_000, false))
    expect(at(1_001, 271_000)).toEqual(price(1_001, 271_000, 0, 1_000, true))
    expect(at(10, 260_000, 12_000)).toEqual(price(10, 260_000, 12_000, 1_000, true))
  })

  test('the OpenAI-shaped usage (prompt_tokens includes the cache) is split the same way', () => {
    const usage = {
      prompt_tokens: 350_000,
      completion_tokens: 1_000,
      prompt_tokens_details: { cached_tokens: 300_000 },
    }
    expect(costFromUsage('opencode', usage, terra)).toEqual(price(50_000, 300_000, 0, 1_000, true))
  })

  test('a provider-reported cost still wins above the threshold', () => {
    expect(costFromUsage('anthropic', { cost: 0.5, input_tokens: 500_000, output_tokens: 1 }, terra)).toEqual({
      usd: 0.5,
      source: 'provider',
    })
  })

  test('every Terra route carries the same tiered card', () => {
    for (const id of routeIds()) {
      const route = resolveRoute(id, {})
      for (const r of [route, route.fallback]) {
        if (r?.model === 'gpt-6.1-terra') expect(r.rate).toEqual(terra)
      }
    }
  })
})

describe('rate schema', () => {
  test('a longPrompt tier needs the size it starts above', () => {
    const tier = { inputMultiplier: 5, outputMultiplier: 5 }
    const base = { inputPerM: 1, outputPerM: 5 }
    expect(rateSchema.safeParse({ ...base, longPrompt: tier }).success).toBe(false)
    expect(
      rateSchema.safeParse({
        ...base,
        longPrompt: tier,
        longPromptTokens: 100_000,
      }).success,
    ).toBe(true)
    expect(rateSchema.safeParse(base).success).toBe(true)
  })
})

describe('validateArm', () => {
  test('an empty arm, routes or params alone, and both are accepted and returned parsed', () => {
    expect(validateArm({})).toEqual({})
    expect(validateArm({ params: { finders: 3, voterMode: 'single' } })).toEqual({
      params: { finders: 3, voterMode: 'single' },
    })
    const arm = { routes: { check: { effort: 'low' } }, params: { finders: 5 } }
    expect(validateArm(arm)).toEqual(arm as never)
  })

  test('checks every patch, not only the first: an unknown id and a bad spec each throw, naming the id', () => {
    const unknown = () => validateArm({ routes: { check: { effort: 'low' }, 'no.such': { model: 'x' } } })
    expect(unknown).toThrow(RouteOverrideError)
    expect(unknown).toThrow('"no.such"')
    const bad = () => validateArm({ routes: { 'cheap.classify': { effort: 'low' }, decide: { effort: 'high' } } })
    expect(bad).toThrow(RouteOverrideError)
    expect(bad).toThrow('"decide"')
    expect(() => validateArm({ routes: { 'review.synthesis': { effort: 'none' } } })).toThrow(
      /review\.synthesis.*Sonnet/s,
    )
  })

  test('an arm with another key, or params that are not JSON, is refused', () => {
    expect(() => validateArm({ route: {} })).toThrow(RouteOverrideError)
    expect(() => validateArm({ params: { at: new Date() } })).toThrow(RouteOverrideError)
    expect(() => validateArm(null)).toThrow(RouteOverrideError)
  })

  test('a shape or value error carries no patch value', () => {
    for (const bad of [
      { check: { effort: 'leakysecret' } },
      { check: { colour: 'leakysecret' } },
      { check: 'leakysecret' },
      'leakysecret',
      ['leakysecret'],
    ]) {
      let message = ''
      try {
        validateArm({ routes: bad })
      } catch (error) {
        expect(error).toBeInstanceOf(RouteOverrideError)
        message = (error as Error).message
      }
      expect(message).not.toBe('')
      expect(message).not.toContain('leakysecret')
    }
  })
})

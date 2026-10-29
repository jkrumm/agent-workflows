import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { OVERRIDES_ENV, resolveRoute } from '@agent-workflows/routes'
import { createCapabilities } from './capabilities/index.ts'
import type { Usage } from './context.ts'
import { CapabilityCallError } from './errors.ts'
import { createRegistry } from './registry.ts'
import { type FakeIuServer, type RecordedRequest, sse, startFakeIu } from './testing/index.ts'
import { type Env, iuTransports } from './transports/index.ts'

// IU's body on an empty provider account, as it arrived 2026-10-28.
const BALANCE_503 = 'IU request failed (503) — Insufficient Balance (PaymentRequired) on Requesty-Global'
const USAGE = { prompt_tokens: 1_000, completion_tokens: 200, completion_tokens_details: { reasoning_tokens: 50 } }

let iu: FakeIuServer
let usages: Usage[]
let warnings: { message: string; meta: Record<string, unknown> }[]

beforeEach(() => {
  iu = startFakeIu()
  usages = []
  warnings = []
})
afterEach(() => iu.stop())

async function call(
  id: 'llm.classify' | 'llm.summarize' | 'review.adversary' | 'review.route',
  input: unknown,
  env: Env = {},
) {
  const transports = iuTransports({
    env: { IU_API_KEY: 'test-key', IU_BASE_URL: iu.baseUrl },
    backoffMs: 0,
    idleTimeoutMs: 200,
  })
  const warn = (message: string, meta: Record<string, unknown>) => void warnings.push({ message, meta })
  const registry = createRegistry(createCapabilities({ transports, env, warn }))
  return registry.call(id, input as never, { addUsage: (u) => usages.push(u) })
}

/** A chat stream that names the model it was asked for, as IU does. */
function answer(request: RecordedRequest, text: string, usage: Record<string, unknown> = USAGE): Response {
  return sse([
    { model: request.body.model, choices: [{ delta: { content: text } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
    { choices: [], usage },
  ])
}

const classify = { text: 'The app crashes on start.', labels: { bug: 'something is broken', feature: 'new behaviour' } }
const primary = resolveRoute('cheap.classify', {})
const fallback = primary.fallback as NonNullable<typeof primary.fallback>

const caught = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(CapabilityCallError)
  return error as CapabilityCallError
}

describe('provider-balance fallback', () => {
  for (const [name, failure] of [
    ['402', () => new Response('{"error":"payment required"}', { status: 402 })],
    ['503 Insufficient Balance', () => new Response(BALANCE_503, { status: 503 })],
  ] as const) {
    test(`${name} on the primary: one fallback call, no retry of the primary, priced, model recorded`, async () => {
      iu.on('chat', (request) =>
        request.body.model === primary.model ? failure() : answer(request, '{"label":"bug","reason":"crash"}'),
      )
      expect(await call('llm.classify', classify)).toEqual({ label: 'bug', reason: 'crash' })

      expect(iu.requests.map((r) => r.body.model)).toEqual([primary.model, fallback.model])
      expect(iu.requests[1]?.body).toMatchObject({
        reasoning_effort: fallback.effort,
        max_completion_tokens: fallback.maxOutputTokens,
      })
      // IU sent no cost: the fallback's rate prices it ($1/M in, $5/M out).
      expect(usages).toEqual([
        {
          model: fallback.model,
          tokens: { input: 1_000, output: 200, cacheRead: 0, reasoning: 50 },
          cost: (1_000 * 1 + 200 * 5) / 1_000_000,
          costSource: 'rate',
        },
      ])
      expect(warnings).toEqual([
        {
          message: 'provider balance exhausted; falling back',
          meta: { route: 'cheap.classify', from: primary.model, to: fallback.model },
        },
      ])
    })
  }

  test('a cost IU reports on the fallback wins over the rate', async () => {
    iu.on('chat', (request) =>
      request.body.model === primary.model
        ? new Response(BALANCE_503, { status: 503 })
        : answer(request, '{"label":"bug","reason":"r"}', { ...USAGE, cost: 0.0042 }),
    )
    await call('llm.classify', classify)
    expect(usages).toEqual([expect.objectContaining({ model: fallback.model, cost: 0.0042, costSource: 'provider' })])
  })

  test('a 503 without the balance text is retried on the primary as before; no fallback', async () => {
    iu.on('chat', () => new Response('Service Unavailable', { status: 503 }))
    const error = await caught(call('llm.classify', classify))
    expect(error).toMatchObject({ code: 'UPSTREAM_ERROR', data: { status: 503 } })
    expect(iu.requests.map((r) => r.body.model)).toEqual([primary.model, primary.model, primary.model])
    expect(warnings).toEqual([])
  })

  test('the fallback failing too answers the primary’s typed error', async () => {
    iu.on('chat', (request) =>
      request.body.model === primary.model
        ? new Response(BALANCE_503, { status: 503 })
        : new Response('{"error":"payment required"}', { status: 402 }),
    )
    const error = await caught(call('llm.classify', classify))
    expect(error).toMatchObject({ code: 'UPSTREAM_ERROR', data: { status: 503 } })
    expect(error.message).toContain('Insufficient Balance')
    expect(iu.requests.map((r) => r.body.model)).toEqual([primary.model, fallback.model])
    expect(warnings.map((w) => w.message)).toEqual([
      'provider balance exhausted; falling back',
      'fallback failed; the primary error stands',
    ])
  })

  test('a re-ask after a rejected answer stays on the fallback', async () => {
    let answers = 0
    iu.on('chat', (request) => {
      if (request.body.model === primary.model) return new Response('', { status: 402 })
      return answer(request, answers++ === 0 ? 'not json' : '{"label":"bug","reason":"r"}')
    })
    await call('llm.classify', classify)
    expect(iu.requests.map((r) => r.body.model)).toEqual([primary.model, fallback.model, fallback.model])
    expect(usages.map((u) => u.model)).toEqual([fallback.model, fallback.model])
  })

  test('an iu-anthropic route falls back over the chat wire', async () => {
    iu.on('messages', () => new Response(BALANCE_503, { status: 503 }))
    iu.on('chat', (request) => answer(request, 'A short summary.'))
    const out = await call('llm.summarize', { text: 'Some long text to summarize.' })
    expect(out).toMatchObject({ summary: 'A short summary.' })
    expect(iu.requests.map((r) => r.path)).toEqual(['/anthropic/v1/messages', '/openai/v1/chat/completions'])
    expect(usages).toEqual([expect.objectContaining({ model: resolveRoute('cheap.summarize', {}).fallback?.model })])
  })

  test('AGW_ROUTES overrides the fallback: its model and effort are what runs', async () => {
    const env = {
      [OVERRIDES_ENV]: JSON.stringify({ 'cheap.classify': { fallback: { model: 'other', effort: 'low' } } }),
    }
    iu.on('chat', (request) =>
      request.body.model === primary.model
        ? new Response('', { status: 402 })
        : answer(request, '{"label":"bug","reason":"r"}'),
    )
    await call('llm.classify', classify, env)
    expect(iu.requests[1]?.body).toMatchObject({ model: 'other', reasoning_effort: 'low' })
    // A new fallback model without a new rate drops the rate: unknown, never a stale price.
    expect(usages).toEqual([expect.objectContaining({ model: 'other', cost: null, costSource: 'unknown' })])
  })

  test('AGW_ROUTES fallback: null turns the fallback off', async () => {
    const env = { [OVERRIDES_ENV]: JSON.stringify({ 'cheap.classify': { fallback: null } }) }
    iu.on('chat', () => new Response('', { status: 402 }))
    await caught(call('llm.classify', classify, env))
    expect(iu.requests).toHaveLength(1)
  })
})

describe('provider-balance fallback: the review seats', () => {
  const adversary = resolveRoute('review.adversary', {})
  const adversaryFallback = adversary.fallback as NonNullable<typeof adversary.fallback>
  const finding = { severity: 'blocking', file: 'a.ts', line: 3, message: 'drops the last row' }

  for (const [name, failure] of [
    ['402', () => new Response('{"error":"payment required"}', { status: 402 })],
    ['503 Insufficient Balance', () => new Response(BALANCE_503, { status: 503 })],
  ] as const) {
    test(`review.adversary, ${name}: one fallback call, priced, model recorded`, async () => {
      iu.on('chat', (request) =>
        request.body.model === adversary.model ? failure() : answer(request, JSON.stringify({ findings: [finding] })),
      )
      const out = await call('review.adversary', { diff: '+added line' })
      expect(out).toMatchObject({ findings: [finding], model: adversaryFallback.model })
      expect(iu.requests.map((r) => r.body.model)).toEqual([adversary.model, adversaryFallback.model])
      // The fallback is Haiku, which the route sends no effort to: it runs at its own route's, not the adversary's.
      expect(iu.requests[1]?.body.reasoning_effort).toBeUndefined()
      expect(iu.requests[1]?.body.max_completion_tokens).toBe(adversaryFallback.maxOutputTokens)
      expect(usages).toEqual([
        {
          model: adversaryFallback.model,
          tokens: { input: 1_000, output: 200, cacheRead: 0, reasoning: 50 },
          cost: (1_000 * 0.1 + 200 * 0.5) / 1_000_000,
          costSource: 'rate',
        },
      ])
      expect(warnings.map((w) => w.meta)).toEqual([
        { route: 'review.adversary', from: adversary.model, to: adversaryFallback.model },
      ])
    })
  }

  test('review.adversary: the fallback runs at its own effort, its empty-answer re-ask too', async () => {
    const env = { [OVERRIDES_ENV]: JSON.stringify({ 'review.adversary': { fallback: { effort: 'high' } } }) }
    let answers = 0
    iu.on('chat', (request) => {
      if (request.body.model === adversary.model) return new Response(BALANCE_503, { status: 503 })
      return answer(request, answers++ === 0 ? '' : '{"findings":[]}')
    })
    await call('review.adversary', { diff: '+x' }, env)
    // medium and low are the adversary's efforts for its primary; the fallback keeps its route's.
    expect(iu.requests.map((r) => [r.body.model, r.body.reasoning_effort])).toEqual([
      [adversary.model, 'medium'],
      [adversaryFallback.model, 'high'],
      [adversaryFallback.model, 'high'],
    ])
  })

  test('review.adversary: a 503 without the balance text gets no fallback', async () => {
    iu.on('chat', () => new Response('Service Unavailable', { status: 503 }))
    await caught(call('review.adversary', { diff: '+x' }))
    expect(new Set(iu.requests.map((r) => r.body.model))).toEqual(new Set([adversary.model]))
  })

  test('review.route (review.router) falls back through completeJson', async () => {
    const router = resolveRoute('review.router', {})
    iu.on('chat', (request) =>
      request.body.model === router.model
        ? new Response('', { status: 402 })
        : answer(request, '{"angles":["security"],"depth":"deep"}'),
    )
    const out = await call('review.route', { diff: '+x' })
    expect(out).toMatchObject({ angles: ['security'], depth: 'deep' })
    expect(iu.requests.map((r) => r.body.model)).toEqual([router.model, router.fallback?.model])
    expect(usages).toEqual([expect.objectContaining({ model: router.fallback?.model, costSource: 'rate' })])
  })
})

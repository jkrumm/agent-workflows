import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { OVERRIDES_ENV, resolveRoute } from '@agent-workflows/routes'
import { createCapabilities } from './capabilities/index.ts'
import type { Usage } from './context.ts'
import { CapabilityCallError } from './errors.ts'
import { createRegistry } from './registry.ts'
import { type FakeGateway, type RecordedRequest, sse, startFakeGateway } from './testing/index.ts'
import { type Env, gatewayTransports } from './transports/index.ts'

// IU's body on an empty provider account, as it arrived 2026-10-28.
const BALANCE_503 = 'IU request failed (503) — Insufficient Balance (PaymentRequired) on Requesty-Global'
// Anthropic's refusal of a drained Console org (HTTP 400), padded so the sentence sits past failedResponse's 300-char cut.
const ANTHROPIC_400_PADDED = JSON.stringify({
  type: 'error',
  error: {
    type: 'invalid_request_error',
    padding: 'x'.repeat(320),
    message:
      'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.',
  },
})
const USAGE = { prompt_tokens: 1_000, completion_tokens: 200, completion_tokens_details: { reasoning_tokens: 50 } }

let iu: FakeGateway
let usages: Usage[]
let warnings: { message: string; meta: Record<string, unknown> }[]

beforeEach(() => {
  iu = startFakeGateway()
  usages = []
  warnings = []
})
afterEach(() => iu.stop())

async function call(
  id: 'llm.classify' | 'llm.summarize' | 'review.adversary' | 'review.route',
  input: unknown,
  env: Env = {},
) {
  const transports = gatewayTransports({
    env: { AGW_API_SECRET: 'test-key', AGW_GATEWAY_URL: iu.url },
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
    // failedResponse cuts the body to 300 chars: the marker, not the sentence, carries the 400 through isBalanceError.
    [
      '400 Anthropic credit balance (sentence past char 300)',
      () => new Response(ANTHROPIC_400_PADDED, { status: 400 }),
    ],
  ] as const) {
    test(`${name} on the primary: one fallback call, no retry of the primary, priced, model recorded`, async () => {
      iu.on('messages', failure)
      iu.on('chat', (request) => answer(request, '{"label":"bug","reason":"crash"}'))
      expect(await call('llm.classify', classify)).toEqual({ label: 'bug', reason: 'crash' })

      expect(iu.requests.map((r) => [r.path, r.body.model])).toEqual([
        ['/anthropic/v1/messages', primary.model],
        ['/openai/v1/chat/completions', fallback.model],
      ])
      expect(iu.requests[0]?.headers.get('x-agw-fallback')).toBe('none')
      expect(iu.requests[1]?.body).toMatchObject({
        reasoning_effort: fallback.effort,
        max_completion_tokens: fallback.maxOutputTokens,
      })
      // IU sent no cost: the fallback's rate prices it.
      expect(usages).toEqual([
        {
          model: fallback.model,
          tokens: { input: 1_000, output: 200, cacheRead: 0, reasoning: 50 },
          cost: (1_000 * fallback.rate!.inputPerM + 200 * fallback.rate!.outputPerM) / 1_000_000,
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

  test('a 400 without the Anthropic sentence gets no fallback', async () => {
    iu.on(
      'messages',
      () => new Response('{"error":{"type":"invalid_request_error","message":"max_tokens: bad"}}', { status: 400 }),
    )
    const error = await caught(call('llm.classify', classify))
    expect(error).toMatchObject({ code: 'UPSTREAM_ERROR', data: { status: 400 } })
    expect(iu.requests.map((r) => r.body.model)).toEqual([primary.model])
  })

  test('a cost IU reports on the fallback wins over the rate', async () => {
    iu.on('messages', () => new Response(BALANCE_503, { status: 503 }))
    iu.on('chat', (request) => answer(request, '{"label":"bug","reason":"r"}', { ...USAGE, cost: 0.0042 }))
    await call('llm.classify', classify)
    expect(usages).toEqual([expect.objectContaining({ model: fallback.model, cost: 0.0042, costSource: 'provider' })])
  })

  test('a 503 without the balance text is retried on the primary as before; no fallback', async () => {
    iu.on('messages', () => new Response('Service Unavailable', { status: 503 }))
    const error = await caught(call('llm.classify', classify))
    expect(error).toMatchObject({ code: 'UPSTREAM_ERROR', data: { status: 503 } })
    expect(iu.requests.map((r) => r.body.model)).toEqual([primary.model, primary.model, primary.model])
    expect(warnings).toEqual([])
  })

  test('the fallback failing too answers the primary’s typed error', async () => {
    iu.on('messages', () => new Response(BALANCE_503, { status: 503 }))
    iu.on('chat', () => new Response('{"error":"payment required"}', { status: 402 }))
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
    iu.on('messages', () => new Response('', { status: 402 }))
    iu.on('chat', (request) => answer(request, answers++ === 0 ? 'not json' : '{"label":"bug","reason":"r"}'))
    await call('llm.classify', classify)
    expect(iu.requests.map((r) => r.body.model)).toEqual([primary.model, fallback.model, fallback.model])
    expect(usages.map((u) => u.model)).toEqual([fallback.model, fallback.model])
  })

  test('a second single-call route (llm.summarize) falls back to its own seat’s GPT model over the chat wire', async () => {
    const summarize = resolveRoute('cheap.summarize', {})
    // EASY routes fall back to Terra low; the TRIVIAL classify above falls back to Luna.
    expect(summarize.wire).toBe('anthropic')
    expect(summarize.fallback).toMatchObject({ wire: 'iu-openai', effort: 'low' })
    expect(summarize.fallback?.model).not.toBe(fallback.model)
    iu.on('messages', () => new Response(BALANCE_503, { status: 503 }))
    iu.on('chat', (request) => answer(request, 'A short summary.'))
    const out = await call('llm.summarize', { text: 'Some long text to summarize.' })
    expect(out).toMatchObject({ summary: 'A short summary.' })
    expect(iu.requests.map((r) => [r.path, r.body.model])).toEqual([
      ['/anthropic/v1/messages', summarize.model],
      ['/openai/v1/chat/completions', summarize.fallback?.model],
    ])
    expect(iu.requests[1]?.body).toMatchObject({ reasoning_effort: summarize.fallback?.effort })
    expect(usages).toEqual([expect.objectContaining({ model: summarize.fallback?.model })])
  })

  test('AGW_ROUTES overrides the fallback: its model and effort are what runs', async () => {
    const env = {
      [OVERRIDES_ENV]: JSON.stringify({ 'cheap.classify': { fallback: { model: 'other', effort: 'low' } } }),
    }
    iu.on('messages', () => new Response('', { status: 402 }))
    iu.on('chat', (request) => answer(request, '{"label":"bug","reason":"r"}'))
    await call('llm.classify', classify, env)
    expect(iu.requests[1]?.body).toMatchObject({ model: 'other', reasoning_effort: 'low' })
    // A new fallback model without a new rate drops the rate: unknown, never a stale price.
    expect(usages).toEqual([expect.objectContaining({ model: 'other', cost: null, costSource: 'unknown' })])
  })

  test('AGW_ROUTES fallback: null turns the fallback off', async () => {
    const env = { [OVERRIDES_ENV]: JSON.stringify({ 'cheap.classify': { fallback: null } }) }
    iu.on('messages', () => new Response('', { status: 402 }))
    await caught(call('llm.classify', classify, env))
    expect(iu.requests).toHaveLength(1)
  })
})

describe('provider-balance fallback: the gateway refuses the Claude credit', () => {
  // The gateway's answer to `x-agw-fallback: none` with no credit pool eligible (`packages/gateway/src/proxy.ts`).
  const GATEWAY_402 = {
    type: 'error',
    error: { type: 'balance_error', message: 'provider balance exhausted: no credit pool eligible' },
  }

  test('a 402 moves the call to the route fallback on GPT, never IU Claude; only the anthropic call opts out', async () => {
    iu.on('messages', () => Response.json(GATEWAY_402, { status: 402, headers: { 'x-agw-pool': 'refused' } }))
    iu.on('chat', (request) => answer(request, '{"label":"bug","reason":"fine"}'))
    const done = await call('llm.classify', classify)

    expect(done).toEqual({ label: 'bug', reason: 'fine' })
    expect(iu.requests.map((r) => [r.path, r.body.model])).toEqual([
      ['/anthropic/v1/messages', primary.model],
      ['/openai/v1/chat/completions', fallback.model],
    ])
    expect(iu.requests[0]?.headers.get('x-agw-fallback')).toBe('none')
    expect(iu.requests[1]?.headers.get('x-agw-fallback')).toBeNull()
    expect(warnings.map((w) => w.message)).toEqual(['provider balance exhausted; falling back'])
    // The refusal threw before any usage came back: only the fallback is reported.
    expect(usages.map((u) => u.model)).toEqual([fallback.model])
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
      // The fallback runs at its own route's effort, not the adversary's.
      expect(iu.requests[0]?.body.reasoning_effort).toBe('medium')
      expect(iu.requests[1]?.body.reasoning_effort).toBe(adversaryFallback.effort)
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
    const env = { [OVERRIDES_ENV]: JSON.stringify({ 'review.adversary': { fallback: { effort: 'low' } } }) }
    let answers = 0
    iu.on('chat', (request) => {
      if (request.body.model === adversary.model) return new Response(BALANCE_503, { status: 503 })
      return answer(request, answers++ === 0 ? '' : '{"findings":[]}')
    })
    await call('review.adversary', { diff: '+x' }, env)
    // medium is the adversary's effort for its primary; the fallback keeps its route's (overridden to low).
    expect(iu.requests.map((r) => [r.body.model, r.body.reasoning_effort])).toEqual([
      [adversary.model, 'medium'],
      [adversaryFallback.model, 'low'],
      [adversaryFallback.model, 'low'],
    ])
  })

  test('review.adversary: a 503 without the balance text gets no fallback', async () => {
    iu.on('chat', () => new Response('Service Unavailable', { status: 503 }))
    await caught(call('review.adversary', { diff: '+x' }))
    expect(new Set(iu.requests.map((r) => r.body.model))).toEqual(new Set([adversary.model]))
  })

  test('review.route (review.router) falls back through completeJson', async () => {
    const router = resolveRoute('review.router', {})
    iu.on('messages', () => new Response('', { status: 402 }))
    iu.on('chat', (request) => answer(request, '{"angles":["security"],"depth":"deep"}'))
    const out = await call('review.route', { diff: '+x' })
    expect(out).toMatchObject({ angles: ['security'], depth: 'deep' })
    expect(iu.requests.map((r) => [r.path, r.body.model])).toEqual([
      ['/anthropic/v1/messages', router.model],
      ['/openai/v1/chat/completions', router.fallback?.model],
    ])
    expect(usages).toEqual([expect.objectContaining({ model: router.fallback?.model, costSource: 'rate' })])
  })
})

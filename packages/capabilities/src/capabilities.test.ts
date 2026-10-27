import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { resolveRoute } from '@agent-workflows/routes'
import { createCapabilities } from './capabilities/index.ts'
import type { Usage } from './context.ts'
import { CapabilityCallError } from './errors.ts'
import { complete } from './llm/model-call.ts'
import { createRegistry } from './registry.ts'
import { chatStream, type FakeIuServer, messageResponse, sse, startFakeIu } from './testing/index.ts'
import { type Env, iuTransports } from './transports/index.ts'

let iu: FakeIuServer
let usages: Usage[]

beforeEach(() => {
  iu = startFakeIu()
  usages = []
})
afterEach(() => iu.stop())

function registry(env: Env = {}) {
  const transports = iuTransports({
    env: { IU_API_KEY: 'test-key', IU_BASE_URL: iu.baseUrl },
    backoffMs: 0,
    idleTimeoutMs: 200,
  })
  return createRegistry(createCapabilities({ transports, env }))
}
const call = <Id extends 'llm.summarize' | 'llm.title' | 'llm.classify' | 'decide'>(
  id: Id,
  input: Parameters<ReturnType<typeof registry>['call']>[1],
  env?: Env,
) => registry(env).call(id, input as never, { addUsage: (u) => usages.push(u) })

const caught = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(CapabilityCallError)
  return error as CapabilityCallError
}

describe('llm.summarize (iu-anthropic)', () => {
  test('summarizes over the Messages wire; usage is raw, cost unknown when the provider omits it', async () => {
    iu.on('messages', () =>
      messageResponse('  The gist.  ', {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 40,
        cache_creation_input_tokens: 10,
      }),
    )
    const out = await call('llm.summarize', { text: 'A long text.', format: 'bullets', maxWords: 30 })
    expect(out).toEqual({ summary: 'The gist.' })

    const route = resolveRoute('cheap.summarize', {})
    const [request] = iu.requests
    expect(request?.path).toBe('/anthropic/v1/messages')
    expect(request?.headers.get('authorization')).toBe('Bearer test-key')
    expect(request?.headers.get('anthropic-version')).toBe('2023-06-01')
    expect(request?.body.model).toBe(route.model)
    expect(request?.body.thinking).toBeUndefined()
    expect(JSON.stringify(request?.body.messages)).toContain('a short bullet list')
    expect(JSON.stringify(request?.body.messages)).toContain('at most 30 words')

    expect(usages).toEqual([
      {
        model: 'fake',
        tokens: { input: 150, output: 20, cacheRead: 40, reasoning: 0 },
        cost: null,
        costSource: 'unknown',
      },
    ])
  })

  test('a cost the provider reports wins', async () => {
    iu.on('messages', () => messageResponse('x', { input_tokens: 1, output_tokens: 1, cost: 0.0042 }))
    await call('llm.summarize', { text: 'x' })
    expect(usages[0]).toMatchObject({ cost: 0.0042, costSource: 'provider' })
  })

  test('a route rate prices the call when the provider reports none', async () => {
    iu.on('messages', () => messageResponse('x', { input_tokens: 1000, output_tokens: 200 }))
    const env = { AGW_ROUTES: '{"cheap.summarize":{"rate":{"inputPerM":1,"outputPerM":5}}}' }
    await call('llm.summarize', { text: 'x' }, env)
    expect(usages[0]).toMatchObject({ cost: (1000 * 1 + 200 * 5) / 1_000_000, costSource: 'rate' })
  })

  test('a route with effort turns thinking on and gets room for it', async () => {
    iu.on('messages', () => messageResponse('x', null))
    await call('llm.summarize', { text: 'x' }, { AGW_ROUTES: '{"cheap.summarize":{"effort":"high"}}' })
    expect(iu.requests[0]?.body).toMatchObject({
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      max_tokens: 32_000,
    })
    expect(usages[0]).toMatchObject({ tokens: { input: 0, output: 0 }, costSource: 'unknown' })
  })

  test('max_tokens with no text is starved, with text is truncated; both bill', async () => {
    iu.on('messages', () => messageResponse('', { input_tokens: 9, output_tokens: 8192 }, 'max_tokens'))
    expect(await caught(call('llm.summarize', { text: 'x' }))).toMatchObject({
      code: 'OUTPUT_TRUNCATED',
      data: { reason: 'starved' },
    })
    iu.on('messages', () => messageResponse('half an ans', { input_tokens: 9, output_tokens: 8192 }, 'max_tokens'))
    expect(await caught(call('llm.summarize', { text: 'x' }))).toMatchObject({ data: { reason: 'truncated' } })
    expect(usages).toHaveLength(2)
  })

  test('a refusal is an upstream error, not an answer', async () => {
    iu.on('messages', () => messageResponse('I cannot', { input_tokens: 1, output_tokens: 1 }, 'refusal'))
    const error = await caught(call('llm.summarize', { text: 'x' }))
    expect(error).toMatchObject({ code: 'UPSTREAM_ERROR' })
    expect(error.message).toContain('refusal')
  })
})

describe('llm.title (iu-anthropic)', () => {
  test('cleans the model’s decoration', async () => {
    iu.on('messages', () => messageResponse('# Title: "Shipping the Registry."\nbecause reasons', null))
    expect(await call('llm.title', { text: 'x' })).toEqual({ title: 'Shipping the Registry' })
  })

  test('a title keeps its own apostrophes and only loses wrapping quotes', async () => {
    iu.on('messages', () => messageResponse("Users' Guide to the Dogs'", null))
    expect(await call('llm.title', { text: 'x' })).toEqual({ title: "Users' Guide to the Dogs'" })
    iu.on('messages', () => messageResponse('"Quoted."', null))
    expect(await call('llm.title', { text: 'x' })).toEqual({ title: 'Quoted' })
  })

  test('an answer that is nothing after cleanup is INVALID_OUTPUT', async () => {
    iu.on('messages', () => messageResponse('""', null))
    expect(await caught(call('llm.title', { text: 'x' }))).toMatchObject({ code: 'INVALID_OUTPUT' })
  })
})

const labels = { bug: 'something is broken', feature: 'a request for new behaviour' }
const classifyUsage = {
  prompt_tokens: 200,
  completion_tokens: 30,
  prompt_tokens_details: { cached_tokens: 50 },
  completion_tokens_details: { reasoning_tokens: 10 },
}

describe('llm.classify (iu-openai)', () => {
  test('classifies over the chat wire; the provider’s cost wins; counts are raw', async () => {
    iu.on('chat', () => chatStream('{"label":"bug","reason":"It crashes."}', { ...classifyUsage, cost: 0.00031 }))
    const out = await call('llm.classify', { text: 'The app crashes on start.', labels })
    expect(out).toEqual({ label: 'bug', reason: 'It crashes.' })

    const route = resolveRoute('cheap.classify', {})
    const [request] = iu.requests
    expect(request?.path).toBe('/openai/v1/chat/completions')
    expect(request?.body).toMatchObject({
      model: route.model,
      max_completion_tokens: route.maxOutputTokens,
      response_format: { type: 'json_object' },
      stream: true,
      stream_options: { include_usage: true },
    })
    expect(request?.body.reasoning_effort).toBeUndefined()
    expect(request?.body.temperature).toBeUndefined()
    const prompt = JSON.stringify(request?.body.messages)
    expect(prompt).toContain('- bug: something is broken')
    expect(prompt).toContain('The app crashes on start.')

    expect(usages).toEqual([
      {
        model: 'fake',
        tokens: { input: 200, output: 30, cacheRead: 50, reasoning: 10 },
        cost: 0.00031,
        costSource: 'provider',
      },
    ])
  })

  test('cost is unknown, not 0, when the provider omits it and the route has no rate', async () => {
    iu.on('chat', () => chatStream('{"label":"bug","reason":"r"}', classifyUsage))
    await call('llm.classify', { text: 'x', labels })
    expect(usages[0]).toMatchObject({ cost: null, costSource: 'unknown' })
  })

  test('a reported cost of 0 stays 0', async () => {
    iu.on('chat', () => chatStream('{"label":"bug","reason":"r"}', { ...classifyUsage, cost: 0 }))
    await call('llm.classify', { text: 'x', labels })
    expect(usages[0]).toMatchObject({ cost: 0, costSource: 'provider' })
  })

  test('a label outside the set is re-asked once with the reason; both attempts bill', async () => {
    iu.on('chat', (_, attempt) =>
      attempt === 0
        ? chatStream('{"label":"question","reason":"r"}', classifyUsage)
        : chatStream('```json\n{"label":"feature","reason":"It asks for something."}\n```', classifyUsage),
    )
    const out = await call('llm.classify', { text: 'Please add dark mode.', labels })
    expect(out).toEqual({ label: 'feature', reason: 'It asks for something.' })
    expect(iu.requests).toHaveLength(2)
    const retry = JSON.stringify(iu.requests[1]?.body.messages)
    expect(retry).toContain('RETRY')
    expect(retry).toContain('the JSON did not match the schema')
    expect(retry).toContain('question')
    expect(usages).toHaveLength(2)
  })

  test('a long reason is not a reason to throw the label away', async () => {
    iu.on('chat', () => chatStream(JSON.stringify({ label: 'bug', reason: 'r'.repeat(900) }), classifyUsage))
    expect(await call('llm.classify', { text: 'x', labels })).toMatchObject({ label: 'bug' })
    expect(iu.requests).toHaveLength(1)
  })

  test('a cut stream bills each attempt through addUsage and fails as UPSTREAM_ERROR', async () => {
    iu.on('chat', () =>
      sse([{ choices: [{ delta: { content: '{"label":' } }] }, { choices: [], usage: classifyUsage }]),
    )
    expect(await caught(call('llm.classify', { text: 'x', labels }))).toMatchObject({ code: 'UPSTREAM_ERROR' })
    expect(usages).toHaveLength(3)
    expect(usages[0]).toMatchObject({ tokens: { input: 200, output: 30, cacheRead: 50, reasoning: 10 } })
  })

  test('prose around the object is tolerated', async () => {
    iu.on('chat', () => chatStream('Sure! {"label":"bug","reason":"r"} Hope that helps.', classifyUsage))
    expect(await call('llm.classify', { text: 'x', labels })).toMatchObject({ label: 'bug' })
    expect(iu.requests).toHaveLength(1)
  })

  test('unparseable twice is INVALID_OUTPUT with the attempts, and no third call', async () => {
    iu.on('chat', () => chatStream('I think it is a bug.', classifyUsage))
    const error = await caught(call('llm.classify', { text: 'x', labels }))
    expect(error).toMatchObject({ code: 'INVALID_OUTPUT', status: 502, defined: true, data: { attempts: 2 } })
    expect(iu.requests).toHaveLength(2)
    expect(usages).toHaveLength(2)
  })

  test('reasoning that eats the ceiling is starved, and it still bills', async () => {
    iu.on('chat', () => chatStream('', classifyUsage, 'length'))
    expect(await caught(call('llm.classify', { text: 'x', labels }))).toMatchObject({
      code: 'OUTPUT_TRUNCATED',
      data: { reason: 'starved' },
    })
    expect(iu.requests).toHaveLength(1)
    expect(usages).toHaveLength(1)
  })

  test('fewer than two labels is a bad request', async () => {
    expect(await caught(call('llm.classify', { text: 'x', labels: { only: 'one' } }))).toMatchObject({
      code: 'BAD_REQUEST',
    })
    expect(iu.requests).toHaveLength(0)
  })
})

const questions = {
  action: { type: 'choice', instructions: 'What to do?', options: { attach: 'a duplicate', new: 'fresh' } },
  dup: { type: 'boolean', instructions: 'Is it a duplicate?' },
} as const

const WIRE = {
  model: 'fake-decider',
  answers: {
    action: { type: 'choice', choice: 'attach', confidence: 0.9, probabilities: { attach: 0.8, new: 0.2 } },
    dup: { type: 'noul', noul: 0.3 },
  },
  usage: { input_tokens: 100, output_tokens: 10 },
}

describe('decide (iu-decision)', () => {
  test('sends choice as criteria and boolean as noul; maps answers; the route’s rate prices it', async () => {
    iu.on('decide', () => Response.json(WIRE))
    const out = await call('decide', { state: 'The state.', questions })

    const route = resolveRoute('decide', {})
    expect(iu.requests[0]?.path).toBe('/decisions/v1/systemone')
    expect(iu.requests[0]?.body).toEqual({
      model: route.model,
      state: 'The state.',
      questions: {
        action: { type: 'choice', instructions: 'What to do?', criteria: { attach: 'a duplicate', new: 'fresh' } },
        dup: { type: 'noul', instructions: 'Is it a duplicate?' },
      },
    })
    expect(out).toEqual({
      answers: {
        action: { type: 'choice', choice: 'attach', confidence: 0.9, probabilities: { attach: 0.8, new: 0.2 } },
        dup: { type: 'boolean', value: false, confidence: 0.7, probability: 0.3 },
      },
      model: 'fake-decider',
      truncatedChars: 0,
    })
    const rate = route.rate
    expect(usages).toEqual([
      {
        model: 'fake-decider',
        tokens: { input: 100, output: 10, cacheRead: 0, reasoning: 0 },
        cost: (100 * (rate?.inputPerM ?? 0) + 10 * (rate?.outputPerM ?? 0)) / 1_000_000,
        costSource: 'rate',
      },
    ])
  })

  test('without a rate the decision cost is unknown', async () => {
    iu.on('decide', () => Response.json(WIRE))
    await call('decide', { state: 's', questions }, { AGW_ROUTES: '{"decide":{"rate":null}}' })
    expect(usages[0]).toMatchObject({ cost: null, costSource: 'unknown' })
  })

  test('a choice without a reported confidence falls back to its probability', async () => {
    iu.on('decide', () =>
      Response.json({
        answers: { action: { type: 'choice', choice: 'attach', probabilities: { attach: 0.7, new: 0.3 } } },
        usage: { input_tokens: 7, output_tokens: 1 },
      }),
    )
    const out = await call('decide', { state: 's', questions: { action: questions.action } })
    expect(out.answers.action).toMatchObject({ choice: 'attach', confidence: 0.7 })
  })

  test('caps the state and reports what was cut', async () => {
    iu.on('decide', () => Response.json(WIRE))
    const out = await call('decide', { state: 'x'.repeat(60_050), questions })
    expect(out.truncatedChars).toBe(50)
    expect(iu.requests[0]?.body.state).toHaveLength(60_000)
  })

  test('the state is never cut inside a surrogate pair', async () => {
    iu.on('decide', () => Response.json(WIRE))
    const state = `${'x'.repeat(59_999)}😀tail`
    const out = await call('decide', { state, questions })
    expect(out.truncatedChars).toBe(state.length - 59_999)
    expect(iu.requests[0]?.body.state).toBe('x'.repeat(59_999))
  })

  test('an answer outside the options, or a missing one, is INVALID_OUTPUT, and the call still bills', async () => {
    iu.on('decide', () =>
      Response.json({
        ...WIRE,
        answers: { ...WIRE.answers, action: { type: 'choice', choice: 'merge', probabilities: {} } },
      }),
    )
    expect(await caught(call('decide', { state: 's', questions }))).toMatchObject({ code: 'INVALID_OUTPUT' })
    iu.on('decide', () => Response.json({ ...WIRE, answers: { dup: WIRE.answers.dup } }))
    expect(await caught(call('decide', { state: 's', questions }))).toMatchObject({ code: 'INVALID_OUTPUT' })
    expect(usages).toHaveLength(2)
  })

  test('a probability outside 0..1 is INVALID_OUTPUT, and the call still bills', async () => {
    iu.on('decide', () => Response.json({ ...WIRE, answers: { ...WIRE.answers, dup: { type: 'noul', noul: 1.3 } } }))
    expect(await caught(call('decide', { state: 's', questions }))).toMatchObject({ code: 'INVALID_OUTPUT' })
    iu.on('decide', () =>
      Response.json({
        ...WIRE,
        answers: {
          ...WIRE.answers,
          action: { type: 'choice', choice: 'attach', probabilities: { attach: 0.8, new: -0.2 } },
        },
      }),
    )
    expect(await caught(call('decide', { state: 's', questions }))).toMatchObject({ code: 'INVALID_OUTPUT' })
    expect(usages).toHaveLength(2)
  })

  test('malformed questions are bad requests; nothing is sent', async () => {
    const one = { type: 'choice', instructions: 'i', options: { a: 'x' } } as const
    expect(await caught(call('decide', { state: 's', questions: { q: one } }))).toMatchObject({ code: 'BAD_REQUEST' })
    expect(await caught(call('decide', { state: 's', questions: {} }))).toMatchObject({ code: 'BAD_REQUEST' })
    expect(iu.requests).toHaveLength(0)
  })
})

describe('configuration', () => {
  test('missing credentials are NOT_CONFIGURED and name the variable, not a value', async () => {
    const transports = iuTransports({ env: {} })
    const r = createRegistry(createCapabilities({ transports, env: {} }))
    const error = await caught(r.call('llm.title', { text: 'x' }))
    expect(error).toMatchObject({ code: 'NOT_CONFIGURED', status: 503 })
    expect(error.message).toContain('IU_API_KEY')
  })

  test('a base URL that does not end in /anthropic is rejected without echoing it', async () => {
    const transports = iuTransports({ env: { IU_API_KEY: 'k', IU_BASE_URL: 'https://secret-host.invalid/v1' } })
    const r = createRegistry(createCapabilities({ transports, env: {} }))
    const error = await caught(r.call('llm.title', { text: 'x' }))
    expect(error.code).toBe('NOT_CONFIGURED')
    expect(error.message).not.toContain('secret-host')
  })

  test('a bad route override is NOT_CONFIGURED', async () => {
    const error = await caught(call('llm.title', { text: 'x' }, { AGW_ROUTES: '{nope' }))
    expect(error).toMatchObject({ code: 'NOT_CONFIGURED' })
  })

  test('a route on a wire that is not a single call is NOT_CONFIGURED', async () => {
    const deps = { transports: iuTransports({ env: { IU_API_KEY: 'k', IU_BASE_URL: iu.baseUrl } }), env: {} }
    const ctx = { signal: new AbortController().signal, addUsage: () => {} }
    const error = await complete(deps, { routeId: 'check', prompt: 'x', ctx }).catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'NOT_CONFIGURED' })
    expect(iu.requests).toHaveLength(0)
  })
})

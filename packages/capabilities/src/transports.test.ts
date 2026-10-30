import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { CapabilityError } from './errors.ts'
import { chatStream, type FakeIuServer, messageResponse, sse, startFakeIu } from './testing/index.ts'
import { iuAnthropic, iuDecision, iuOpenai } from './transports/index.ts'

let iu: FakeIuServer
beforeEach(() => {
  iu = startFakeIu()
})
afterEach(() => iu.stop())

const env = () => ({ IU_API_KEY: 'test-key', IU_BASE_URL: iu.baseUrl })
const chatRequest = { model: 'm', prompt: 'p', maxOutputTokens: 100 }
const never = () => new AbortController().signal

async function failure(promise: Promise<unknown>): Promise<CapabilityError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(CapabilityError)
  return error as CapabilityError
}

describe('retries', () => {
  test('429 and 5xx are retried with backoff, then succeed', async () => {
    iu.on('messages', (_, attempt) =>
      attempt < 2
        ? new Response('busy', { status: 503 })
        : messageResponse('ok', { input_tokens: 1, output_tokens: 1 }),
    )
    const port = iuAnthropic({ env: env(), backoffMs: 1 })
    expect((await port.complete(chatRequest, never())).text).toBe('ok')
    expect(iu.requests).toHaveLength(3)
  })

  test('gives up after the attempts and reports the last status', async () => {
    iu.on('chat', () => new Response('nope', { status: 502 }))
    const error = await failure(iuOpenai({ env: env(), backoffMs: 0 }).complete(chatRequest, never()))
    expect(error).toMatchObject({ code: 'UPSTREAM_ERROR', data: { status: 502 } })
    expect(iu.requests).toHaveLength(3)
  })

  test('a 400 and a 410 fail fast', async () => {
    iu.on('decide', () => new Response('bad question', { status: 400 }))
    const request = { model: 'm', state: 's', questions: { q: { type: 'boolean', instructions: 'i' } } } as const
    expect(await failure(iuDecision({ env: env(), backoffMs: 0 }).decide(request, never()))).toMatchObject({
      data: { status: 400 },
    })
    expect(iu.requests).toHaveLength(1)

    iu.on('messages', () => new Response('gone', { status: 410 }))
    const gone = await failure(iuAnthropic({ env: env(), backoffMs: 0 }).complete(chatRequest, never()))
    expect(gone.message).toContain('model deprecated (410)')
    expect(iu.requests).toHaveLength(2)
  })

  test('a 503 that wraps an upstream invalid_request_error is a client error: no retry', async () => {
    iu.on('chat', () => new Response('{"error":{"type":"invalid_request_error"}}', { status: 503 }))
    await failure(iuOpenai({ env: env(), backoffMs: 0 }).complete(chatRequest, never()))
    expect(iu.requests).toHaveLength(1)
  })

  test('a connection error is retried, then reported', async () => {
    let calls = 0
    const port = iuOpenai({
      env: env(),
      backoffMs: 0,
      fetch: () => {
        calls++
        return Promise.reject(new Error('ECONNRESET'))
      },
    })
    const error = await failure(port.complete(chatRequest, never()))
    expect(error.message).toContain('ECONNRESET')
    expect(calls).toBe(3)
  })
})

describe('cancel and idle', () => {
  test('an aborted signal is CANCELLED and stops the retry loop', async () => {
    const controller = new AbortController()
    iu.on('messages', () => {
      controller.abort()
      return new Response('busy', { status: 503 })
    })
    const error = await failure(iuAnthropic({ env: env(), backoffMs: 0 }).complete(chatRequest, controller.signal))
    expect(error.code).toBe('CANCELLED')
    expect(iu.requests).toHaveLength(1)
  })

  test('a cancel during the backoff is reported at once', async () => {
    const controller = new AbortController()
    iu.on('messages', () => {
      setTimeout(() => controller.abort(), 20)
      return new Response('busy', { status: 503 })
    })
    const started = performance.now()
    const error = await failure(iuAnthropic({ env: env(), backoffMs: 5_000 }).complete(chatRequest, controller.signal))
    expect(error.code).toBe('CANCELLED')
    expect(performance.now() - started).toBeLessThan(1_000)
  })

  test('a stream that goes silent is aborted by the idle watchdog, and not retried', async () => {
    iu.on('chat', () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'))
        },
      })
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
    })
    const started = performance.now()
    const error = await failure(
      iuOpenai({ env: env(), backoffMs: 0, idleTimeoutMs: 100 }).complete(chatRequest, never()),
    )
    expect(error.message).toContain('idle')
    expect(iu.requests).toHaveLength(1)
    expect(performance.now() - started).toBeLessThan(2000)
  })

  test('a stream that keeps producing is never cut, however long it takes', async () => {
    iu.on('chat', () => {
      const encoder = new TextEncoder()
      const stream = new ReadableStream({
        async start(controller) {
          for (const part of ['a', 'b', 'c']) {
            controller.enqueue(encoder.encode(`data: {"choices":[{"delta":{"content":"${part}"}}]}\n\n`))
            await Bun.sleep(80)
          }
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'))
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          controller.close()
        },
      })
      return new Response(stream)
    })
    const result = await iuOpenai({ env: env(), idleTimeoutMs: 150 }).complete(chatRequest, never())
    expect(result.text).toBe('abc')
  })
})

describe('openai wire details', () => {
  test('the system prompt, effort and JSON mode go on the wire only when asked for', async () => {
    iu.on('chat', () => chatStream('ok', null))
    const port = iuOpenai({ env: env() })
    await port.complete({ ...chatRequest, system: 'be brief', effort: 'high', json: true }, never())
    await port.complete(chatRequest, never())
    expect(iu.requests[0]?.body).toMatchObject({
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'p' },
      ],
      reasoning_effort: 'high',
      response_format: { type: 'json_object' },
      max_completion_tokens: 100,
    })
    expect(iu.requests[1]?.body.reasoning_effort).toBeUndefined()
    expect(iu.requests[1]?.body.response_format).toBeUndefined()
  })

  test('no usage chunk reports nothing; a usage chunk reports raw counts once', async () => {
    const reported: unknown[] = []
    iu.on('chat', () => chatStream('ok', null))
    const port = iuOpenai({ env: env() })
    const result = await port.complete(chatRequest, never(), (u) => reported.push(u))
    expect(result).toMatchObject({ text: 'ok', stop: 'complete' })
    expect(reported).toEqual([])

    iu.on('chat', () => chatStream('ok', { prompt_tokens: 7, completion_tokens: 3, cost: 0.5 }))
    await port.complete(chatRequest, never(), (u) => reported.push(u))
    expect(reported).toEqual([
      { model: 'fake', tokens: { input: 7, output: 3, cacheRead: 0, reasoning: 0 }, cost: 0.5 },
    ])
  })

  test('effort none is not sent as reasoning_effort, like the Messages wire', async () => {
    iu.on('chat', () => chatStream('ok', null))
    iu.on('messages', () => messageResponse('ok', null))
    await iuOpenai({ env: env() }).complete({ ...chatRequest, effort: 'none' }, never())
    await iuAnthropic({ env: env() }).complete({ ...chatRequest, effort: 'none' }, never())
    expect(iu.requests[0]?.body.reasoning_effort).toBeUndefined()
    expect(iu.requests[1]?.body.thinking).toBeUndefined()
  })

  test('a stream cut before its finish chunk is retried, not returned as a complete answer', async () => {
    iu.on('chat', () => new Response('data: {"choices":[{"delta":{"content":"half an"}}]}\n\n'))
    const error = await failure(iuOpenai({ env: env(), backoffMs: 0 }).complete(chatRequest, never()))
    expect(error.message).toContain('without a finish reason')
    expect(iu.requests).toHaveLength(3)
  })

  test('a malformed chunk is retried, then reported', async () => {
    iu.on('chat', () => new Response('data: {oops\n\n'))
    const error = await failure(iuOpenai({ env: env(), backoffMs: 0 }).complete(chatRequest, never()))
    expect(error.message).toContain('malformed')
    expect(iu.requests).toHaveLength(3)
  })
})

describe('messages wire details', () => {
  test('effort turns adaptive thinking on and rides in output_config; max_tokens is the request ceiling', async () => {
    iu.on('messages', () => messageResponse('ok', null))
    const port = iuAnthropic({ env: env() })
    await port.complete({ ...chatRequest, system: 'be brief', effort: 'high', maxOutputTokens: 32_000 }, never())
    await port.complete(chatRequest, never())
    expect(iu.requests[0]?.path).toBe('/anthropic/v1/messages')
    expect(iu.requests[0]?.headers.get('anthropic-version')).toBe('2023-06-01')
    expect(iu.requests[0]?.body).toMatchObject({
      system: 'be brief',
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      max_tokens: 32_000,
    })
    expect(iu.requests[1]?.body.thinking).toBeUndefined()
    expect(iu.requests[1]?.body.output_config).toBeUndefined()
    expect(iu.requests[1]?.body.max_tokens).toBe(100)
  })

  test('stop reasons: max_tokens is length (empty or cut), end_turn complete, anything else carries its detail', async () => {
    const port = iuAnthropic({ env: env() })
    iu.on('messages', () => messageResponse('', null, 'max_tokens'))
    expect(await port.complete(chatRequest, never())).toMatchObject({ text: '', stop: 'length' })
    iu.on('messages', () => messageResponse('half an ans', null, 'max_tokens'))
    expect(await port.complete(chatRequest, never())).toMatchObject({ text: 'half an ans', stop: 'length' })
    iu.on('messages', () => messageResponse('done', null, 'end_turn'))
    expect(await port.complete(chatRequest, never())).toMatchObject({ stop: 'complete' })
    iu.on('messages', () => messageResponse('I cannot', null, 'refusal'))
    expect(await port.complete(chatRequest, never())).toMatchObject({ stop: 'other', stopDetail: 'refusal' })
  })

  test('usage counts cache reads and writes in the input; a cost the provider reports is passed on; no usage reports nothing', async () => {
    const reported: unknown[] = []
    iu.on('messages', () =>
      messageResponse('  The gist.  ', {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 40,
        cache_creation_input_tokens: 10,
        cost: 0.0042,
      }),
    )
    const port = iuAnthropic({ env: env() })
    const result = await port.complete(chatRequest, never(), (u) => reported.push(u))
    expect(result.text).toBe('The gist.')
    expect(reported).toEqual([
      { model: 'fake', tokens: { input: 150, output: 20, cacheRead: 40, cacheWrite: 10, reasoning: 0 }, cost: 0.0042 },
    ])

    iu.on('messages', () => messageResponse('ok', { input_tokens: 1, output_tokens: 1 }))
    await port.complete(chatRequest, never(), (u) => reported.push(u))
    expect(reported[1]).toMatchObject({ cost: null })

    iu.on('messages', () => messageResponse('ok', null))
    await port.complete(chatRequest, never(), (u) => reported.push(u))
    expect(reported).toHaveLength(2)
  })
})

describe('ports reject, they never throw synchronously', () => {
  const request = { model: 'm', state: 's', questions: { q: { type: 'boolean', instructions: 'i' } } } as const
  const calls = {
    'iu-openai': (e: Record<string, string>) => iuOpenai({ env: e }).complete(chatRequest, never()),
    'iu-anthropic': (e: Record<string, string>) => iuAnthropic({ env: e }).complete(chatRequest, never()),
    'iu-decision': (e: Record<string, string>) => iuDecision({ env: e }).decide(request, never()),
  }
  for (const [name, call] of Object.entries(calls)) {
    test(`${name}: missing credentials are a rejected promise`, async () => {
      let promise: Promise<unknown> | undefined
      expect(() => {
        promise = call({})
      }).not.toThrow()
      expect(await failure(promise as Promise<unknown>)).toMatchObject({ code: 'NOT_CONFIGURED' })
    })
  }
})

describe('billing on failure paths', () => {
  const usageChunk = { prompt_tokens: 20, completion_tokens: 4 }

  test('a stream cut before its finish chunk still reports its usage, once per attempt', async () => {
    iu.on('chat', () => sse([{ choices: [{ delta: { content: 'half' } }] }, { choices: [], usage: usageChunk }]))
    const reported: unknown[] = []
    const error = await failure(
      iuOpenai({ env: env(), backoffMs: 0 }).complete(chatRequest, never(), (u) => reported.push(u)),
    )
    expect(error.message).toContain('without a finish reason')
    expect(reported).toHaveLength(3)
    expect(reported[0]).toMatchObject({ tokens: { input: 20, output: 4 } })
  })

  test('a 200 Messages body that does not fit still reports the usage it carries, and is not retried', async () => {
    iu.on('messages', () => Response.json({ content: 'not an array', usage: { input_tokens: 9, output_tokens: 2 } }))
    const reported: unknown[] = []
    await failure(iuAnthropic({ env: env(), backoffMs: 0 }).complete(chatRequest, never(), (u) => reported.push(u)))
    expect(reported).toEqual([
      { model: 'm', tokens: { input: 9, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, cost: null },
    ])
    expect(iu.requests).toHaveLength(1)
  })

  test('a 200 decision body that does not fit still reports its usage', async () => {
    iu.on('decide', () => Response.json({ answers: 'nope', usage: { input_tokens: 5, output_tokens: 1 } }))
    const reported: unknown[] = []
    const request = { model: 'm', state: 's', questions: { q: { type: 'boolean', instructions: 'i' } } } as const
    await failure(iuDecision({ env: env(), backoffMs: 0 }).decide(request, never(), (u) => reported.push(u)))
    expect(reported).toHaveLength(1)
    expect(iu.requests).toHaveLength(1)
  })
})

describe('body-read failures', () => {
  const resetBody = () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"content":[{"type":"te'))
          controller.error(new Error('ECONNRESET mid-body'))
        },
      }),
    )
  const request = { model: 'm', state: 's', questions: { q: { type: 'boolean', instructions: 'i' } } } as const

  test('a reset mid-body is retryable on the Messages and decision wires', async () => {
    let calls = 0
    const fetcher = async () => {
      calls++
      return resetBody()
    }
    const anthropic = await failure(
      iuAnthropic({ env: env(), backoffMs: 0, fetch: fetcher }).complete(chatRequest, never()),
    )
    expect(anthropic.message).toContain('could not be read')
    expect(calls).toBe(3)
    const decision = await failure(iuDecision({ env: env(), backoffMs: 0, fetch: fetcher }).decide(request, never()))
    expect(decision.message).toContain('could not be read')
    expect(calls).toBe(6)
  })

  test('a cut JSON body is retried, then succeeds when the next attempt is whole', async () => {
    iu.on('messages', (_, attempt) =>
      attempt === 0 ? new Response('{"content":[{"type":"te') : messageResponse('ok', null),
    )
    const result = await iuAnthropic({ env: env(), backoffMs: 0 }).complete(chatRequest, never())
    expect(result.text).toBe('ok')
    expect(iu.requests).toHaveLength(2)
  })

  test('parsed JSON that does not fit the schema is not retried', async () => {
    iu.on('decide', () => Response.json({ unexpected: true }))
    await failure(iuDecision({ env: env(), backoffMs: 0 }).decide(request, never()))
    expect(iu.requests).toHaveLength(1)
  })
})

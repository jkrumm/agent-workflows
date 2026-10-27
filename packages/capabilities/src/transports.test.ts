import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { CapabilityError } from './errors.ts'
import { chatStream, type FakeIuServer, messageResponse, startFakeIu } from './testing/index.ts'
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

  test('no usage chunk means undefined tokens, not zeros', async () => {
    iu.on('chat', () => chatStream('ok', null))
    const result = await iuOpenai({ env: env() }).complete(chatRequest, never())
    expect(result).toMatchObject({ text: 'ok', stop: 'complete', tokens: undefined, cost: null })
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

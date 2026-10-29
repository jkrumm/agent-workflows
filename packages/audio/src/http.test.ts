import { describe, expect, test } from 'bun:test'
import { rawFetch, readBodyHint, retryHintFromBody, retryHintMs } from './http.ts'
import { createAudioScope } from './scope.ts'
import { recordingUsage, silentLog, testConfig } from './testing/index.ts'

/** A scope whose fetch answers from `replies` in order and whose clock records each sleep instead of waiting. */
function scopeWith(replies: Array<() => Response>) {
  const sleeps: number[] = []
  let calls = 0
  const scope = createAudioScope(
    {
      config: testConfig('http://127.0.0.1:1/anthropic'),
      usage: recordingUsage(),
      log: silentLog,
      clock: { now: () => Date.now(), sleep: async (ms) => void sleeps.push(ms) },
      fetch: async () => {
        const reply = replies[calls++]
        if (!reply) throw new Error('no more replies')
        return reply()
      },
    },
    { requestId: 'r', caller: 'test' },
  )
  return { scope, sleeps, calls: () => calls }
}

describe('retry hints', () => {
  test('Retry-After delay-seconds and HTTP-date', () => {
    expect(retryHintMs(new Headers({ 'retry-after': '2' }), '')).toBe(2000)
    const date = new Date(Date.now() + 3000).toUTCString()
    const ms = retryHintMs(new Headers({ 'retry-after': date }), '') ?? 0
    expect(ms).toBeGreaterThan(1000)
    expect(ms).toBeLessThanOrEqual(3000)
  })
  test("a retry_after JSON field, and Replicate's 'resets in ~30s' prose", () => {
    expect(retryHintFromBody('{"retry_after": 1.5}')).toBe(1500)
    expect(retryHintFromBody('Request was throttled. Your rate limit resets in ~30s.')).toBe(30_000)
  })
  test('no hint, blank hints and overflowing hints are null, never 0, NaN or Infinity', () => {
    expect(retryHintMs(new Headers(), 'nothing here')).toBeNull()
    expect(retryHintMs(new Headers({ 'retry-after': '  ' }), '')).toBeNull()
    expect(retryHintMs(new Headers({ 'retry-after': '' }), '{"retry_after": 4}')).toBe(4000)
    expect(retryHintFromBody('{"retry_after": 1e308}')).toBeNull()
    expect(retryHintFromBody('{"retry_after": ""}')).toBeNull()
    expect(retryHintFromBody('resets in ~.s')).toBeNull()
  })
})

describe('readBodyHint', () => {
  const chunked = (...parts: string[]) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          for (const p of parts) c.enqueue(new TextEncoder().encode(p))
          c.close()
        },
      }),
    )
  test('reads a hint from a small body split across chunks', async () => {
    expect(await readBodyHint(chunked('{"retry_', 'after": 2}'))).toBe(2000)
  })
  test('a body over the byte cap yields no hint, even with retry_after up front', async () => {
    expect(await readBodyHint(chunked('{"retry_after": 2,', 'x'.repeat(100)), 2000, 32)).toBeNull()
  })
  test('a declared Content-Length over the cap is refused without reading', async () => {
    const res = new Response('{"retry_after": 2}', { headers: { 'content-length': '999999' } })
    expect(await readBodyHint(res)).toBeNull()
  })
  test('a body that stalls past the timeout yields no hint', async () => {
    const stalled = new Response(new ReadableStream({ start() {} }))
    expect(await readBodyHint(stalled, 20)).toBeNull()
  })
  test('an already-consumed body and no body yield no hint instead of throwing', async () => {
    const res = new Response('{"retry_after": 2}')
    await res.text()
    expect(await readBodyHint(res)).toBeNull()
    expect(await readBodyHint(new Response(null))).toBeNull()
  })
})

describe('rawFetch', () => {
  test('retries once when fetch throws (socket closed mid-body) and returns the next reply', async () => {
    let first = true
    const { scope, sleeps } = scopeWith([
      () => {
        if (first) {
          first = false
          throw new Error('The socket connection was closed unexpectedly.')
        }
        return new Response('unreachable')
      },
      () => new Response('ok'),
    ])
    const res = await rawFetch(scope, 'http://x', { method: 'GET' })
    expect(res).toEqual({ status: 200, body: 'ok' })
    expect(sleeps).toEqual([1000])
    expect(scope.meta.retries).toBe(1)
  })

  test('an abort from a signal the fetch port merged in is final: no retry, no sleep, no retries counted', async () => {
    const { scope, sleeps, calls } = scopeWith([
      () => {
        throw new DOMException('The operation was aborted.', 'AbortError')
      },
      () => new Response('never'),
    ])
    // No `init.signal`: the abort came from inside the port (the door's client-bound fetch).
    const error = await rawFetch(scope, 'http://x', { method: 'GET' }).then(
      () => null,
      (e: unknown) => e,
    )
    expect((error as Error).name).toBe('AbortError')
    expect(calls()).toBe(1)
    expect(sleeps).toEqual([])
    expect(scope.meta.retries).toBe(0)
  })

  test("waits out the server's hint on 429 instead of the fixed 500 ms backoff, capped at 15 s", async () => {
    const { scope, sleeps } = scopeWith([
      () => new Response('throttled', { status: 429, headers: { 'retry-after': '0.6' } }),
      () => new Response('throttled', { status: 503, headers: { 'retry-after': '120' } }),
      () => new Response('ok'),
    ])
    expect((await rawFetch(scope, 'http://x', { method: 'GET' })).status).toBe(200)
    expect(sleeps).toEqual([600, 15_000])
  })

  test('does not read a stalled error body when a Retry-After header is present', async () => {
    const { scope, sleeps } = scopeWith([
      () => new Response(new ReadableStream({ start() {} }), { status: 429, headers: { 'retry-after': '0.05' } }),
      () => new Response('ok'),
    ])
    expect((await rawFetch(scope, 'http://x', { method: 'GET' })).body).toBe('ok')
    expect(sleeps).toEqual([500])
  })

  test('honours a body-only hint on a 503; the last attempt returns the 503 as is', async () => {
    const { scope, sleeps } = scopeWith([
      () => new Response('{"retry_after": 2}', { status: 503 }),
      () => new Response('busy', { status: 503 }),
      () => new Response('busy', { status: 503 }),
    ])
    expect(await rawFetch(scope, 'http://x', { method: 'GET' })).toEqual({ status: 503, body: 'busy' })
    expect(sleeps).toEqual([2000, 1000])
  })
})

// The image door without a journal: a client that is already gone, or that goes while its body is still being read,
// starts no job, no run and no upstream call, and gives its in-flight slot back.
import { describe, expect, test } from 'bun:test'
import { createImageDoor } from '../src/image-door/index.ts'

const TOKEN = 'studio-token-0123456789abcdef-0123456789'
const SECRET = 'test-secret-0123456789abcdef-0123456789'
const URL_ = 'http://127.0.0.1/door/image/generate'

function door() {
  const calls = { upstream: 0, runtime: 0, enhance: 0 }
  const instance = createImageDoor({
    options: {
      tokens: new Map([['studio', TOKEN]]),
      image: {
        env: { IU_API_KEY: 'test-key', IU_BASE_URL: 'https://iu.example.com/anthropic' },
        fetch: async () => {
          calls.upstream++
          return new Response('{}', { status: 500 })
        },
      },
      limits: { maxInFlight: 1 },
    },
    secret: SECRET,
    env: {},
    enhance: async () => {
      calls.enhance++
      throw new Error('not called')
    },
    runtime: () => {
      calls.runtime++
      throw new Error('a gone client must not start a run')
    },
    isOpen: () => true,
    logger: { warn: () => {}, error: () => {} },
  })
  const send = (init: RequestInit) => {
    const url = new URL(URL_)
    const answer = instance.route(new Request(URL_, { method: 'POST', ...init }), url)
    if (!answer) throw new Error('the door did not take its own path')
    return answer
  }
  return { send, calls }
}

const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
const body = JSON.stringify({ prompt: 'a lighthouse' })

describe('a client that is gone', () => {
  test('already gone when the request arrives: nothing is read, started or sent', async () => {
    const { send, calls } = door()
    const res = await send({ headers, body, signal: AbortSignal.abort() })
    expect(res.status).toBe(499)
    expect(calls).toEqual({ upstream: 0, runtime: 0, enhance: 0 })
  })

  test('gone by the time the body has been read: no job, no run, no upstream call', async () => {
    const { send, calls } = door()
    const controller = new AbortController()
    const goesWhileReading = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(new TextEncoder().encode(body))
        controller.abort() // the last byte arrives, and the client is gone with it
        c.close()
      },
    })
    const res = await send({
      headers,
      body: goesWhileReading,
      signal: controller.signal,
      duplex: 'half',
    } as RequestInit)
    expect(res.status).toBe(499)
    expect(calls).toEqual({ upstream: 0, runtime: 0, enhance: 0 })
  })

  test('each of them gave its slot back: with a cap of one, the next request is not refused', async () => {
    const { send } = door()
    for (let i = 0; i < 3; i++) {
      const res = await send({ headers, body, signal: AbortSignal.abort() })
      expect(res.status).toBe(499)
    }
    const gone = new AbortController()
    const goesWhileReading = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(new TextEncoder().encode(body))
        gone.abort()
        c.close()
      },
    })
    expect(
      (await send({ headers, body: goesWhileReading, signal: gone.signal, duplex: 'half' } as RequestInit)).status,
    ).toBe(499)
    // a live request is still admitted: it gets past the cap (and is refused at the journal here, which is a different 503)
    const live = await send({ headers, body })
    expect(JSON.stringify(await live.json())).not.toContain('too many')
  })
})

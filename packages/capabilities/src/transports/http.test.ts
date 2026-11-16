import { describe, expect, test } from 'bun:test'
import { Attempt, isConnectRefused, requestFailure, withRetries } from './http.ts'

const refused = () => Object.assign(new Error('Unable to connect'), { code: 'ConnectionRefused' })
const never = () => new AbortController().signal

describe('a refused connection', () => {
  test('is recognised by both of the runtimes’ codes, and a reset or an abort is not one', () => {
    expect(isConnectRefused(refused())).toBe(true)
    expect(isConnectRefused(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe(true)
    expect(isConnectRefused(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe(false)
    expect(requestFailure(refused()).refused).toBe(true)
    expect(requestFailure(refused(), true).refused).toBeUndefined()
    expect(requestFailure(new Error('reset')).refused).toBeUndefined()
  })

  test('is retried for its own window without using up the attempts, then succeeds', async () => {
    let calls = 0
    const result = await withRetries({ attempts: 3, backoffMs: 0, refusedWindowMs: 5000 }, never(), async () => {
      calls++
      if (calls <= 8) throw requestFailure(refused())
      return 'answered'
    })
    expect(result).toBe('answered')
    expect(calls).toBe(9)
  })

  test('a gateway that stays down is an exhausted transport failure after the window, the way it was after the attempts', async () => {
    let calls = 0
    const error = await withRetries({ attempts: 3, backoffMs: 0, refusedWindowMs: 300 }, never(), async () => {
      calls++
      throw requestFailure(refused())
    }).catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'UPSTREAM_ERROR', data: { transport: true, exhausted: true } })
    expect(calls).toBeGreaterThan(3)
  })

  test('a window of 0 keeps the old rule: three attempts', async () => {
    let calls = 0
    await withRetries({ attempts: 3, backoffMs: 0, refusedWindowMs: 0 }, never(), async () => {
      calls++
      throw requestFailure(refused())
    }).catch(() => undefined)
    expect(calls).toBe(3)
  })

  test('anything else that failed keeps its three attempts', async () => {
    let calls = 0
    await withRetries({ attempts: 3, backoffMs: 0, refusedWindowMs: 5000 }, never(), async () => {
      calls++
      throw new Attempt('502', true, 502)
    }).catch(() => undefined)
    expect(calls).toBe(3)
  })

  test('a cancelled call stops waiting at once', async () => {
    const controller = new AbortController()
    const started = Date.now()
    const call = withRetries({ attempts: 3, backoffMs: 1000, refusedWindowMs: 60_000 }, controller.signal, async () => {
      throw requestFailure(refused())
    }).catch((e: unknown) => e)
    setTimeout(() => controller.abort(), 150)
    expect(await call).toMatchObject({ code: 'CANCELLED' })
    expect(Date.now() - started).toBeLessThan(3000)
  })
})

import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { installLifecycle } from '../src/lifecycle.ts'

function setup(shutdown: () => Promise<void>, backstopMs = 10_000) {
  const proc = new EventEmitter()
  const exits: number[] = []
  const logs: string[] = []
  installLifecycle({
    shutdown,
    backstopMs,
    exit: (code) => void exits.push(code),
    proc: proc as never,
    log: (message) => void logs.push(message),
  })
  return { proc, exits, logs }
}

describe('process lifecycle', () => {
  test('SIGTERM shuts down once and exits 0', async () => {
    let calls = 0
    const { proc, exits } = setup(async () => void calls++)
    proc.emit('SIGTERM')
    await Bun.sleep(10)
    expect(calls).toBe(1)
    expect(exits).toEqual([0])
  })

  test('a second SIGTERM or SIGINT during shutdown exits at once', async () => {
    const { proc, exits } = setup(() => new Promise(() => {}))
    proc.emit('SIGTERM')
    expect(exits).toEqual([])
    proc.emit('SIGINT')
    expect(exits).toEqual([1])
  })

  test('the backstop exits when shutdown hangs', async () => {
    const { proc, exits, logs } = setup(() => new Promise(() => {}), 30)
    proc.emit('SIGTERM')
    await Bun.sleep(80)
    expect(exits).toEqual([1])
    expect(logs.some((l) => l.includes('did not finish'))).toBe(true)
  })

  test('a failed shutdown exits 1', async () => {
    const { proc, exits } = setup(() => Promise.reject(new Error('close failed')))
    proc.emit('SIGINT')
    await Bun.sleep(10)
    expect(exits).toEqual([1])
  })

  test('an uncaught exception shuts down and exits 1', async () => {
    let calls = 0
    const { proc, exits } = setup(async () => void calls++)
    proc.emit('uncaughtException', new Error('x'))
    await Bun.sleep(10)
    expect(calls).toBe(1)
    expect(exits).toEqual([1])
  })

  test('an unhandled rejection is logged and the process keeps serving', async () => {
    let calls = 0
    const { proc, exits, logs } = setup(async () => void calls++)
    proc.emit('unhandledRejection', new Error('x'))
    await Bun.sleep(10)
    expect(calls).toBe(0)
    expect(exits).toEqual([])
    expect(logs.some((l) => l.includes('unhandledRejection'))).toBe(true)
  })
})

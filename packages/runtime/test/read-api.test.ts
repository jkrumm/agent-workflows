import { afterAll, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { defineWorkflow } from '../src/index.ts'
import type { Socket } from 'bun'
import { IdempotencyConflict } from '../src/index.ts'
import { freshSchema, inspector, PG_URL, testRuntime, until } from './support/pg.ts'

const db = freshSchema('getrun')
const sql = inspector(db.schema)
afterAll(async () => {
  await sql.close()
  await db.drop()
})

const empty = z.object({})
const ok = defineWorkflow({
  id: 'get.ok',
  version: 'v1',
  input: empty,
  output: z.object({ n: z.number() }),
  run: async (ctx) => ({ n: await ctx.step('n', () => 7) }),
})
const boom = defineWorkflow({
  id: 'get.boom',
  version: 'v1',
  input: empty,
  output: empty,
  async run(ctx) {
    await ctx.step('boom', () => {
      throw new Error('kaput')
    })
    return {}
  },
})
let release!: () => void
const held = new Promise<void>((resolve) => {
  release = resolve
})
const hold = defineWorkflow({
  id: 'get.hold',
  version: 'v1',
  input: empty,
  output: empty,
  async run(ctx) {
    await ctx.step('hold', ({ signal }) =>
      Promise.race([
        held,
        new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))),
      ]).then(() => true),
    )
    return {}
  },
})

describe('getRun and ping', () => {
  test('a run is readable in every state; output only when done, error once it ended badly', async () => {
    const rt = testRuntime({ schema: db.schema, workflows: [ok, boom, hold] })
    await rt.open()
    try {
      expect(await rt.getRun('nope')).toBeNull()

      const done = await rt.start(ok, {}, { purpose: 'test' })
      await rt.wait(done.runId)
      expect(await rt.getRun(done.runId)).toEqual({
        runId: done.runId,
        workflowId: 'get.ok',
        status: 'done',
        output: { n: 7 },
        error: null,
      })

      const failed = await rt.start(boom, {}, { purpose: 'test' })
      await rt.wait(failed.runId)
      const snapshot = await rt.getRun(failed.runId)
      expect(snapshot).toMatchObject({ status: 'failed', output: null, error: { kind: 'step_failed' } })
      expect(snapshot?.error?.message).toContain('kaput')

      const running = await rt.start(hold, {}, { purpose: 'test' })
      await until(async () => (await rt.getRun(running.runId))?.status === 'running', 'running')
      expect(await rt.getRun(running.runId)).toEqual({
        runId: running.runId,
        workflowId: 'get.hold',
        status: 'running',
        output: null,
        error: null,
      })
      await rt.cancel(running.runId)
      await rt.wait(running.runId)
      expect(await rt.getRun(running.runId)).toMatchObject({ status: 'cancelled', error: { kind: 'cancelled' } })
    } finally {
      release()
      await rt.close()
    }
  })

  test('ping resolves while open and rejects after close', async () => {
    const rt = testRuntime({ schema: db.schema, workflows: [ok] })
    await rt.open()
    await rt.ping()
    await rt.close()
    expect(
      await rt.ping().then(
        () => 'resolved',
        () => 'rejected',
      ),
    ).toBe('rejected')
  })
})

/** A TCP proxy in front of Postgres that holds traffic while stalled and replays it on release: slow, not down. */
function stallableProxy() {
  const target = new URL(PG_URL)
  const held: (() => void)[] = []
  const state = {
    clientsClosed: 0,
    stalled: false,
    stall() {
      state.stalled = true
    },
    release() {
      state.stalled = false
      for (const send of held.splice(0)) send()
    },
  }
  const forward = (send: () => void) => (state.stalled ? void held.push(send) : send())
  type Up = Socket<{ client: Socket<{ up?: Promise<Up> }> }>
  const listener = Bun.listen<{ up?: Promise<Up> }>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open(client) {
        client.data = {
          up: Bun.connect({
            hostname: target.hostname,
            port: Number(target.port || 5432),
            data: { client },
            socket: {
              data: (up, chunk) => forward(() => void up.data.client.write(chunk)),
              close: (up) => void up.data.client.end(),
              error() {},
            },
          }),
        }
      },
      data(client, chunk) {
        forward(() => void client.data.up?.then((up) => up.write(chunk)))
      },
      close(client) {
        state.clientsClosed++
        void client.data.up?.then((up) => up.end())
      },
      error() {},
    },
  })
  const url = new URL(PG_URL)
  url.hostname = '127.0.0.1'
  url.port = String(listener.port)
  return { url: url.toString(), state, stop: () => listener.stop(true) }
}

describe('ping is bounded', () => {
  test('a stalled query rejects within the bound and its connection is destroyed, not parked on the pool', async () => {
    const proxy = stallableProxy()
    const { Runtime } = await import('../src/index.ts')
    const rt = new Runtime({ connectionString: proxy.url, schema: db.schema, workflows: [ok], journalPoolSize: 2 })
    await rt.open()
    try {
      await rt.ping()
      const closedBefore = proxy.state.clientsClosed
      proxy.state.stall()
      const started = Date.now()
      const outcome = await rt.ping(300).then(
        () => 'resolved',
        (e: Error) => e.message,
      )
      expect(outcome).toMatch(/timed out|timeout/i)
      expect(Date.now() - started).toBeLessThan(1500)
      // the stalled connection was closed by the client, so Postgres ends the query instead of running it for 120 s
      await until(() => proxy.state.clientsClosed > closedBefore, 'stalled connection closed')

      proxy.state.release()
      await rt.ping()
      expect(await rt.getRun('nope')).toBeNull()
    } finally {
      await rt.close()
      proxy.stop()
    }
  })
})

describe('idempotency key', () => {
  test('a replay with the same input is the same run; a different input is an IdempotencyConflict', async () => {
    const wf = defineWorkflow({
      id: 'get.idem',
      version: 'v1',
      input: z.object({ n: z.number() }),
      output: empty,
      run: async () => ({}),
    })
    const rt = testRuntime({ schema: db.schema, workflows: [wf] })
    try {
      const first = await rt.start(wf, { n: 1 }, { purpose: 'prod', idempotencyKey: 'k' })
      expect((await rt.start(wf, { n: 1 }, { purpose: 'prod', idempotencyKey: 'k' })).runId).toBe(first.runId)
      const conflict = await rt.start(wf, { n: 2 }, { purpose: 'prod', idempotencyKey: 'k' }).catch((e: unknown) => e)
      expect(conflict).toBeInstanceOf(IdempotencyConflict)
      expect(conflict).toMatchObject({ workflowId: 'get.idem', idempotencyKey: 'k', runId: first.runId })
      expect(String((conflict as Error).message)).toContain('"k"')
      // the same key on another workflow is a different run, not a conflict
      const other = defineWorkflow({
        id: 'get.idem2',
        version: 'v1',
        input: empty,
        output: empty,
        run: async () => ({}),
      })
      const rt2 = testRuntime({ schema: db.schema, workflows: [other] })
      expect((await rt2.start(other, {}, { purpose: 'prod', idempotencyKey: 'k' })).runId).not.toBe(first.runId)
      await rt2.close()
    } finally {
      await rt.close()
    }
  })
})

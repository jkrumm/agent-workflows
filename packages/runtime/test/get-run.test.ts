import { afterAll, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { defineWorkflow } from '../src/index.ts'
import { freshSchema, inspector, testRuntime, until } from './support/pg.ts'

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

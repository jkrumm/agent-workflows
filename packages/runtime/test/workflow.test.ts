import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { defineWorkflow, type Json, StepFailed, WorkflowError } from '../src/index.ts'
import { captureLogger, freshSchema, inspector, testRuntime, until } from './support/pg.ts'

const db = freshSchema('wf')
const sql = inspector(db.schema)

beforeAll(async () => {
  const rt = testRuntime({ schema: db.schema, workflows: [] })
  await rt.open()
  await rt.close()
})

afterAll(async () => {
  await sql.close()
  await db.drop()
})

const empty = z.object({})

describe('defineWorkflow', () => {
  test('runs steps and validates input and output', async () => {
    const wf = defineWorkflow({
      id: 'wf.happy',
      version: 'v1',
      input: z.object({ n: z.number() }),
      output: z.object({ doubled: z.number(), key: z.string() }),
      async run(ctx, { n }) {
        const doubled = await ctx.step('double', () => n * 2)
        const key = await ctx.effect('send', (k) => k)
        return { doubled, key }
      },
    })
    const rt = testRuntime({ schema: db.schema, workflows: [wf] })
    await rt.open()
    try {
      const traceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'
      const { runId } = await rt.start(wf, { n: 21 }, { purpose: 'build', traceparent })
      const result = await rt.wait(runId)
      expect(result).toEqual({ runId, status: 'done', output: { doubled: 42, key: `${runId}:send` }, error: null })
      const row = await sql.run(runId)
      expect(row).toMatchObject({
        purpose: 'build',
        traceparent,
        trace_id: '0af7651916cd43dd8448eb211c80319c',
        version_started: 'v1',
        version_finished: 'v1',
      })
      const invalid = await rt.start(wf, { n: 'x' } as never, { purpose: 'build' }).catch((err: unknown) => err)
      expect(invalid).toBeInstanceOf(WorkflowError)
    } finally {
      await rt.close()
    }
  })

  test('an output that fails its schema ends the run as invalid_output', async () => {
    const wf = defineWorkflow({
      id: 'wf.badout',
      version: 'v1',
      input: empty,
      output: z.object({ ok: z.literal(true) }),
      run: async () => ({ ok: false }) as never,
    })
    const rt = testRuntime({ schema: db.schema, workflows: [wf] })
    await rt.open()
    try {
      const { runId } = await rt.start(wf, {}, { purpose: 'build' })
      const result = await rt.wait(runId)
      expect(result.status).toBe('failed')
      expect(result.error?.kind).toBe('invalid_output')
    } finally {
      await rt.close()
    }
  })

  test('the same idempotency key returns the same run', async () => {
    const wf = defineWorkflow({ id: 'wf.idem', version: 'v1', input: empty, output: empty, run: async () => ({}) })
    const rt = testRuntime({ schema: db.schema, workflows: [wf] })
    const a = await rt.start(wf, {}, { purpose: 'prod', idempotencyKey: 'k1' })
    const b = await rt.start(wf, {}, { purpose: 'prod', idempotencyKey: 'k1' })
    expect(b.runId).toBe(a.runId)
    await rt.close()
  })

  test('a duplicate step id fails the run', async () => {
    const wf = defineWorkflow({
      id: 'wf.dup',
      version: 'v1',
      input: empty,
      output: empty,
      async run(ctx) {
        await ctx.step('same', () => 1)
        await ctx.step('same', () => 2)
        return {}
      },
    })
    const rt = testRuntime({ schema: db.schema, workflows: [wf] })
    await rt.open()
    try {
      const { runId } = await rt.start(wf, {}, { purpose: 'build' })
      const result = await rt.wait(runId)
      expect(result.status).toBe('failed')
      expect(result.error?.kind).toBe('duplicate_step')
    } finally {
      await rt.close()
    }
  })

  test('a step returning a non-JSON value fails as non_json_output', async () => {
    const wf = defineWorkflow({
      id: 'wf.date',
      version: 'v1',
      input: empty,
      output: empty,
      async run(ctx) {
        await ctx.step('when', () => ({ at: new Date() }) as unknown as Json)
        return {}
      },
    })
    const rt = testRuntime({ schema: db.schema, workflows: [wf] })
    await rt.open()
    try {
      const { runId } = await rt.start(wf, {}, { purpose: 'build' })
      const result = await rt.wait(runId)
      expect(result.error?.kind).toBe('step_failed')
      expect(await sql.step(runId, 'when')).toMatchObject({ status: 'failed', error_kind: 'non_json_output' })
    } finally {
      await rt.close()
    }
  })

  test('a failing step body fails the run; a thrown StepFailed reaches the run body', async () => {
    let seen: unknown = null
    const wf = defineWorkflow({
      id: 'wf.fail',
      version: 'v1',
      input: empty,
      output: empty,
      async run(ctx) {
        try {
          await ctx.step('boom', () => {
            throw new Error('kaput')
          })
        } catch (err) {
          seen = err
          throw err
        }
        return {}
      },
    })
    const rt = testRuntime({ schema: db.schema, workflows: [wf] })
    await rt.open()
    try {
      const { runId } = await rt.start(wf, {}, { purpose: 'build' })
      const result = await rt.wait(runId)
      expect(result.status).toBe('failed')
      expect(seen).toBeInstanceOf(StepFailed)
      expect(await sql.step(runId, 'boom')).toMatchObject({ status: 'failed', error: 'kaput', error_kind: 'error' })
    } finally {
      await rt.close()
    }
  })
})

describe('replay', () => {
  test('a resumed run replays completed steps from the journal with equal values', async () => {
    const original = {
      text: 'ü — "quoted"',
      int: 42,
      float: 0.1 + 0.2,
      neg: -1e-7,
      flag: false,
      nothing: null,
      list: [1, 'two', { three: [3] }, []],
      nested: { deep: { deeper: { empty: {} } } },
    } satisfies Json
    const calls = { a: 0, b: 0 }
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let replayed = null as Json
    const wf = defineWorkflow({
      id: 'wf.replay',
      version: 'v1',
      input: empty,
      output: z.object({ same: z.boolean() }),
      async run(ctx) {
        const a = await ctx.step('a', () => {
          calls.a++
          return structuredClone(original)
        })
        await ctx.step('b', async () => {
          calls.b++
          if (calls.b === 1) await gate
          return true
        })
        replayed = a
        return { same: Bun.deepEquals(a, original, true) }
      },
    })
    const logger = captureLogger()
    const first = testRuntime({ schema: db.schema, workflows: [wf], logger })
    await first.open()
    const { runId } = await first.start(wf, {}, { purpose: 'build' })
    await until(() => calls.b === 1, 'step b to start')
    await first.close() // mid-step shutdown: the row stays running
    expect((await sql.run(runId))?.status).toBe('running')
    release()

    const second = testRuntime({ schema: db.schema, workflows: [wf], logger })
    await second.open()
    try {
      const result = await second.wait(runId)
      expect(result.output).toEqual({ same: true })
      expect(replayed).toStrictEqual(original)
      expect(calls).toEqual({ a: 1, b: 2 })
      expect(await sql.step(runId, 'b')).toMatchObject({ status: 'done', attempts: 2 })
    } finally {
      await second.close()
    }
  })
})

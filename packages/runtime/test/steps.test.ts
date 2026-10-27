import { afterAll, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { defineWorkflow } from '../src/index.ts'
import { freshSchema, inspector, testRuntime } from './support/pg.ts'

const db = freshSchema('steps')
const sql = inspector(db.schema)

afterAll(async () => {
  await sql.close()
  await db.drop()
})

const empty = z.object({})

describe('retry policy', () => {
  test('retries a failing body with backoff until it succeeds', async () => {
    const seen: { attempt: number; at: number }[] = []
    const wf = defineWorkflow({
      id: 'steps.retry',
      version: 'v1',
      input: empty,
      output: z.object({ attempt: z.number() }),
      async run(ctx) {
        const attempt = await ctx.step(
          'flaky',
          ({ attempt }) => {
            seen.push({ attempt, at: Date.now() })
            if (attempt < 3) throw new Error(`flake ${attempt}`)
            return attempt
          },
          { retry: { attempts: 3, backoffMs: 50, factor: 2 } },
        )
        return { attempt }
      },
    })
    const rt = testRuntime({ schema: db.schema, workflows: [wf] })
    await rt.open()
    try {
      const { runId } = await rt.start(wf, {}, { purpose: 'build' })
      expect((await rt.wait(runId)).output).toEqual({ attempt: 3 })
      expect(seen.map((s) => s.attempt)).toEqual([1, 2, 3])
      const [first, second, third] = seen.map((s) => s.at)
      expect((second ?? 0) - (first ?? 0)).toBeGreaterThanOrEqual(45)
      expect((third ?? 0) - (second ?? 0)).toBeGreaterThanOrEqual(95)
      expect(await sql.step(runId, 'flaky')).toMatchObject({ status: 'done', attempts: 3 })
    } finally {
      await rt.close()
    }
  })

  test('without a policy a failing body fails at once; with one it fails after the last attempt', async () => {
    let calls = 0
    const wf = defineWorkflow({
      id: 'steps.exhaust',
      version: 'v1',
      input: empty,
      output: empty,
      async run(ctx) {
        await ctx.step(
          'never',
          () => {
            calls++
            throw new Error('no')
          },
          { retry: { attempts: 2, backoffMs: 10 } },
        )
        return {}
      },
    })
    const rt = testRuntime({ schema: db.schema, workflows: [wf] })
    await rt.open()
    try {
      const { runId } = await rt.start(wf, {}, { purpose: 'build' })
      expect((await rt.wait(runId)).status).toBe('failed')
      expect(calls).toBe(2)
      expect(await sql.step(runId, 'never')).toMatchObject({ status: 'failed', attempts: 2 })
    } finally {
      await rt.close()
    }
  })
})

describe('idle timeout', () => {
  test('a step without progress for idleTimeoutMs fails as timeout', async () => {
    const wf = defineWorkflow({
      id: 'steps.idle',
      version: 'v1',
      input: empty,
      output: empty,
      async run(ctx) {
        await ctx.step('silent', () => Bun.sleep(2000).then(() => 1), { idleTimeoutMs: 100 })
        return {}
      },
    })
    const rt = testRuntime({ schema: db.schema, workflows: [wf] })
    await rt.open()
    try {
      const started = Date.now()
      const { runId } = await rt.start(wf, {}, { purpose: 'build' })
      const result = await rt.wait(runId, { pollMs: 20 })
      expect(result.status).toBe('failed')
      expect(Date.now() - started).toBeLessThan(1500)
      expect(await sql.step(runId, 'silent')).toMatchObject({ status: 'failed', error_kind: 'timeout' })
    } finally {
      await rt.close()
    }
  })

  test('progress keeps a step alive far beyond idleTimeoutMs: idle rule, no wall-clock cap', async () => {
    const wf = defineWorkflow({
      id: 'steps.busy',
      version: 'v1',
      input: empty,
      output: z.object({ ticks: z.number() }),
      async run(ctx) {
        const ticks = await ctx.step(
          'busy',
          async ({ progress }) => {
            for (let i = 0; i < 10; i++) {
              await Bun.sleep(40)
              progress()
            }
            return 10
          },
          { idleTimeoutMs: 100 },
        )
        return { ticks }
      },
    })
    const rt = testRuntime({ schema: db.schema, workflows: [wf] })
    await rt.open()
    try {
      const { runId } = await rt.start(wf, {}, { purpose: 'build' })
      expect((await rt.wait(runId)).output).toEqual({ ticks: 10 })
    } finally {
      await rt.close()
    }
  })

  test('a timed-out attempt is retried under the retry policy', async () => {
    const wf = defineWorkflow({
      id: 'steps.idle-retry',
      version: 'v1',
      input: empty,
      output: z.object({ attempt: z.number() }),
      async run(ctx) {
        const attempt = await ctx.step(
          'wedge-once',
          async ({ attempt }) => {
            if (attempt === 1) await Bun.sleep(1000)
            return attempt
          },
          { idleTimeoutMs: 80, retry: { attempts: 2, backoffMs: 10 } },
        )
        return { attempt }
      },
    })
    const rt = testRuntime({ schema: db.schema, workflows: [wf] })
    await rt.open()
    try {
      const { runId } = await rt.start(wf, {}, { purpose: 'build' })
      expect((await rt.wait(runId)).output).toEqual({ attempt: 2 })
    } finally {
      await rt.close()
    }
  })
})

describe('usage', () => {
  test('addUsage is summed per step and persisted on the step row, split by model', async () => {
    const tokens = { input: 100, output: 20, cacheRead: 50, reasoning: 5 }
    const wf = defineWorkflow({
      id: 'steps.usage',
      version: 'v1',
      input: empty,
      output: empty,
      async run(ctx) {
        await ctx.step('spend', ({ addUsage }) => {
          addUsage({ model: 'm-a', tokens: { ...tokens, cacheWrite: 30 }, cost: 0.25, toolCalls: 2 })
          addUsage({ model: 'm-a', tokens, cost: 0.5, toolCalls: 1 })
          addUsage({ model: 'm-b', tokens, toolCalls: 4 })
          return null
        })
        return {}
      },
    })
    const rt = testRuntime({ schema: db.schema, workflows: [wf] })
    await rt.open()
    try {
      const { runId } = await rt.start(wf, {}, { purpose: 'build' })
      await rt.wait(runId)
      const row = await sql.step(runId, 'spend')
      expect(row).toMatchObject({
        tokens_input: '300',
        tokens_output: '60',
        tokens_cache_read: '150',
        tokens_reasoning: '15',
        tokens_cache_write: '30',
        cost: '0.75',
        tool_calls: 7,
        unpriced_calls: 1,
        model: null,
      })
      expect(row?.usage_by_model).toEqual({
        'm-a': {
          tokens: { input: 200, output: 40, cacheRead: 100, cacheWrite: 30, reasoning: 10 },
          cost: 0.75,
          toolCalls: 3,
          unpricedCalls: 0,
        },
        // A report without cacheWrite (an OpenAI-shaped wire) stays assignable; the sum carries the bucket.
        'm-b': { tokens: { ...tokens, cacheWrite: 0 }, cost: null, toolCalls: 4, unpricedCalls: 1 },
      })
    } finally {
      await rt.close()
    }
  })
})

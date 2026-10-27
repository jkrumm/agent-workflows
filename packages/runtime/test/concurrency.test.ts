import { afterAll, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { defineWorkflow } from '../src/index.ts'
import { freshSchema, inspector, testRuntime } from './support/pg.ts'

const db = freshSchema('conc')
const sql = inspector(db.schema)

afterAll(async () => {
  await sql.close()
  await db.drop()
})

const empty = z.object({})

/** Counts bodies in flight and the peak. */
function gauge() {
  const g = {
    now: 0,
    peak: 0,
    calls: new Map<string, number>(),
    async hold(runId: string, ms: number) {
      g.calls.set(runId, (g.calls.get(runId) ?? 0) + 1)
      g.now++
      g.peak = Math.max(g.peak, g.now)
      await Bun.sleep(ms)
      g.now--
      return null
    },
  }
  return g
}

describe('concurrency', () => {
  test('a per-workflow limit keeps excess runs pending until a slot frees', async () => {
    const g = gauge()
    const wf = defineWorkflow({
      id: 'conc.limited',
      version: 'v1',
      input: empty,
      output: empty,
      concurrency: 2,
      async run(ctx) {
        await ctx.step('work', () => g.hold(ctx.runId, 150))
        return {}
      },
    })
    const rt = testRuntime({ schema: db.schema, workflows: [wf] })
    const other = testRuntime({ schema: db.schema, workflows: [wf] })
    await rt.open()
    await other.open()
    try {
      const ids = await Promise.all(Array.from({ length: 6 }, () => rt.start(wf, {}, { purpose: 'build' })))
      const results = await Promise.all(ids.map(({ runId }) => rt.wait(runId, { pollMs: 25 })))
      expect(results.every((r) => r.status === 'done')).toBe(true)
      expect(g.peak).toBe(2)
    } finally {
      await other.close()
      await rt.close()
    }
  })

  test('admission fires once per run while processes race for the last slot', async () => {
    const admissions = new Map<string, number>()
    const mw = {
      name: 'count',
      runPre: (a: { runId: string; resume: boolean }) => {
        if (!a.resume) admissions.set(a.runId, (admissions.get(a.runId) ?? 0) + 1)
      },
    }
    const wf = defineWorkflow({
      id: 'conc.admit-once',
      version: 'v1',
      input: empty,
      output: empty,
      concurrency: 1,
      async run(ctx) {
        await ctx.step('work', () => Bun.sleep(30).then(() => null))
        return {}
      },
    })
    const starter = testRuntime({ schema: db.schema, workflows: [wf] })
    const ids = await Promise.all(Array.from({ length: 6 }, () => starter.start(wf, {}, { purpose: 'build' })))
    const procs = Array.from({ length: 3 }, () =>
      testRuntime({ schema: db.schema, workflows: [wf], middleware: [mw], recoveryIntervalMs: 20 }),
    )
    await Promise.all(procs.map((p) => p.open()))
    try {
      const results = await Promise.all(ids.map(({ runId }) => starter.wait(runId, { pollMs: 25 })))
      expect(results.every((r) => r.status === 'done')).toBe(true)
      expect([...admissions.values()]).toEqual([1, 1, 1, 1, 1, 1])
    } finally {
      await Promise.all([...procs.map((p) => p.close()), starter.close()])
    }
  })

  test('the lease budget caps runs per process; the rest are picked up by the recovery tick', async () => {
    const g = gauge()
    const wf = defineWorkflow({
      id: 'conc.budget',
      version: 'v1',
      input: empty,
      output: empty,
      async run(ctx) {
        await ctx.step('work', () => g.hold(ctx.runId, 100))
        return {}
      },
    })
    const rt = testRuntime({ schema: db.schema, workflows: [wf], maxConcurrentRuns: 3 })
    await rt.open()
    try {
      const ids = await Promise.all(Array.from({ length: 9 }, () => rt.start(wf, {}, { purpose: 'build' })))
      const results = await Promise.all(ids.map(({ runId }) => rt.wait(runId, { pollMs: 25 })))
      expect(results.every((r) => r.status === 'done')).toBe(true)
      expect(g.peak).toBe(3)
    } finally {
      await rt.close()
    }
  })

  test('two processes competing for the same runs drive each exactly once', async () => {
    const g = gauge()
    const wf = defineWorkflow({
      id: 'conc.compete',
      version: 'v1',
      input: empty,
      output: empty,
      async run(ctx) {
        await ctx.step('work', () => g.hold(ctx.runId, 50))
        return {}
      },
    })
    const starter = testRuntime({ schema: db.schema, workflows: [wf] })
    const ids = await Promise.all(Array.from({ length: 20 }, () => starter.start(wf, {}, { purpose: 'build' })))
    const a = testRuntime({ schema: db.schema, workflows: [wf], recoveryIntervalMs: 30 })
    const b = testRuntime({ schema: db.schema, workflows: [wf], recoveryIntervalMs: 30 })
    await Promise.all([a.open(), b.open()])
    try {
      const results = await Promise.all(ids.map(({ runId }) => starter.wait(runId, { pollMs: 25 })))
      expect(results.every((r) => r.status === 'done')).toBe(true)
      expect([...g.calls.values()].every((n) => n === 1)).toBe(true)
      expect(g.calls.size).toBe(20)
    } finally {
      await Promise.all([a.close(), b.close(), starter.close()])
    }
  })

  test('30 concurrent runs on a 2-connection journal pool finish (the spike pool deadlock)', async () => {
    const g = gauge()
    const wf = defineWorkflow({
      id: 'conc.pool',
      version: 'v1',
      input: empty,
      output: empty,
      async run(ctx) {
        await ctx.step('a', () => g.hold(ctx.runId, 200))
        await ctx.step('b', () => null)
        return {}
      },
    })
    const rt = testRuntime({ schema: db.schema, workflows: [wf], journalPoolSize: 2, maxConcurrentRuns: 30 })
    await rt.open()
    try {
      const ids = await Promise.all(Array.from({ length: 30 }, () => rt.start(wf, {}, { purpose: 'build' })))
      const results = await Promise.all(ids.map(({ runId }) => rt.wait(runId, { pollMs: 50 })))
      expect(results.every((r) => r.status === 'done')).toBe(true)
      expect(g.peak).toBeGreaterThanOrEqual(25)
    } finally {
      await rt.close()
    }
  }, 20_000)
})

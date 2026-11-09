import { afterAll, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { defineWorkflow, type Json, type Middleware, type Scorer } from '../src/index.ts'
import { FakeAgentHost } from '@agent-workflows/testing/agent-host'
import { captureLogger, freshSchema, inspector, testRuntime, until } from '@agent-workflows/testing/pg'

const db = freshSchema('robust')
const sql = inspector(db.schema)

afterAll(async () => {
  await sql.close()
  await db.drop()
})

const empty = z.object({})
const never = new Promise<never>(() => {})

describe('fenced writes on the root row (F5)', () => {
  test('parallel ctx.score calls in one run never deadlock and the run is driven once', async () => {
    const scorer: Scorer<Record<string, never>> = { version: 's1', score: () => ({ scores: { ok: 1 }, pass: true }) }
    const wf = defineWorkflow({
      id: 'robust.parallel-score',
      version: 'v1',
      input: empty,
      output: z.object({ passed: z.number() }),
      scorer,
      async run(ctx) {
        const verdicts = await Promise.all(Array.from({ length: 40 }, (_, i) => ctx.score(`gate-${i}`, { n: i })))
        return { passed: verdicts.filter((v) => v.pass).length }
      },
    })
    const logger = captureLogger()
    const rt = testRuntime({ schema: db.schema, workflows: [wf], logger, journalPoolSize: 10 })
    await rt.open()
    try {
      const { runId } = await rt.start(wf, {}, { purpose: 'build' })
      const done = await rt.wait(runId, { pollMs: 25 })
      expect(done).toMatchObject({ status: 'done', output: { passed: 40 } })
      expect(logger.lines.filter((l) => l.message.includes('infra error'))).toEqual([])
      expect((await sql.run(runId))?.drives).toBe(1)
    } finally {
      await rt.close()
    }
  })
})

describe('hung hooks (F8)', () => {
  test('a hung runPost times out as a failed delivery and the next run proceeds', async () => {
    let calls = 0
    const hung: Middleware = {
      name: 'hung',
      runPost: () => {
        calls++
        return never
      },
    }
    const wf = defineWorkflow({
      id: 'robust.hung-post',
      version: 'v1',
      input: empty,
      output: empty,
      run: async () => ({}),
    })
    const logger = captureLogger()
    const rt = testRuntime({
      schema: db.schema,
      workflows: [wf],
      middleware: [hung],
      logger,
      postHookTimeoutMs: 150,
      maxPostHookAttempts: 2,
    })
    await rt.open()
    try {
      const first = await rt.start(wf, {}, { purpose: 'build' })
      const second = await rt.start(wf, {}, { purpose: 'build' })
      expect((await rt.wait(first.runId, { pollMs: 25 })).status).toBe('done')
      expect((await rt.wait(second.runId, { pollMs: 25 })).status).toBe('done')
      await until(
        async () => (await sql.run(first.runId))?.post_hooks_at && (await sql.run(second.runId))?.post_hooks_at,
        'hung hooks given up',
        10_000,
      )
      expect((await sql.run(first.runId))?.post_hooks_attempts).toBe(2)
      expect(calls).toBe(4)
      expect(logger.lines.some((l) => l.message === 'runPost threw; outcome kept, delivery retried')).toBe(true)
    } finally {
      await rt.close()
    }
  })

  test('close() returns while a runPost hangs, and the delivery is left uncounted for the next process', async () => {
    let entered = false
    const hung: Middleware = {
      name: 'hung',
      runPost: () => {
        entered = true
        return never
      },
    }
    const wf = defineWorkflow({
      id: 'robust.hung-close',
      version: 'v1',
      input: empty,
      output: empty,
      run: async () => ({}),
    })
    const rt = testRuntime({ schema: db.schema, workflows: [wf], middleware: [hung] })
    await rt.open()
    const { runId } = await rt.start(wf, {}, { purpose: 'build' })
    await until(() => entered, 'runPost entered')
    const closing = rt.close()
    const outcome = await Promise.race([closing.then(() => 'closed'), Bun.sleep(5000).then(() => 'hung')])
    expect(outcome).toBe('closed')
    const row = await sql.run(runId)
    expect(row?.status).toBe('done')
    expect(row?.post_hooks_at).toBeNull()
    expect(row?.post_hooks_attempts).toBe(0)
  })

  test('a hung host.abort during a cancel does not hold the run', async () => {
    let aborts = 0
    class HungAbortHost extends FakeAgentHost {
      override async abort(handle: Json): Promise<void> {
        aborts++
        await never
        return super.abort(handle)
      }
    }
    const host = new HungAbortHost(async (s) => {
      await s.sleep(60_000, 20)
      return { output: { answer: s.id } }
    })
    const answer = z.object({ answer: z.string() })
    const wf = defineWorkflow({
      id: 'robust.hung-abort',
      version: 'v1',
      input: empty,
      output: answer,
      run: (ctx) => ctx.agent('ask', { agent: 'helper', prompt: 'what?', output: answer }),
    })
    const rt = testRuntime({ schema: db.schema, workflows: [wf], host, hostAbortTimeoutMs: 150 })
    await rt.open()
    try {
      const { runId } = await rt.start(wf, {}, { purpose: 'build' })
      await until(async () => (await sql.step(runId, 'ask'))?.status === 'running', 'agent step running')
      await Bun.sleep(100)
      await rt.cancel(runId)
      expect((await rt.wait(runId, { pollMs: 25 })).status).toBe('cancelled')
      expect(aborts).toBeGreaterThan(0)
    } finally {
      const outcome = await Promise.race([rt.close().then(() => 'closed'), Bun.sleep(5000).then(() => 'hung')])
      expect(outcome).toBe('closed')
    }
  })
})

describe('fan-out concurrency limit (F31)', () => {
  function fanOutWorkflows(id: string, concurrency: number | undefined) {
    const g = { now: 0, peak: 0 }
    const child = defineWorkflow({
      id: `${id}.child`,
      version: 'v1',
      input: z.object({ i: z.number() }),
      output: z.object({ i: z.number() }),
      async run(ctx, input) {
        await ctx.step('hold', async () => {
          g.now++
          g.peak = Math.max(g.peak, g.now)
          await Bun.sleep(60)
          g.now--
          return null
        })
        return { i: input.i }
      },
    })
    const parent = defineWorkflow({
      id: `${id}.parent`,
      version: 'v1',
      input: empty,
      output: z.object({ order: z.array(z.number()) }),
      async run(ctx) {
        const inputs = Array.from({ length: 7 }, (_, i) => ({ i }))
        const results = await ctx.workflow(
          'kids',
          child,
          inputs,
          concurrency === undefined ? undefined : { concurrency },
        )
        return { order: results.map((r) => r?.i ?? -1) }
      },
    })
    return { g, child, parent }
  }

  test('never runs more children at once than the limit, and keeps input order', async () => {
    const { g, child, parent } = fanOutWorkflows('robust.limited', 2)
    const rt = testRuntime({ schema: db.schema, workflows: [parent, child] })
    await rt.open()
    try {
      const { runId } = await rt.start(parent, {}, { purpose: 'build' })
      expect(await rt.wait(runId, { pollMs: 25 })).toMatchObject({
        status: 'done',
        output: { order: [0, 1, 2, 3, 4, 5, 6] },
      })
      expect(g.peak).toBe(2)
    } finally {
      await rt.close()
    }
  })

  test('without a limit every child starts at once', async () => {
    const { g, child, parent } = fanOutWorkflows('robust.unlimited', undefined)
    const rt = testRuntime({ schema: db.schema, workflows: [parent, child] })
    await rt.open()
    try {
      const { runId } = await rt.start(parent, {}, { purpose: 'build' })
      expect((await rt.wait(runId, { pollMs: 25 })).status).toBe('done')
      expect(g.peak).toBe(7)
    } finally {
      await rt.close()
    }
  })

  test('a limit that is not a positive integer fails the run', async () => {
    const { child, parent } = fanOutWorkflows('robust.bad-limit', 0)
    const rt = testRuntime({ schema: db.schema, workflows: [parent, child] })
    await rt.open()
    try {
      const { runId } = await rt.start(parent, {}, { purpose: 'build' })
      const done = await rt.wait(runId, { pollMs: 25 })
      expect(done.status).toBe('failed')
      expect(done.error?.message).toContain('concurrency must be a positive integer')
    } finally {
      await rt.close()
    }
  })
})

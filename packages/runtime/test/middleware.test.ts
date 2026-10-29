import { afterAll, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import {
  AdmissionRefused,
  defineWorkflow,
  type Json,
  type Middleware,
  type RunPreArgs,
  type StepPostArgs,
  type StepPreArgs,
  WorkflowError,
} from '../src/index.ts'
import { FakeAgentHost } from '../src/testing.ts'
import { captureLogger, freshSchema, inspector, testRuntime, until } from './support/pg.ts'

const db = freshSchema('mw')
const sql = inspector(db.schema)

afterAll(async () => {
  await sql.close()
  await db.drop()
})

const empty = z.object({})

describe('middleware', () => {
  test('hooks run in list order around run and steps, with the run-record facts', async () => {
    const log: string[] = []
    const runPres: RunPreArgs[] = []
    const stepPres: StepPreArgs[] = []
    const tagged = (name: string): Middleware => ({
      name,
      runPre: (a) => {
        log.push(`${name}:runPre`)
        runPres.push(a)
      },
      stepPre: (a) => {
        log.push(`${name}:stepPre:${a.stepId}`)
        stepPres.push(a)
      },
      stepPost: (a) => void log.push(`${name}:stepPost:${a.stepId}:${a.status}`),
      runPost: (a) => void log.push(`${name}:runPost:${a.status}`),
    })
    const wf = defineWorkflow({
      id: 'mw.order',
      version: 'v7',
      input: z.object({ q: z.string() }),
      output: empty,
      async run(ctx) {
        await ctx.step('one', () => 1)
        return {}
      },
    })
    const rt = testRuntime({ schema: db.schema, workflows: [wf], middleware: [tagged('a'), tagged('b')] })
    await rt.open()
    try {
      const traceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'
      const { runId } = await rt.start(wf, { q: 'hi' }, { purpose: 'eval', traceparent })
      await rt.wait(runId)
      await until(() => log.length === 8, 'all hooks')
      expect(log).toEqual([
        'a:runPre',
        'b:runPre',
        'a:stepPre:one',
        'b:stepPre:one',
        'a:stepPost:one:done',
        'b:stepPost:one:done',
        'a:runPost:done',
        'b:runPost:done',
      ])
      expect(runPres[0]).toEqual({
        runId,
        workflowId: 'mw.order',
        version: 'v7',
        purpose: 'eval',
        parentId: null,
        rootId: runId,
        input: { q: 'hi' },
        traceparent,
        resume: false,
      })
      expect(stepPres[0]).toMatchObject({
        runId,
        stepId: 'one',
        kind: 'code',
        status: 'running',
        attempt: 1,
        replay: false,
      })
    } finally {
      await rt.close()
    }
  })

  test('runPre gets resume and stepPre gets replay on a resumed run', async () => {
    const runPres: RunPreArgs[] = []
    const stepPres: StepPreArgs[] = []
    const mw: Middleware = {
      name: 'flags',
      runPre: (a) => void runPres.push(a),
      stepPre: (a) => void stepPres.push(a),
    }
    let calls = 0
    const wf = defineWorkflow({
      id: 'mw.resume',
      version: 'v1',
      input: empty,
      output: empty,
      async run(ctx) {
        await ctx.step('slow', async () => {
          calls++
          if (calls === 1) await Bun.sleep(5000)
          return null
        })
        return {}
      },
    })
    const first = testRuntime({ schema: db.schema, workflows: [wf], middleware: [mw] })
    await first.open()
    const { runId } = await first.start(wf, {}, { purpose: 'build' })
    await until(() => calls === 1, 'first attempt')
    await first.close()
    const second = testRuntime({ schema: db.schema, workflows: [wf], middleware: [mw] })
    await second.open()
    try {
      expect((await second.wait(runId)).status).toBe('done')
      expect(runPres.map((a) => a.resume)).toEqual([false, true])
      expect(stepPres.map((a) => [a.replay, a.attempt])).toEqual([
        [false, 1],
        [true, 2],
      ])
    } finally {
      await second.close()
    }
  })

  test('AdmissionRefused in runPre fails a new run before its body runs', async () => {
    let ran = false
    const statuses: string[] = []
    const wallet: Middleware = {
      name: 'wallet',
      runPre: () => {
        throw new AdmissionRefused('wallet empty')
      },
      runPost: (a) => void statuses.push(a.status),
    }
    const wf = defineWorkflow({
      id: 'mw.refuse',
      version: 'v1',
      input: empty,
      output: empty,
      run: async () => {
        ran = true
        return {}
      },
    })
    const rt = testRuntime({ schema: db.schema, workflows: [wf], middleware: [wallet] })
    await rt.open()
    try {
      const { runId } = await rt.start(wf, {}, { purpose: 'prod' })
      const result = await rt.wait(runId)
      expect(result).toMatchObject({ status: 'failed', error: { kind: 'admission_refused', message: 'wallet empty' } })
      expect(ran).toBe(false)
      expect(statuses).toEqual(['failed'])
    } finally {
      await rt.close()
    }
  })

  test('AdmissionRefused on resume is logged and ignored', async () => {
    let refuse = false
    const gate: Middleware = {
      name: 'gate',
      runPre: () => {
        if (refuse) throw new AdmissionRefused('closed now')
      },
    }
    let calls = 0
    const wf = defineWorkflow({
      id: 'mw.refuse-resume',
      version: 'v1',
      input: empty,
      output: empty,
      async run(ctx) {
        await ctx.step('slow', async () => {
          calls++
          if (calls === 1) await Bun.sleep(5000)
          return null
        })
        return {}
      },
    })
    const first = testRuntime({ schema: db.schema, workflows: [wf], middleware: [gate] })
    await first.open()
    const { runId } = await first.start(wf, {}, { purpose: 'build' })
    await until(() => calls === 1, 'first attempt')
    await first.close()
    refuse = true
    const logger = captureLogger()
    const second = testRuntime({ schema: db.schema, workflows: [wf], middleware: [gate], logger })
    await second.open()
    try {
      expect((await second.wait(runId)).status).toBe('done')
      expect(logger.lines.some((l) => l.message.includes('runPre threw on resume'))).toBe(true)
    } finally {
      await second.close()
    }
  })

  test('a throwing post-hook after done never downgrades the committed outcome', async () => {
    const throwing: Middleware = {
      name: 'broken-record',
      stepPost: () => {
        throw new Error('record sink down')
      },
      runPost: () => {
        throw new Error('record sink down')
      },
    }
    const wf = defineWorkflow({
      id: 'mw.post-throws',
      version: 'v1',
      input: empty,
      output: z.object({ n: z.number() }),
      async run(ctx) {
        return { n: await ctx.step('n', () => 1) }
      },
    })
    const logger = captureLogger()
    const rt = testRuntime({ schema: db.schema, workflows: [wf], middleware: [throwing], logger })
    await rt.open()
    try {
      const { runId } = await rt.start(wf, {}, { purpose: 'build' })
      expect(await rt.wait(runId)).toMatchObject({ status: 'done', output: { n: 1 } })
      expect(await sql.step(runId, 'n')).toMatchObject({ status: 'done' })
      await until(() => logger.lines.filter((l) => l.level === 'error').length >= 2, 'both hook errors logged')
      await Bun.sleep(100)
      expect((await sql.run(runId))?.status).toBe('done')
    } finally {
      await rt.close()
    }
  })

  test('a throwing stepPre fails the step as middleware (runaway caps)', async () => {
    let ran = false
    const cap: Middleware = {
      name: 'cap',
      stepPre: (a) => {
        if (a.stepId === 'expensive') throw new Error('runaway cap')
      },
    }
    const wf = defineWorkflow({
      id: 'mw.cap',
      version: 'v1',
      input: empty,
      output: empty,
      async run(ctx) {
        await ctx.step('expensive', () => {
          ran = true
          return null
        })
        return {}
      },
    })
    const rt = testRuntime({ schema: db.schema, workflows: [wf], middleware: [cap] })
    await rt.open()
    try {
      const { runId } = await rt.start(wf, {}, { purpose: 'build' })
      expect((await rt.wait(runId)).status).toBe('failed')
      expect(ran).toBe(false)
      expect(await sql.step(runId, 'expensive')).toMatchObject({ status: 'failed', error_kind: 'middleware' })
    } finally {
      await rt.close()
    }
  })

  test('a throwing runPost is re-delivered until it succeeds; a run whose hooks always throw stops at the cap', async () => {
    const calls = new Map<string, number>()
    const flaky: Middleware = {
      name: 'flaky-record',
      runPost: (a) => {
        const n = (calls.get(a.runId) ?? 0) + 1
        calls.set(a.runId, n)
        if (a.input && (a.input as { always?: boolean }).always) throw new Error('sink down for good')
        if (n < 3) throw new Error(`sink down (${n})`)
      },
    }
    const wf = defineWorkflow({
      id: 'mw.post-retry',
      version: 'v1',
      input: z.object({ always: z.boolean() }),
      output: empty,
      run: async () => ({}),
    })
    const logger = captureLogger()
    const rt = testRuntime({
      schema: db.schema,
      workflows: [wf],
      middleware: [flaky],
      logger,
      maxPostHookAttempts: 4,
    })
    await rt.open()
    try {
      const ids = await Promise.all(
        [false, false, true].map(async (always) => (await rt.start(wf, { always }, { purpose: 'build' })).runId),
      )
      const [a, b, never] = ids as [string, string, string]
      await until(
        async () => {
          const rows = await Promise.all(ids.map((id) => sql.run(id)))
          return rows.every((r) => r?.post_hooks_at)
        },
        'every runPost delivered or given up',
        10_000,
      )
      expect(calls.get(a)).toBe(3)
      expect(calls.get(b)).toBe(3)
      expect((await sql.run(a))?.post_hooks_attempts).toBe(2)
      expect(calls.get(never)).toBe(4)
      expect((await sql.run(never))?.post_hooks_attempts).toBe(4)
      // delivered after retries is not a give-up; only the run that failed every attempt says so
      expect((await sql.run(a))?.post_hooks_failed_at).toBeNull()
      expect((await sql.run(never))?.post_hooks_failed_at).toBeInstanceOf(Date)
      expect(await rt.getRun(a)).toMatchObject({ postHooksDone: true, postHooksFailed: false })
      expect(await rt.getRun(never)).toMatchObject({ postHooksDone: true, postHooksFailed: true })
      expect(logger.lines.filter((l) => l.message.startsWith('runPost failed every attempt'))).toHaveLength(1)
      await Bun.sleep(300)
      expect(calls.get(never)).toBe(4)
    } finally {
      await rt.close()
    }
  })

  test('a throwing toolPre fails the agent step with the hook error kind, aborts the session, no retry', async () => {
    class RunawayCap extends WorkflowError {
      constructor() {
        super('timeout', 'tool calls far above normal')
      }
    }
    let tools = 0
    const cap: Middleware = {
      name: 'cap',
      toolPre: () => {
        tools++
        if (tools >= 3) throw new RunawayCap()
      },
    }
    const posts: StepPostArgs[] = []
    const seen: Middleware = { name: 'seen', stepPost: (a) => void posts.push(a) }
    const host = new FakeAgentHost(async (s) => {
      await s.sleep(30) // the session starts at the prompt; let the step attach its waiter first
      for (let i = 0; i < 10; i++) await s.tool('grep', { i }, 'hit')
      return { output: { done: true } }
    })
    const wf = defineWorkflow({
      id: 'mw.tool-cap',
      version: 'v1',
      input: empty,
      output: empty,
      async run(ctx) {
        await ctx.agent('loop', { agent: 'a', prompt: 'go', retry: { attempts: 3, backoffMs: 1 } })
        return {}
      },
    })
    const rt = testRuntime({ schema: db.schema, workflows: [wf], host, middleware: [cap, seen] })
    await rt.open()
    try {
      const { runId } = await rt.start(wf, {}, { purpose: 'build' })
      expect(await rt.wait(runId)).toMatchObject({ status: 'failed', error: { kind: 'step_failed' } })
      expect(await sql.step(runId, 'loop')).toMatchObject({ status: 'failed', error_kind: 'timeout', attempts: 1 })
      expect(String((await sql.step(runId, 'loop'))?.error)).toContain('tool calls far above normal')
      expect(tools).toBe(3)
      expect(host.count('open')).toBe(1)
      expect(host.count('abort')).toBe(1)
      // stepPost carries the handle of the session the failed attempt used.
      expect(posts[0]).toMatchObject({ stepId: 'loop', status: 'failed', handle: { sessionId: 'ses_1' } as Json })
    } finally {
      await rt.close()
    }
  })

  test('a throwing toolPre with a plain error fails as middleware; stepPost of a code step has no handle', async () => {
    const cap: Middleware = {
      name: 'cap',
      toolPre: () => {
        throw new Error('no')
      },
    }
    const posts: StepPostArgs[] = []
    const seen: Middleware = { name: 'seen', stepPost: (a) => void posts.push(a) }
    const host = new FakeAgentHost(async (s) => {
      await s.sleep(30)
      await s.tool('read', {}, 'x')
      return { output: {} }
    })
    const wf = defineWorkflow({
      id: 'mw.tool-plain',
      version: 'v1',
      input: empty,
      output: empty,
      async run(ctx) {
        await ctx.step('code', () => 1)
        await ctx.agent('ask', { agent: 'a', prompt: 'go' })
        return {}
      },
    })
    const rt = testRuntime({ schema: db.schema, workflows: [wf], host, middleware: [cap, seen] })
    await rt.open()
    try {
      const { runId } = await rt.start(wf, {}, { purpose: 'build' })
      await rt.wait(runId)
      expect(await sql.step(runId, 'ask')).toMatchObject({ status: 'failed', error_kind: 'middleware' })
      expect(posts.find((p) => p.stepId === 'code')?.handle).toBeNull()
    } finally {
      await rt.close()
    }
  })
})

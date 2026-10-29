// Two platform processes (concept §8: the host and the audio process) share one journal. Each runtime is given the
// workflows its process serves; recovery, leases and post-hook redelivery must stay inside that set, so a run whose
// process is down waits for it instead of being taken over (or failed) by the other.
import { afterAll, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { defineWorkflow, type Middleware, WorkflowError } from '../src/index.ts'
import { freshSchema, inspector, testRuntime, until } from './support/pg.ts'

const db = freshSchema('procs')
const sql = inspector(db.schema)

afterAll(async () => {
  await sql.close()
  await db.drop()
})

const empty = z.object({})

/** A promise the test resolves; `opened` resolves when a body first waits on it. */
function latch() {
  let release = () => {}
  let opened = () => {}
  const l = {
    released: new Promise<void>((resolve) => {
      release = resolve
    }),
    opened: new Promise<void>((resolve) => {
      opened = resolve
    }),
    release: () => release(),
    wait(signal: AbortSignal) {
      opened()
      return new Promise<void>((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        void l.released.then(resolve)
      })
    },
  }
  return l
}

/** Every run id a runtime's middleware saw, by hook. */
function spy(name: string, options: { failPost?: (workflowId: string) => boolean } = {}) {
  const seen = { pre: [] as string[], post: [] as string[] }
  const middleware: Middleware = {
    name,
    runPre: (args) => void seen.pre.push(args.runId),
    runPost: (args) => {
      seen.post.push(args.runId)
      if (options.failPost?.(args.workflowId)) throw new Error('post hook down')
    },
  }
  return { seen, middleware }
}

describe('two processes on one journal', () => {
  test('each recovers, leases and redelivers only its own workflows; a run whose process is down waits', async () => {
    const gate = latch()
    const aBodies: string[] = []
    const a = defineWorkflow({
      id: 'proc.a',
      version: 'v1',
      input: empty,
      output: empty,
      async run(ctx) {
        await ctx.step('work', () => {
          aBodies.push(ctx.runId)
          return null
        })
        return {}
      },
    })
    const b = defineWorkflow({
      id: 'proc.b',
      version: 'v1',
      input: empty,
      output: empty,
      concurrency: 1,
      async run(ctx) {
        await ctx.step('work', async ({ signal }) => {
          await gate.wait(signal)
          return null
        })
        return {}
      },
    })
    const hooked = defineWorkflow({
      id: 'proc.b-hooked',
      version: 'v1',
      input: empty,
      output: empty,
      run: async () => ({}),
    })

    const bSpy = spy('b', { failPost: (id) => id === hooked.id })
    const aSpy = spy('a')
    const b1 = testRuntime({
      schema: db.schema,
      workflows: [b, hooked],
      middleware: [bSpy.middleware],
      maxPostHookAttempts: 1000,
    })
    const other = testRuntime({ schema: db.schema, workflows: [a], middleware: [aSpy.middleware] })
    let b2: ReturnType<typeof testRuntime> | undefined
    let b1Closed = false
    await b1.open()
    await other.open()
    try {
      // Process B: one run mid-step, one pending behind the concurrency limit, one ended with its post hook undelivered.
      const running = await b1.start(b, {}, { purpose: 'test' })
      await gate.opened
      const pending = await b1.start(b, {}, { purpose: 'test' })
      const undelivered = await b1.start(hooked, {}, { purpose: 'test' })
      expect((await b1.wait(undelivered.runId, { pollMs: 20 })).status).toBe('done')
      await until(() => bSpy.seen.post.includes(undelivered.runId), 'the failing post hook')
      b1Closed = true
      await b1.close() // process B goes down: its rows stay as they are

      // Process A keeps working and runs its recovery passes, explicitly and on its own ticks.
      const own = await other.start(a, {}, { purpose: 'test' })
      expect((await other.wait(own.runId, { pollMs: 20 })).status).toBe('done')
      for (let i = 0; i < 5; i++) await other.recover()

      const bIds = [running.runId, pending.runId, undelivered.runId]
      expect(aSpy.seen.pre.filter((id) => bIds.includes(id))).toEqual([])
      expect(aSpy.seen.post.filter((id) => bIds.includes(id))).toEqual([])
      expect(aBodies).toEqual([own.runId])
      const [r, p, u] = await Promise.all(bIds.map((id) => sql.run(id)))
      expect(r?.status).toBe('running')
      expect(r?.drives).toBe(1) // never claimed by A
      expect(r?.error).toBeNull()
      expect(p?.status).toBe('pending')
      expect(u?.post_hooks_at).toBeNull()

      // Process B comes back: it resumes its runs and delivers the hook; A's spies still saw none of them.
      gate.release()
      const bSpy2 = spy('b2')
      b2 = testRuntime({ schema: db.schema, workflows: [b, hooked], middleware: [bSpy2.middleware] })
      await b2.open()
      for (const id of [running.runId, pending.runId]) {
        expect((await b2.wait(id, { pollMs: 20 })).status).toBe('done')
      }
      await until(async () => (await sql.run(undelivered.runId))?.post_hooks_at, 'the redelivered post hook')
      expect(bSpy2.seen.post).toContain(undelivered.runId)
      expect((await sql.run(running.runId))?.drives).toBe(2)
      expect(aSpy.seen.pre.filter((id) => bIds.includes(id))).toEqual([])
      expect(aSpy.seen.post.filter((id) => bIds.includes(id))).toEqual([])
    } finally {
      gate.release()
      await b2?.close()
      await other.close()
      if (!b1Closed) await b1.close()
    }
  })
})

describe('a caller-chosen run id', () => {
  test('the run gets the id; a used id, a malformed one or one beside an idempotency key is refused', async () => {
    const wf = defineWorkflow({ id: 'proc.chosen', version: 'v1', input: empty, output: empty, run: async () => ({}) })
    const rt = testRuntime({ schema: db.schema, workflows: [wf] })
    await rt.open()
    try {
      const runId = Bun.randomUUIDv7()
      expect((await rt.start(wf, {}, { purpose: 'test', runId })).runId).toBe(runId)
      expect((await rt.wait(runId, { pollMs: 20 })).status).toBe('done')
      const refused = (promise: Promise<unknown>) =>
        promise.then(
          () => 'started',
          (error: unknown) =>
            error instanceof WorkflowError ? `${error.kind}: ${error.message}` : `untyped: ${String(error)}`,
        )
      expect(await refused(rt.start(wf, {}, { purpose: 'test', runId }))).toBe(
        `invalid_input: run id ${runId} is already used`,
      )
      // Two starts racing for one fresh id: the insert decides, exactly one wins.
      const raced = Bun.randomUUIDv7()
      const outcomes = await Promise.all([1, 2].map(() => refused(rt.start(wf, {}, { purpose: 'test', runId: raced }))))
      expect(outcomes.sort()).toEqual(['invalid_input: run id ' + raced + ' is already used', 'started'].sort())
      expect(await refused(rt.start(wf, {}, { purpose: 'test', runId: 'not-a-uuid' }))).toContain(
        'invalid_input: start: runId must be a UUID',
      )
      expect(
        await refused(rt.start(wf, {}, { purpose: 'test', runId: Bun.randomUUIDv7(), idempotencyKey: 'k' })),
      ).toContain('exclude each other')
    } finally {
      await rt.close()
    }
  })
})

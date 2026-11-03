// A parented start (`StartOptions.parentId`, what `agw eval run` starts its cases with): a child of the parent row that
// stays its own root, so it is leased, recovered and redelivered on its own by the process that serves its workflow.
import { afterAll, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { defineWorkflow, type Middleware, WorkflowError } from '../src/index.ts'
import { freshSchema, inspector, testRuntime, until } from '@agent-workflows/testing/pg'

const db = freshSchema('pstart')
const sql = inspector(db.schema)

afterAll(async () => {
  await sql.close()
  await db.drop()
})

const empty = z.object({})
const sha256 = (text: string) => new Bun.CryptoHasher('sha256').update(text).digest('hex')

function spy() {
  const pre: string[] = []
  const middleware: Middleware = { name: 'spy', runPre: (args) => void pre.push(args.runId) }
  return { pre, middleware }
}

describe('a parented start', () => {
  test('inherits caller, project, workspace and trace; stays its own root; refuses its own origin', async () => {
    const parent = defineWorkflow({
      id: 'ps.parent',
      version: 'v1',
      input: empty,
      output: empty,
      run: async () => ({}),
    })
    const child = defineWorkflow({ id: 'ps.child', version: 'v1', input: empty, output: empty, run: async () => ({}) })
    const rt = testRuntime({ schema: db.schema, workflows: [parent, child] })
    await rt.open()
    try {
      const traceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'
      const p = await rt.start(parent, {}, { purpose: 'prod', caller: 'hermes', project: 'demo', workspace: 'work' })
      const traced = await rt.start(parent, {}, { purpose: 'prod', traceparent })
      const c = await rt.start(child, {}, { purpose: 'eval', parentId: p.runId, idempotencyKey: 'ps:1' })
      const t = await rt.start(child, {}, { purpose: 'eval', parentId: traced.runId })
      for (const id of [p.runId, traced.runId, c.runId, t.runId]) expect((await rt.wait(id)).status).toBe('done')

      expect(await sql.run(c.runId)).toMatchObject({
        parent_id: p.runId,
        root_id: c.runId,
        purpose: 'eval',
        caller: 'hermes',
        project: 'demo',
        workspace: 'work',
        idempotency_key: 'ps:1',
        // No caller trace: the parent's derived trace, under its admission span.
        traceparent: `00-${sha256(`agw-trace:${p.runId}`).slice(0, 32)}-${sha256(`agw-run-span:${p.runId}`).slice(0, 16)}-01`,
        trace_id: sha256(`agw-trace:${p.runId}`).slice(0, 32),
      })
      expect(await sql.run(t.runId)).toMatchObject({ traceparent, trace_id: '0af7651916cd43dd8448eb211c80319c' })

      // The same key again is the same run.
      expect(await rt.start(child, {}, { purpose: 'eval', parentId: p.runId, idempotencyKey: 'ps:1' })).toEqual(c)
      // The origin comes from the parent: naming it too, or a parent that does not exist, is refused.
      const refused = (options: Parameters<typeof rt.start>[2]) => rt.start(child, {}, options).catch((e) => e)
      const own = await refused({ purpose: 'eval', parentId: p.runId, caller: 'oc' })
      expect(own).toBeInstanceOf(WorkflowError)
      expect(own.message).toContain('parentId excludes caller')
      const gone = await refused({ purpose: 'eval', parentId: 'no-such-run' })
      expect(gone).toBeInstanceOf(WorkflowError)
      expect(gone.message).toContain('parent run no-such-run not found')
    } finally {
      await rt.close()
    }
  })

  test("is driven by the process that serves its workflow, never by the parent's", async () => {
    const parent = defineWorkflow({ id: 'ps.host', version: 'v1', input: empty, output: empty, run: async () => ({}) })
    const served = defineWorkflow({ id: 'ps.audio', version: 'v1', input: empty, output: empty, run: async () => ({}) })
    const hostSpy = spy()
    const audioSpy = spy()
    const host = testRuntime({ schema: db.schema, workflows: [parent], middleware: [hostSpy.middleware] })
    const audio = testRuntime({ schema: db.schema, workflows: [served], middleware: [audioSpy.middleware] })
    // Writes rows only: never opened, so it neither kicks nor recovers what it starts.
    const writer = testRuntime({ schema: db.schema, workflows: [] })
    await host.open()
    try {
      const p = await host.start(parent, {}, { purpose: 'prod' })
      expect((await host.wait(p.runId)).status).toBe('done')
      const c = await writer.start(served, {}, { purpose: 'eval', parentId: p.runId })
      await Bun.sleep(300) // several of the host's recovery ticks: it does not serve the workflow
      expect((await sql.run(c.runId))?.status).toBe('pending')
      await audio.open()
      expect((await audio.wait(c.runId, { pollMs: 20 })).status).toBe('done')
      expect(audioSpy.pre).toEqual([c.runId])
      expect(hostSpy.pre).toEqual([p.runId])
    } finally {
      await Promise.all([host.close(), audio.close(), writer.close()])
    }
  })

  test("holds its workflow's concurrency slot like a top-level run", async () => {
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const parent = defineWorkflow({
      id: 'ps.slot-parent',
      version: 'v1',
      input: empty,
      output: empty,
      run: async () => ({}),
    })
    const limited = defineWorkflow({
      id: 'ps.limited',
      version: 'v1',
      input: z.object({ i: z.number() }),
      output: empty,
      concurrency: 1,
      async run(ctx) {
        await ctx.step('hold', () => gate.then(() => null))
        return {}
      },
    })
    const rt = testRuntime({ schema: db.schema, workflows: [parent, limited] })
    await rt.open()
    try {
      const p = await rt.start(parent, {}, { purpose: 'prod' })
      const a = await rt.start(limited, { i: 0 }, { purpose: 'eval', parentId: p.runId })
      await until(async () => (await sql.run(a.runId))?.status === 'running', 'first case running')
      const b = await rt.start(limited, { i: 1 }, { purpose: 'eval', parentId: p.runId })
      await Bun.sleep(300)
      expect((await sql.run(b.runId))?.status).toBe('pending')
      release()
      expect((await rt.wait(b.runId, { pollMs: 20 })).status).toBe('done')
    } finally {
      release()
      await rt.close()
    }
  })
})

describe('cancelling a run with parented starts', () => {
  /** A body that only ends by its abort. */
  const hold = ({ signal }: { signal: AbortSignal }) =>
    new Promise<null>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)))
  const parent = defineWorkflow({
    id: 'ps.cx.parent',
    version: 'v1',
    input: empty,
    output: empty,
    async run(ctx) {
      await ctx.step('hold', hold)
      return {}
    },
  })
  const caseWf = defineWorkflow({
    id: 'ps.cx.case',
    version: 'v1',
    input: z.object({ i: z.number() }),
    output: empty,
    async run(ctx) {
      await ctx.step('hold', hold)
      return {}
    },
  })
  /** Served by no runtime here: a grandchild that stays pending. */
  const unserved = defineWorkflow({
    id: 'ps.cx.later',
    version: 'v1',
    input: empty,
    output: empty,
    run: async () => ({}),
  })
  const running = (id: string) => until(async () => (await sql.run(id))?.status === 'running', `${id} running`)

  test("a cancel requested while the parent's process is down still ends every descendant", async () => {
    const first = testRuntime({ schema: db.schema, workflows: [parent, caseWf] })
    const writer = testRuntime({ schema: db.schema, workflows: [] })
    let second: ReturnType<typeof testRuntime> | undefined
    let firstClosed = false
    await first.open()
    try {
      const p = await first.start(parent, {}, { purpose: 'prod' })
      const c = await first.start(caseWf, { i: 0 }, { purpose: 'eval', parentId: p.runId })
      const g = await writer.start(unserved, {}, { purpose: 'eval', parentId: c.runId })
      await running(p.runId)
      await running(c.runId)
      firstClosed = true
      await first.close() // the parent's process goes down: both rows stay running, nobody aborted the case

      expect(await writer.cancel(p.runId)).toBe(true)
      expect(await sql.run(g.runId)).toMatchObject({ status: 'cancelled' }) // pending: ended at once
      second = testRuntime({ schema: db.schema, workflows: [parent, caseWf] })
      await second.open()
      expect((await second.wait(p.runId, { pollMs: 20 })).status).toBe('cancelled')
      expect((await second.wait(c.runId, { pollMs: 20 })).status).toBe('cancelled')
    } finally {
      await Promise.all([firstClosed ? null : first.close(), writer.close(), second?.close()])
    }
  })

  test('a live cancel reaches a parented start driven by another process', async () => {
    const host = testRuntime({ schema: db.schema, workflows: [parent] })
    const audio = testRuntime({ schema: db.schema, workflows: [caseWf] })
    await host.open()
    await audio.open()
    try {
      const p = await host.start(parent, {}, { purpose: 'prod' })
      const c = await audio.start(caseWf, { i: 1 }, { purpose: 'eval', parentId: p.runId })
      await running(p.runId)
      await running(c.runId)
      await host.cancel(p.runId)
      expect((await host.wait(p.runId, { pollMs: 20 })).status).toBe('cancelled')
      expect((await audio.wait(c.runId, { pollMs: 20 })).status).toBe('cancelled')
    } finally {
      await Promise.all([host.close(), audio.close()])
    }
  })
})

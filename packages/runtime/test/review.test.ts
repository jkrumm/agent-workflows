// Regression tests for the PR #7 review round: one per finding.
import { afterAll, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { defineWorkflow, type Json, type Middleware, type RunPostArgs, type Runtime } from '../src/index.ts'
import { jsonViolation } from '../src/json.ts'
import { FakeAgentHost } from '../src/testing.ts'
import { freshSchema, inspector, testRuntime, until } from './support/pg.ts'

const db = freshSchema('rev')
const sql = inspector(db.schema)

afterAll(async () => {
  await sql.close()
  await db.drop()
})

const empty = z.object({})

describe('lease grace (#2)', () => {
  test('after a lease loss mid-effect, the next process waits out the grace before re-running the body', async () => {
    const runs: { start: number; end?: number }[] = []
    const wf = defineWorkflow({
      id: 'rev.effect-grace',
      version: 'v1',
      input: empty,
      output: empty,
      async run(ctx) {
        await ctx.effect('send', async () => {
          const entry: { start: number; end?: number } = { start: Date.now() }
          runs.push(entry)
          if (runs.length === 1) await Bun.sleep(600) // ignores the abort: an outside call already in flight
          entry.end = Date.now()
          return null
        })
        return {}
      },
    })
    const grace = 1000
    const a = testRuntime({
      schema: db.schema,
      workflows: [wf],
      bodyGraceMs: grace,
      recoveryIntervalMs: 60_000,
      infraBackoffMs: 60_000,
    })
    const b = testRuntime({ schema: db.schema, workflows: [wf], bodyGraceMs: grace, recoveryIntervalMs: 50 })
    await a.open()
    const { runId } = await a.start(wf, {}, { purpose: 'build' })
    await until(() => runs.length === 1, 'first effect start')
    await sql.pool.query('select pg_terminate_backend(pid) from pg_stat_activity where application_name = $1', [
      `agw-lease:${db.schema}`,
    ])
    await b.open()
    try {
      expect((await b.wait(runId)).status).toBe('done')
      expect(runs).toHaveLength(2)
      const [first, second] = runs as [{ start: number; end: number }, { start: number }]
      expect(second.start).toBeGreaterThanOrEqual(first.end)
      expect(second.start - first.start).toBeGreaterThanOrEqual(grace - 50)
    } finally {
      await Promise.all([a.close(), b.close()])
    }
  })
})

describe('no body after an abort (#3)', () => {
  test('a cancel that lands during stepPre never starts the step body', async () => {
    let rt: Runtime | null = null
    let ran = false
    const canceller: Middleware = {
      name: 'cancel-in-pre',
      stepPre: async (a) => {
        await rt?.cancel(a.runId)
      },
    }
    const wf = defineWorkflow({
      id: 'rev.no-body',
      version: 'v1',
      input: empty,
      output: empty,
      async run(ctx) {
        await ctx.step('never', () => {
          ran = true
          return null
        })
        return {}
      },
    })
    rt = testRuntime({ schema: db.schema, workflows: [wf], middleware: [canceller] })
    await rt.open()
    try {
      const { runId } = await rt.start(wf, {}, { purpose: 'build' })
      expect((await rt.wait(runId)).status).toBe('cancelled')
      await Bun.sleep(50)
      expect(ran).toBe(false)
    } finally {
      await rt.close()
    }
  })
})

describe('jsonb-safe strings (#4)', () => {
  test('a lone surrogate fails the step at once as non_json_output, not as an infra retry', async () => {
    expect(jsonViolation('\uD800')).toContain('lone UTF-16 surrogate')
    expect(jsonViolation({ '\uDC00': 1 })).toContain('lone UTF-16 surrogate')
    expect(jsonViolation('😀')).toBeNull()
    let calls = 0
    const wf = defineWorkflow({
      id: 'rev.surrogate',
      version: 'v1',
      input: empty,
      output: empty,
      async run(ctx) {
        await ctx.step('broken', () => {
          calls++
          return 'half \uD83D emoji'
        })
        return {}
      },
    })
    const rt = testRuntime({ schema: db.schema, workflows: [wf] })
    await rt.open()
    try {
      const { runId } = await rt.start(wf, {}, { purpose: 'build' })
      expect((await rt.wait(runId)).status).toBe('failed')
      expect(calls).toBe(1)
      expect(await sql.step(runId, 'broken')).toMatchObject({ status: 'failed', error_kind: 'non_json_output' })
    } finally {
      await rt.close()
    }
  })
})

describe('run record (#5)', () => {
  test('runPost and the row agree on startedAt for a fresh run', async () => {
    const posts: RunPostArgs[] = []
    const wf = defineWorkflow({ id: 'rev.started', version: 'v1', input: empty, output: empty, run: async () => ({}) })
    const rt = testRuntime({
      schema: db.schema,
      workflows: [wf],
      middleware: [{ name: 'r', runPost: (a) => void posts.push(a) }],
    })
    await rt.open()
    try {
      const { runId } = await rt.start(wf, {}, { purpose: 'build' })
      await rt.wait(runId)
      await until(() => posts.length === 1, 'runPost')
      const row = await sql.run(runId)
      expect(posts[0]?.startedAt).toBeInstanceOf(Date)
      expect(posts[0]?.startedAt?.getTime()).toBe((row?.started_at as Date | undefined)?.getTime())
      expect(row?.started_at).toBeInstanceOf(Date)
    } finally {
      await rt.close()
    }
  })
})

describe('forgotten agent handles (#6)', () => {
  test('a failed attempt’s handle is cleared in the journal during the retry backoff', async () => {
    let n = 0
    const host = new FakeAgentHost(async () => {
      n++
      const output: Json = n === 1 ? { wrong: true } : { answer: 'ok' }
      return { output }
    })
    const answer = z.object({ answer: z.string() })
    const wf = defineWorkflow({
      id: 'rev.clear-handle',
      version: 'v1',
      input: empty,
      output: answer,
      run: (ctx) =>
        ctx.agent('ask', { agent: 'helper', prompt: 'q', output: answer, retry: { attempts: 2, backoffMs: 1500 } }),
    })
    const rt = testRuntime({ schema: db.schema, workflows: [wf], host })
    await rt.open()
    try {
      const { runId } = await rt.start(wf, {}, { purpose: 'build' })
      await until(() => n === 1, 'first attempt answered')
      await until(
        async () => {
          const step = await sql.step(runId, 'ask')
          return step?.status === 'running' && step.handle === null && n === 1
        },
        'handle cleared during backoff',
        1200,
      )
      expect((await rt.wait(runId)).output).toEqual({ answer: 'ok' })
    } finally {
      await rt.close()
    }
  })
})

describe('recovery (#7)', () => {
  test('runPost is re-delivered while every run lease is taken', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const posts: string[] = []
    const busy = defineWorkflow({
      id: 'rev.busy',
      version: 'v1',
      input: empty,
      output: empty,
      async run(ctx) {
        await ctx.step('hold', () => gate.then(() => null))
        return {}
      },
    })
    const other = defineWorkflow({ id: 'rev.other', version: 'v1', input: empty, output: empty, run: async () => ({}) })
    const rt = testRuntime({
      schema: db.schema,
      workflows: [busy, other],
      maxConcurrentRuns: 1,
      middleware: [{ name: 'r', runPost: (a) => void posts.push(a.runId) }],
    })
    const { runId: cancelled } = await rt.start(other, {}, { purpose: 'build' })
    await rt.cancel(cancelled) // ended while pending: its runPost comes from recovery
    await rt.open()
    const { runId: holder } = await rt.start(busy, {}, { purpose: 'build' })
    try {
      await until(async () => (await sql.run(holder))?.status === 'running', 'slot taken')
      await until(() => posts.includes(cancelled), 'runPost re-delivered with no free run lease')
    } finally {
      release()
      await rt.close()
    }
  })

  test('an orphan behind a page of runs held elsewhere is still reached', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const calls = new Map<string, number>()
    const slow = defineWorkflow({
      id: 'rev.page',
      version: 'v1',
      input: z.object({ hold: z.boolean() }),
      output: empty,
      async run(ctx, { hold }) {
        await ctx.step('work', async () => {
          calls.set(ctx.runId, (calls.get(ctx.runId) ?? 0) + 1)
          if (hold) await gate
          return null
        })
        return {}
      },
    })
    const holder = testRuntime({ schema: db.schema, workflows: [slow], maxConcurrentRuns: 6 })
    await holder.open()
    const held = await Promise.all(
      Array.from({ length: 6 }, () => holder.start(slow, { hold: true }, { purpose: 'build' })),
    )
    await until(() => calls.size === 6, 'six runs held elsewhere')
    // An orphan created after them: driven once by a process that went away mid-step.
    const ghost = testRuntime({ schema: db.schema, workflows: [slow] })
    await ghost.open()
    const { runId: orphan } = await ghost.start(slow, { hold: true }, { purpose: 'build' })
    await until(() => calls.get(orphan) === 1, 'orphan started')
    await ghost.close()
    const rescuer = testRuntime({ schema: db.schema, workflows: [slow], maxConcurrentRuns: 1 }) // pages of 2
    await rescuer.open()
    try {
      await until(() => calls.get(orphan) === 2, 'orphan re-claimed past the held page', 3000)
    } finally {
      release()
      await Promise.all(held.map(({ runId }) => holder.wait(runId)))
      await Promise.all([rescuer.close(), holder.close()])
    }
  })
})

describe('refusals (#8)', () => {
  test('hooks that throw undefined still refuse', async () => {
    let ran = false
    const wf = defineWorkflow({
      id: 'rev.undefined',
      version: 'v1',
      input: empty,
      output: empty,
      async run(ctx) {
        await ctx.step('s', () => {
          ran = true
          return null
        })
        return {}
      },
    })
    const stepGate: Middleware = {
      name: 'step-undefined',
      stepPre: () => {
        throw undefined
      },
    }
    const runGate: Middleware = {
      name: 'run-undefined',
      runPre: () => {
        throw undefined
      },
    }
    const a = testRuntime({ schema: db.schema, workflows: [wf], middleware: [stepGate] })
    await a.open()
    const { runId: stepRefused } = await a.start(wf, {}, { purpose: 'build' })
    expect(await a.wait(stepRefused)).toMatchObject({ status: 'failed', error: { kind: 'step_failed' } })
    expect(await sql.step(stepRefused, 's')).toMatchObject({ status: 'failed', error_kind: 'middleware' })
    await a.close()
    const b = testRuntime({ schema: db.schema, workflows: [wf], middleware: [runGate] })
    await b.open()
    const { runId: runRefused } = await b.start(wf, {}, { purpose: 'build' })
    expect(await b.wait(runRefused)).toMatchObject({ status: 'failed', error: { kind: 'middleware' } })
    await b.close()
    expect(ran).toBe(false)
  })
})

describe('idle timer (#9)', () => {
  test('a late progress() after the attempt finished does not re-arm the idle timer', async () => {
    let late: (() => void) | null = null
    let signal: AbortSignal | null = null
    const wf = defineWorkflow({
      id: 'rev.late-progress',
      version: 'v1',
      input: empty,
      output: empty,
      async run(ctx) {
        await ctx.step(
          'quick',
          (scope) => {
            late = scope.progress
            signal = scope.signal
            return null
          },
          { idleTimeoutMs: 50 },
        )
        return {}
      },
    })
    const rt = testRuntime({ schema: db.schema, workflows: [wf] })
    await rt.open()
    try {
      const { runId } = await rt.start(wf, {}, { purpose: 'build' })
      await rt.wait(runId)
      ;(late as (() => void) | null)?.()
      await Bun.sleep(120)
      expect((signal as AbortSignal | null)?.aborted).toBe(false)
    } finally {
      await rt.close()
    }
  })
})

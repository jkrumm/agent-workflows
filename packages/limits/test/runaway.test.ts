import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { defineWorkflow, type Middleware, type Runtime } from '@agent-workflows/runtime'
import { FakeAgentHost } from '@agent-workflows/runtime/testing'
import { z } from 'zod'
import {
  type CapDecision,
  DEFAULT_CEILING,
  type LimitDecision,
  type Metrics,
  RunawayCapExceeded,
  type RunawayCapOptions,
  runawayCap,
} from '../src/index.ts'
import {
  captureLogger,
  costUsage,
  freshSchema,
  inspector,
  p95,
  PG_URL,
  seedRuns,
  testRuntime,
  until,
} from './support.ts'

const db = freshSchema('lim_cap')
const sql = inspector(db.schema)
const open: { close(): Promise<void> }[] = []
const runtimes: Runtime[] = []

// One runtime at a time on the schema: an open one would claim the next test's runs without its middleware.
afterEach(async () => {
  for (const rt of runtimes.splice(0)) await rt.close()
})

afterAll(async () => {
  for (const o of open.reverse()) await o.close()
  await sql.close()
  await db.drop()
})

/** The rule plus a spy that keeps what its `stepPre` threw (the runtime wraps it into the step's error). */
function capWithSpy(options: Partial<RunawayCapOptions> = {}) {
  const decisions: LimitDecision[] = []
  const thrown: unknown[] = []
  const logger = captureLogger()
  const cap = runawayCap({
    connectionString: PG_URL,
    schema: db.schema,
    logger,
    onDecision: (d) => decisions.push(d),
    ...options,
  })
  open.push(cap)
  const spied: Middleware = {
    ...cap,
    stepPre: async (args) => {
      try {
        await cap.stepPre?.(args)
      } catch (err) {
        thrown.push(err)
        throw err
      }
    },
  }
  return { cap, spied, decisions, thrown, logger }
}

async function started(rt: Runtime) {
  await rt.open()
  runtimes.push(rt)
  return rt
}

const costInput = z.object({ cost: z.number() })
const empty = z.object({})

const threeSteps = (id: string) =>
  defineWorkflow({
    id,
    version: 'v1',
    input: costInput,
    output: empty,
    async run(ctx, { cost }) {
      await ctx.step('a', (s) => {
        s.addUsage(costUsage(cost, 1000))
        return 1
      })
      await ctx.step('b', () => 2)
      await ctx.step('c', () => 3)
      return {}
    },
  })

describe('runaway cap', () => {
  const learned = threeSteps('cap.learned')
  const history: Metrics[] = Array.from({ length: 30 }, (_, i) => ({
    cost: 0.01 * (i + 1),
    tokens: 1000 * (i + 1),
    wallMs: 1000 * (i + 1),
    steps: (i % 5) + 1,
  }))

  test('the cap is factor × p95 of the workflow own done runs', async () => {
    await started(testRuntime({ schema: db.schema, workflows: [learned] }))
    await seedRuns(sql.pool, db.schema, 'cap.learned', history)
    // Ignored: failed runs and other workflows.
    const huge = { cost: 1000, tokens: 1e9, wallMs: 1e8, steps: 400 }
    await seedRuns(sql.pool, db.schema, 'cap.learned', [huge, huge], { status: 'failed' })
    await seedRuns(
      sql.pool,
      db.schema,
      'cap.other',
      Array.from({ length: 25 }, () => huge),
    )

    const { cap } = capWithSpy()
    const caps = await cap.caps('cap.learned')
    expect(caps.basis.tree).toEqual({ kind: 'learned', sample: 30, factor: 10 })
    expect(caps.basis.steps).toEqual({ kind: 'learned', sample: 30, factor: 10 })
    expect(caps.p95.cost).toBeCloseTo(p95(history.map((h) => h.cost)), 6)
    expect(caps.values.cost).toBeCloseTo(10 * p95(history.map((h) => h.cost)), 6)
    expect(caps.values.tokens).toBeCloseTo(10 * p95(history.map((h) => h.tokens)), 3)
    expect(caps.values.wallMs).toBeCloseTo(10 * p95(history.map((h) => h.wallMs)), 0)
    expect(caps.values.steps).toBeCloseTo(10 * p95(history.map((h) => h.steps)), 6)

    const cheaper = runawayCap({ connectionString: PG_URL, schema: db.schema, factor: 3, logger: captureLogger() })
    open.push(cheaper)
    expect((await cheaper.caps('cap.learned')).values.cost).toBeCloseTo(3 * p95(history.map((h) => h.cost)), 6)
  })

  test('a run past the cap stops at the next step with RunawayCapExceeded; a normal run passes', async () => {
    const { cap, spied, decisions, thrown, logger } = capWithSpy()
    const rt = await started(testRuntime({ schema: db.schema, workflows: [learned], middleware: [spied] }))
    const costCap = (await cap.caps('cap.learned')).values.cost

    const normal = await rt.wait((await rt.start(learned, { cost: 0.2 }, { purpose: 'test' })).runId)
    expect(normal.status).toBe('done')

    const runaway = await rt.wait((await rt.start(learned, { cost: costCap + 1 }, { purpose: 'test' })).runId)
    expect(runaway.status).toBe('failed')
    expect(runaway.error?.kind).toBe('step_failed')
    const b = await sql.step(runaway.runId, 'b')
    expect(b?.status).toBe('failed')
    expect(b?.error_kind).toBe('middleware')
    expect(String(b?.error)).toContain('runaway cap: cost')
    expect(await sql.step(runaway.runId, 'c')).toBeUndefined()

    expect(thrown).toHaveLength(1)
    const err = thrown[0] as RunawayCapExceeded
    expect(err).toBeInstanceOf(RunawayCapExceeded)
    expect(err.metric).toBe('cost')
    expect(err.observed).toBeCloseTo(costCap + 1, 6)
    expect(err.cap).toBeCloseTo(costCap, 6)

    const refused = decisions.filter((d): d is CapDecision => d.rule === 'runaway-cap' && !d.allowed)
    expect(refused).toHaveLength(1)
    expect(refused[0]).toMatchObject({ runId: runaway.runId, stepId: 'b', exceeded: 'cost', hook: 'stepPre' })
    expect(logger.lines.some((l) => l.message === 'runaway cap exceeded')).toBe(true)
  })

  test('below the sample minimum the static ceiling applies', async () => {
    const fiveSteps = defineWorkflow({
      id: 'cap.static',
      version: 'v1',
      input: empty,
      output: empty,
      async run(ctx) {
        await ctx.step('s1', () => 1)
        await ctx.step('s2', () => 2)
        await ctx.step('s3', () => 3)
        await ctx.step('s4', () => 4)
        await ctx.step('s5', () => 5)
        return {}
      },
    })
    await seedRuns(
      sql.pool,
      db.schema,
      'cap.static',
      Array.from({ length: 5 }, () => ({ cost: 0, tokens: 0, wallMs: 10, steps: 1 })),
    )
    const { cap, spied, thrown } = capWithSpy({ ceilings: { 'cap.static': { steps: 3 } } })
    const caps = await cap.caps('cap.static')
    const below = { kind: 'static', sample: 5, reason: 'below_sample_minimum' } as const
    expect(caps.basis).toEqual({ tree: below, steps: below })
    expect(caps.values).toEqual({ ...DEFAULT_CEILING, steps: 3 })
    expect((await cap.caps('cap.unknown')).values).toEqual(DEFAULT_CEILING)

    const rt = await started(testRuntime({ schema: db.schema, workflows: [fiveSteps], middleware: [spied] }))
    const result = await rt.wait((await rt.start(fiveSteps, {}, { purpose: 'test' })).runId)
    expect(result.status).toBe('failed')
    expect(thrown[0]).toMatchObject({ metric: 'steps', observed: 4, cap: 3 })
    expect((await sql.step(result.runId, 's4'))?.status).toBe('failed')
  })

  test('a resumed run counts what it already spent', async () => {
    let block = true
    const resumable = defineWorkflow({
      id: 'cap.resume',
      version: 'v1',
      input: empty,
      output: empty,
      async run(ctx) {
        await ctx.step('a', (s) => {
          s.addUsage(costUsage(0.6))
          return 1
        })
        await ctx.step('b', async (s) => {
          if (block) await new Promise((resolve) => s.signal.addEventListener('abort', resolve))
          s.addUsage(costUsage(0.6))
          return 2
        })
        await ctx.step('c', () => 3)
        return {}
      },
    })
    const ceilings = { 'cap.resume': { cost: 1 } }
    const first = capWithSpy({ ceilings })
    const rt1 = testRuntime({ schema: db.schema, workflows: [resumable], middleware: [first.spied] })
    await rt1.open()
    const { runId } = await rt1.start(resumable, {}, { purpose: 'test' })
    await until(async () => (await sql.step(runId, 'b'))?.status === 'running', 'step b running')
    await rt1.close()
    // Downtime before the resume is not wall time of the run.
    await Bun.sleep(300)

    block = false
    const second = capWithSpy({ ceilings })
    const rt2 = await started(testRuntime({ schema: db.schema, workflows: [resumable], middleware: [second.spied] }))
    const result = await rt2.wait(runId)
    expect(result.status).toBe('failed')

    const seen = second.decisions.filter((d): d is CapDecision => d.rule === 'runaway-cap')
    expect(seen.map((d) => d.stepId)).toEqual(['b', 'c'])
    // The re-run of b already sees a's 0.6 and both journal rows.
    expect(seen[0]?.observed).toMatchObject({ cost: 0.6, steps: 2 })
    expect(seen[0]?.allowed).toBe(true)
    expect(seen[0]?.observed.wallMs).toBeLessThan(300)
    expect(second.thrown[0]).toMatchObject({ metric: 'cost', cap: 1 })
    expect((second.thrown[0] as RunawayCapExceeded).observed).toBeCloseTo(1.2, 6)
    expect((await sql.step(runId, 'c'))?.error).toContain('runaway cap: cost')
  })

  test('wall time is watched in toolPre: RunawayCapExceeded fails the agent step and aborts its session', async () => {
    const host = new FakeAgentHost(async (session) => {
      await session.sleep(400, 50)
      await session.tool('read', { path: 'x' }, { ok: true })
      return { output: { done: true } }
    })
    const agentic = defineWorkflow({
      id: 'cap.tool',
      version: 'v1',
      input: empty,
      output: empty,
      async run(ctx) {
        await ctx.agent('think', { agent: 'worker', prompt: 'go' })
        await ctx.step('after', () => 1)
        return {}
      },
    })
    const { spied, decisions, logger } = capWithSpy({ ceilings: { 'cap.tool': { wallMs: 300 } } })
    const rtLogger = captureLogger()
    const rt = await started(
      testRuntime({ schema: db.schema, workflows: [agentic], host, middleware: [spied], logger: rtLogger }),
    )
    const result = await rt.wait((await rt.start(agentic, {}, { purpose: 'test' })).runId)
    const fromTool = decisions.find((d): d is CapDecision => d.rule === 'runaway-cap' && d.hook === 'toolPre')
    expect(fromTool).toMatchObject({ allowed: false, exceeded: 'wallMs', stepId: 'think' })
    expect(logger.lines.filter((l) => l.message === 'runaway cap exceeded').length).toBeGreaterThanOrEqual(1)
    // A throwing toolPre fails the step it runs in (runtime ToolRefused): the agent step itself stops, with the
    // cap's kind, without a retry, and its session is aborted; the step after it never runs.
    expect(rtLogger.lines.some((l) => l.message === 'toolPre threw')).toBe(false)
    expect(result).toMatchObject({ status: 'failed', error: { kind: 'step_failed' } })
    const think = await sql.step(result.runId, 'think')
    expect(think).toMatchObject({ status: 'failed', error_kind: 'middleware', attempts: 1 })
    expect(String(think?.error)).toContain('runaway cap: wallMs')
    expect(host.count('abort')).toBe(1)
    expect(await sql.step(result.runId, 'after')).toBeUndefined()
  })

  test('a history read failure falls back to the static ceiling without failing the run', async () => {
    const logger = captureLogger()
    const cap = runawayCap({ connectionString: PG_URL, schema: 'agw_t_lim_missing_schema', logger })
    open.push(cap)
    const caps = await cap.caps('cap.anything')
    const unavailable = { kind: 'static', sample: 0, reason: 'history_unavailable' } as const
    expect(caps.basis).toEqual({ tree: unavailable, steps: unavailable })
    expect(caps.values).toEqual(DEFAULT_CEILING)
    expect(logger.lines[0]?.message).toContain('history read failed')
  })
})

describe('runaway cap, history, hot path and trees', () => {
  const runArgs = (runId: string, workflowId: string, resume: boolean) => ({
    runId,
    workflowId,
    version: 'v1',
    purpose: 'test',
    parentId: null,
    rootId: runId,
    input: {},
    traceparent: null,
    resume,
  })
  const stepArgs = (runId: string, stepId: string, workflowId: string) => ({
    runId,
    workflowId,
    version: 'v1',
    stepId,
    kind: 'code' as const,
    attempt: 1,
    startedAt: new Date(),
    status: 'running' as const,
    replay: false,
  })
  const quiet = (options: Partial<RunawayCapOptions> = {}) => {
    const decisions: CapDecision[] = []
    const logger = captureLogger()
    const cap = runawayCap({
      connectionString: PG_URL,
      schema: db.schema,
      logger,
      onDecision: (d) => void (d.rule === 'runaway-cap' && decisions.push(d)),
      ...options,
    })
    open.push(cap)
    return { cap, decisions, logger }
  }

  test('the p95 is taken over the latest window of done runs only', async () => {
    const old = { cost: 9, tokens: 9e6, wallMs: 9e6, steps: 9 }
    const recent = { cost: 0.1, tokens: 1000, wallMs: 1000, steps: 2 }
    await seedRuns(sql.pool, db.schema, 'cap.window', Array(30).fill(old), { ageDays: 10 })
    await seedRuns(sql.pool, db.schema, 'cap.window', Array(25).fill(recent), { ageDays: 1 })
    const { cap } = quiet({ window: 25 })
    const caps = await cap.caps('cap.window')
    expect(caps.basis.tree).toEqual({ kind: 'learned', sample: 25, factor: 10 })
    expect(caps.p95).toEqual({ cost: 0.1, tokens: 1000, wallMs: 1000, steps: 2 })
  })

  test('a slow or unreachable journal never stalls the step hooks', async () => {
    const { cap, decisions } = quiet({
      connectionString: 'postgres://nobody:nothing@10.255.255.1:5432/none',
      queryTimeoutMs: 300,
    })
    await cap.runPre?.(runArgs('slow-1', 'cap.slow', false))
    const started = performance.now()
    await cap.stepPre?.(stepArgs('slow-1', 'a', 'cap.slow'))
    await cap.toolPre?.({ runId: 'slow-1', stepId: 'a', callId: 'c1', tool: 'read' })
    expect(performance.now() - started).toBeLessThan(50)
    expect(decisions[0]?.basis.tree).toEqual({ kind: 'static', sample: 0, reason: 'history_pending' })
    expect(decisions[0]?.caps).toEqual(DEFAULT_CEILING)
    expect((await cap.caps('cap.slow')).basis.tree).toMatchObject({ reason: 'history_unavailable' })
  })

  test('stale caps are served at once while a refresh runs in the background', async () => {
    const base = { cost: 0.1, tokens: 1000, wallMs: 1000, steps: 2 }
    await seedRuns(sql.pool, db.schema, 'cap.swr', Array(20).fill(base), { ageDays: 2 })
    const { cap, decisions } = quiet({ ttlMs: 1 })
    expect((await cap.caps('cap.swr')).values.cost).toBeCloseTo(1, 6)
    await seedRuns(sql.pool, db.schema, 'cap.swr', Array(20).fill({ ...base, cost: 1 }), { ageDays: 1 })
    await Bun.sleep(5)
    const before = cap.queries
    await cap.runPre?.(runArgs('swr-1', 'cap.swr', false))
    await cap.stepPre?.(stepArgs('swr-1', 'a', 'cap.swr'))
    expect(decisions[0]?.caps.cost).toBeCloseTo(1, 6)
    expect(cap.queries).toBe(before + 1)
    expect((await cap.caps('cap.swr')).values.cost).toBeCloseTo(10, 6)
  })

  test('a failed load is never cached; concurrent loads of a run share one read', async () => {
    const broken = quiet({ schema: 'agw_t_lim_missing_schema' })
    await broken.cap.runPre?.(runArgs('gone-1', 'cap.load', true))
    const after = broken.cap.queries
    await broken.cap.stepPre?.(stepArgs('gone-1', 'a', 'cap.load'))
    expect(broken.cap.queries).toBe(after + 1)
    expect(broken.decisions).toEqual([])

    await seedRuns(sql.pool, db.schema, 'cap.load', [{ cost: 0.3, tokens: 10, wallMs: 100, steps: 2 }])
    const { rows } = await sql.pool.query<{ id: string }>(
      `select id from "${db.schema}".runs where workflow = 'cap.load'`,
    )
    const runId = rows[0]?.id ?? ''
    const { cap, decisions } = quiet()
    await cap.caps('cap.load')
    const before = cap.queries
    await Promise.all([cap.runPre?.(runArgs(runId, 'cap.load', true)), cap.runPre?.(runArgs(runId, 'cap.load', true))])
    expect(cap.queries).toBe(before + 1)
    await cap.stepPre?.(stepArgs(runId, 'x', 'cap.load'))
    expect(decisions[0]?.observed).toMatchObject({ cost: 0.3, steps: 3 })
  })

  test('fan-out: cost, tokens and wall time are capped per root tree, steps per run', async () => {
    const child = defineWorkflow({
      id: 'cap.child',
      version: 'v1',
      input: z.object({ i: z.number() }),
      output: empty,
      async run(ctx) {
        await ctx.step('spend', (s) => {
          s.addUsage(costUsage(0.3, 100))
          return 1
        })
        await ctx.step('tail', () => 2)
        return {}
      },
    })
    const parent = defineWorkflow({
      id: 'cap.parent',
      version: 'v1',
      input: empty,
      output: empty,
      async run(ctx) {
        await ctx.workflow('fan', child, [{ i: 0 }, { i: 1 }, { i: 2 }])
        await ctx.step('spend', (s) => {
          s.addUsage(costUsage(0.3, 100))
          return 1
        })
        await ctx.step('after', () => 2)
        return {}
      },
    })
    const { spied, decisions, thrown } = capWithSpy({ ceilings: { 'cap.parent': { cost: 1, steps: 3 } } })
    const rt = await started(testRuntime({ schema: db.schema, workflows: [parent, child], middleware: [spied] }))
    const result = await rt.wait((await rt.start(parent, {}, { purpose: 'test' })).runId)
    expect(result.status).toBe('failed')
    expect((await sql.step(result.runId, 'after'))?.error).toContain('runaway cap: cost')
    expect(thrown).toHaveLength(1)
    expect(thrown[0]).toMatchObject({ metric: 'cost', cap: 1 })
    expect((thrown[0] as RunawayCapExceeded).observed).toBeCloseTo(1.2, 6)

    const seen = decisions.filter((d): d is CapDecision => d.rule === 'runaway-cap')
    const childDecisions = seen.filter((d) => d.workflowId === 'cap.child')
    expect(childDecisions).toHaveLength(6)
    expect(childDecisions.every((d) => d.rootId === result.runId && d.observed.steps <= 2)).toBe(true)
    // Children are capped by the root's tree caps; their own step counts by their own workflow.
    expect(childDecisions.every((d) => d.caps.cost === 1 && d.caps.steps === DEFAULT_CEILING.steps)).toBe(true)
    const after = seen.find((d) => d.stepId === 'after')
    expect(after?.observed.steps).toBe(3)
    expect(after?.observed.tokens).toBe(400)
  })

  test('unpriced usage is surfaced in the decision', async () => {
    const unpriced = defineWorkflow({
      id: 'cap.unpriced',
      version: 'v1',
      input: empty,
      output: empty,
      async run(ctx) {
        await ctx.step('a', (s) => {
          s.addUsage({ tokens: { input: 500, output: 0, cacheRead: 0, reasoning: 0 } })
          return 1
        })
        await ctx.step('b', () => 2)
        return {}
      },
    })
    const { spied, decisions } = capWithSpy()
    const rt = await started(testRuntime({ schema: db.schema, workflows: [unpriced], middleware: [spied] }))
    expect((await rt.wait((await rt.start(unpriced, {}, { purpose: 'test' })).runId)).status).toBe('done')
    const b = decisions.find((d): d is CapDecision => d.rule === 'runaway-cap' && d.stepId === 'b')
    expect(b).toMatchObject({ unpricedCalls: 1, observed: { cost: 0, tokens: 500 } })
  })

  test('a throwing onDecision sink never fails a run', async () => {
    const wf = threeSteps('cap.sink')
    const logger = captureLogger()
    const cap = runawayCap({
      connectionString: PG_URL,
      schema: db.schema,
      logger,
      onDecision: () => {
        throw new Error('sink down')
      },
    })
    open.push(cap)
    const rt = await started(testRuntime({ schema: db.schema, workflows: [wf], middleware: [cap] }))
    expect((await rt.wait((await rt.start(wf, { cost: 0.01 }, { purpose: 'test' })).runId)).status).toBe('done')
    expect(logger.lines.filter((l) => l.message === 'onDecision threw; ignored')).toHaveLength(3)
  })
})

describe('runaway cap, runPost interleaving', () => {
  test('after runPost a step or tool hook neither throws nor re-flags the ended run', async () => {
    const decisions: LimitDecision[] = []
    const cap = runawayCap({
      connectionString: PG_URL,
      schema: db.schema,
      logger: captureLogger(),
      ceilings: { 'cap.ended': { wallMs: 0, steps: 0 } },
      onDecision: (d) => decisions.push(d),
    })
    open.push(cap)
    const info = {
      runId: 'ended-1',
      workflowId: 'cap.ended',
      version: 'v1',
      purpose: 'test',
      parentId: null,
      rootId: 'ended-1',
      input: {},
      traceparent: null,
    }
    await cap.runPre?.({ ...info, resume: false })
    await Bun.sleep(5)
    const tool = { runId: 'ended-1', stepId: 'a', callId: 'c1', tool: 'read' }
    // Over the cap while live: the first toolPre throws and flags the run.
    expect(() => cap.toolPre?.(tool)).toThrow(RunawayCapExceeded)
    await cap.runPost?.({
      ...info,
      status: 'failed',
      output: null,
      error: null,
      startedAt: null,
      finishedAt: new Date(),
    })
    const count = decisions.length
    expect(cap.toolPre?.(tool)).toBeUndefined()
    const step = {
      runId: 'ended-1',
      workflowId: 'cap.ended',
      version: 'v1',
      stepId: 'b',
      kind: 'code' as const,
      attempt: 1,
      startedAt: new Date(),
      status: 'running' as const,
      replay: false,
    }
    // Unknown after runPost: passes (a background load finds the run row gone and caches nothing).
    expect(cap.stepPre?.(step)).toBeUndefined()
    await Bun.sleep(50)
    expect(cap.toolPre?.(tool)).toBeUndefined()
    expect(decisions).toHaveLength(count)
  })
})

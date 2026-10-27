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
    await seedRuns(sql.pool, db.schema, 'cap.learned', [huge, huge], 'failed')
    await seedRuns(
      sql.pool,
      db.schema,
      'cap.other',
      Array.from({ length: 25 }, () => huge),
    )

    const { cap } = capWithSpy()
    const caps = await cap.caps('cap.learned')
    expect(caps.basis).toMatchObject({ kind: 'learned', sample: 30, factor: 10 })
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
    expect(caps.basis).toEqual({ kind: 'static', sample: 5, reason: 'below_sample_minimum' })
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

  test('wall time is watched in toolPre inside a long agent step', async () => {
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
    // The runtime logs a toolPre throw and lets the step go on; the next step stops the run.
    expect(rtLogger.lines.some((l) => l.message === 'toolPre threw')).toBe(true)
    expect(result.status).toBe('failed')
    expect((await sql.step(result.runId, 'after'))?.error).toContain('runaway cap: wallMs')
  })

  test('a history read failure falls back to the static ceiling without failing the run', async () => {
    const logger = captureLogger()
    const cap = runawayCap({ connectionString: PG_URL, schema: 'agw_t_lim_missing_schema', logger })
    open.push(cap)
    const caps = await cap.caps('cap.anything')
    expect(caps.basis).toEqual({ kind: 'static', sample: 0, reason: 'history_unavailable' })
    expect(caps.values).toEqual(DEFAULT_CEILING)
    expect(logger.lines[0]?.message).toContain('history read failed')
  })
})

describe('runaway cap, resume loads', () => {
  const stepArgs = (runId: string, stepId: string) => ({
    runId,
    workflowId: 'cap.load',
    version: 'v1',
    stepId,
    kind: 'code' as const,
    attempt: 1,
    startedAt: new Date(),
    status: 'running' as const,
    replay: false,
  })

  test('a failed load is never cached: the step passes and the next one reads again', async () => {
    const logger = captureLogger()
    const cap = runawayCap({ connectionString: PG_URL, schema: 'agw_t_lim_missing_schema', logger })
    open.push(cap)
    await cap.stepPre?.(stepArgs('r-missing', 'a'))
    const after = cap.queries
    await cap.stepPre?.(stepArgs('r-missing', 'b'))
    expect(cap.queries).toBe(after + 1)
    expect(logger.lines.filter((l) => l.message.includes('could not load')).length).toBe(2)
  })

  test('concurrent steps of an unknown run share one load and one state', async () => {
    await seedRuns(sql.pool, db.schema, 'cap.load', [{ cost: 0.3, tokens: 10, wallMs: 100, steps: 2 }])
    const { rows } = await sql.pool.query<{ id: string }>(
      `select id from "${db.schema}".runs where workflow = 'cap.load'`,
    )
    const runId = rows[0]?.id ?? ''
    const { cap, decisions } = capWithSpy()
    await cap.caps('cap.load')
    const before = cap.queries
    await Promise.all([cap.stepPre?.(stepArgs(runId, 'x')), cap.stepPre?.(stepArgs(runId, 'y'))])
    expect(cap.queries).toBe(before + 1)
    const seen = decisions.filter((d): d is CapDecision => d.rule === 'runaway-cap')
    // One shared state: both steps counted on top of the two journal rows (separate states would see 3 each).
    expect(seen.map((d) => d.observed.steps)).toEqual([4, 4])
    expect(seen[0]?.observed.cost).toBeCloseTo(0.3, 6)
  })
})

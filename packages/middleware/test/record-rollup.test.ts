// The run record's cost roll-up: a run's `cost` sums the steps of the run and every descendant run (by `parent_id`), so
// the root of a tree carries the tree's total, whether the children are fan-out children or parented starts (eval case
// runs), and whenever a child's own record lands.
import { afterAll, describe, expect, test } from 'bun:test'
import { defineWorkflow, type Runtime } from '@agent-workflows/runtime'
import { z } from 'zod'
import { admissionSpanId, JournalDb, recordMiddleware, traceIdForRun } from '../src/index.ts'
import { testPlatform } from '@agent-workflows/testing/platform'
import { attr, captureLogger, freshSchema, inspector, PG_URL, parentOf, testRuntime, until } from './support.ts'

const db = freshSchema('mwroll')
const sql = inspector(db.schema)

afterAll(async () => {
  await sql.close()
  await db.drop()
})

const n = z.object({ n: z.number() })
const empty = z.object({})
const priced = (cost: number) => ({ model: 'm1', tokens: { input: 1, output: 1, cacheRead: 0, reasoning: 0 }, cost })
const unpricedUsage = { model: 'm1', tokens: { input: 1, output: 1, cacheRead: 0, reasoning: 0 }, cost: null }

/** A leaf spending 0.001. */
const grandchild = defineWorkflow({
  id: 'roll.grandchild',
  version: 'v1',
  input: n,
  output: n,
  async run(ctx, input) {
    await ctx.step('spend', ({ addUsage }) => {
      addUsage(priced(0.001))
      return 1
    })
    return input
  },
})

/** 0.01 of its own and two grandchildren: 0.012 in all. */
const fanOut = defineWorkflow({
  id: 'roll.fan',
  version: 'v1',
  input: n,
  output: n,
  async run(ctx, input) {
    await ctx.step('spend', ({ addUsage }) => {
      addUsage(priced(0.01))
      return 1
    })
    await ctx.workflow('kids', grandchild, [{ n: 1 }, { n: 2 }])
    return input
  },
})

let rt: Runtime

async function recorded(runId: string) {
  return until(async () => {
    const row = await sql.run(runId)
    return row?.post_hooks_at ? row : null
  }, `runPost of ${runId}`)
}

/**
 * 0.1 of its own, one fan-out child (0.012 with its two grandchildren) and one parented start of the fan-out workflow
 * (another 0.012), waited for until its record is written, as `eval.run` waits for a case: 0.124 in all.
 */
const top = defineWorkflow({
  id: 'roll.top',
  version: 'v1',
  input: empty,
  output: z.object({ caseRun: z.string() }),
  async run(ctx) {
    await ctx.step('spend', ({ addUsage }) => {
      addUsage(priced(0.1))
      return 1
    })
    await ctx.workflow('fan', fanOut, [{ n: 0 }])
    const caseRun = await ctx.step('case', async () => {
      const { runId } = await rt.start(
        fanOut,
        { n: 9 },
        { purpose: 'eval', parentId: ctx.runId, idempotencyKey: ctx.runId },
      )
      await until(async () => (await rt.getRun(runId))?.postHooksDone, 'the case record', 10_000)
      return runId
    })
    return { caseRun }
  },
})

/** Nothing priced of its own; children as `input.priced` says: unpriced only, or one of each. */
const mixed = defineWorkflow({
  id: 'roll.mixed',
  version: 'v1',
  input: z.object({ priced: z.boolean() }),
  output: empty,
  async run(ctx, input) {
    await ctx.step('free', () => 1)
    await ctx.workflow('kids', leaf, input.priced ? [{ priced: false }, { priced: true }] : [{ priced: false }])
    return {}
  },
})

/** Only free steps (no usage reported): known free. */
const free = defineWorkflow({
  id: 'roll.free',
  version: 'v1',
  input: empty,
  output: empty,
  async run(ctx) {
    await ctx.step('a', () => 1)
    await ctx.step('b', () => 2)
    return {}
  },
})

/** A priced-zero call beside an unpriced one: the step costs 0 but is not known free. */
const zeroAndUnpriced = defineWorkflow({
  id: 'roll.zero-unpriced',
  version: 'v1',
  input: empty,
  output: empty,
  async run(ctx) {
    await ctx.step('spend', ({ addUsage }) => {
      addUsage(priced(0))
      addUsage(unpricedUsage)
      return 1
    })
    return {}
  },
})

/** A free done step beside a failed step that reported nothing (a billed call may have been lost): unknown. */
const freeAndFailed = defineWorkflow({
  id: 'roll.free-failed',
  version: 'v1',
  input: empty,
  output: empty,
  async run(ctx) {
    await ctx.step('free', () => 1)
    await ctx
      .step('lost', () => {
        throw new Error('no usage came back')
      })
      .catch(() => null)
    return {}
  },
})

/** No step at all: nothing ran, nothing spent. */
const noSteps = defineWorkflow({
  id: 'roll.no-steps',
  version: 'v1',
  input: empty,
  output: empty,
  async run() {
    return {}
  },
})

const leaf = defineWorkflow({
  id: 'roll.leaf',
  version: 'v1',
  input: z.object({ priced: z.boolean() }),
  output: empty,
  async run(ctx, input) {
    await ctx.step('spend', ({ addUsage }) => {
      addUsage(input.priced ? priced(0.5) : unpricedUsage)
      return 1
    })
    return {}
  },
})

describe('run record cost roll-up', () => {
  test('a root carries its tree: fan-out children, grandchildren and a parented start, each counted once', async () => {
    const platform = testPlatform(db.schema)
    rt = testRuntime({
      schema: db.schema,
      workflows: [top, fanOut, grandchild, mixed, leaf],
      middleware: platform.middleware,
    })
    await rt.open()
    try {
      const { runId } = await rt.start(top, {}, { purpose: 'prod' })
      const end = await rt.wait(runId)
      expect(end.status).toBe('done')
      const caseRun = (end.output as { caseRun: string }).caseRun

      const root = await recorded(runId)
      const fan = await recorded(`${runId}/fan/0`)
      const leafRow = await recorded(`${runId}/fan/0/kids/0`)
      const caseRow = await recorded(caseRun)
      const caseLeaf = await recorded(`${caseRun}/kids/1`)
      expect(Number(leafRow.cost)).toBeCloseTo(0.001, 12)
      expect(Number(caseLeaf.cost)).toBeCloseTo(0.001, 12)
      expect(Number(fan.cost)).toBeCloseTo(0.012, 12)
      expect(Number(caseRow.cost)).toBeCloseTo(0.012, 12)
      expect(caseRow).toMatchObject({ parent_id: runId, root_id: caseRun })
      expect(Number(root.cost)).toBeCloseTo(0.124, 12)
      // Tokens stay the run's own: one step of the root's.
      expect(root.tokens_input).toBe('1')
      // The steps of every run below the root sum to the same total: the record never adds a spend twice.
      const { rows } = await sql.pool.query<{ cost: string }>(
        `select sum(s.cost) as cost from "${db.schema}".steps s join "${db.schema}".runs r on r.id = s.run_id
          where r.root_id in ($1, $2)`,
        [runId, caseRun],
      )
      expect(Number(rows[0]?.cost)).toBeCloseTo(Number(root.cost), 12)
      expect((await rt.getRun(runId))?.cost).toBeCloseTo(0.124, 12)

      // The parented start's span hangs under the root's admission span, in the root's trace.
      await platform.telemetry.flush()
      const spans = platform.spans.getFinishedSpans()
      const caseSpan = spans.find((s) => s.name === 'agw.run roll.fan' && attr(s, 'agw.run.id') === caseRun)
      const traceId = traceIdForRun({ rootId: runId, traceparent: null })
      expect(caseSpan?.spanContext().traceId).toBe(traceId)
      expect(caseSpan && parentOf(caseSpan)).toBe(admissionSpanId(runId))
      expect(caseRow.trace_id).toBe(traceId)
    } finally {
      await rt.close()
      await platform.close()
    }
  })

  test('0 when every step is free or none ran; the known costs sum; null when nothing is positive and any cost or call is unknown', async () => {
    const platform = testPlatform(db.schema)
    rt = testRuntime({
      schema: db.schema,
      workflows: [mixed, leaf, free, zeroAndUnpriced, freeAndFailed, noSteps],
      middleware: platform.middleware,
    })
    await rt.open()
    try {
      const allFree = await rt.start(free, {}, { purpose: 'prod' })
      const none = await rt.start(mixed, { priced: false }, { purpose: 'prod' })
      const some = await rt.start(mixed, { priced: true }, { purpose: 'prod' })
      const zeroUnpriced = await rt.start(zeroAndUnpriced, {}, { purpose: 'prod' })
      const noStep = await rt.start(noSteps, {}, { purpose: 'prod' })
      const failedFree = await rt.start(freeAndFailed, {}, { purpose: 'prod' })
      await Promise.all(
        [allFree, none, some, zeroUnpriced, noStep, failedFree].map((started) => rt.wait(started.runId)),
      )
      const freeRow = await recorded(allFree.runId)
      expect(Number(freeRow.cost)).toBe(0)
      expect(freeRow.cost).not.toBeNull()
      expect(freeRow.unpriced_calls).toBe(0)
      expect(await recorded(none.runId)).toMatchObject({ cost: null, unpriced_calls: 1 })
      const someRow = await recorded(some.runId)
      expect(Number(someRow.cost)).toBeCloseTo(0.5, 12)
      expect(someRow.unpriced_calls).toBe(1)
      // cost 0 on the step, yet an unpriced call: unknown, not free
      expect(await sql.step(zeroUnpriced.runId, 'spend')).toMatchObject({ cost: '0', unpriced_calls: 1 })
      expect(await recorded(zeroUnpriced.runId)).toMatchObject({ cost: null, unpriced_calls: 1 })
      // a free done step plus a failed step that reported nothing: the failed one may have spent, so unknown
      expect(await recorded(failedFree.runId)).toMatchObject({ cost: null, unpriced_calls: 0 })
      // a run with no step rows spent nothing: 0, not null
      const emptyRow = await recorded(noStep.runId)
      expect(emptyRow.cost).not.toBeNull()
      expect(Number(emptyRow.cost)).toBe(0)
      expect(emptyRow.unpriced_calls).toBe(0)
    } finally {
      await rt.close()
      await platform.close()
    }
  })

  test("a child whose runPost lands after its parent's still counts in the parent's cost", async () => {
    const logger = captureLogger()
    const recordDb = new JournalDb({ connectionString: PG_URL, schema: db.schema }, logger)
    const record = recordMiddleware({ db: recordDb, logger })
    let holdChild = true
    // The record, except for the fan-out child while held: its runPost throws and is redelivered later.
    const lateChild: typeof record = {
      ...record,
      name: 'record-late-child',
      async runPost(args) {
        if (holdChild && args.workflowId === grandchild.id) throw new Error('child record held back')
        await record.runPost?.(args)
      },
    }
    rt = testRuntime({
      schema: db.schema,
      workflows: [fanOut, grandchild],
      middleware: [lateChild],
      maxPostHookAttempts: 1000,
    })
    await rt.open()
    try {
      const { runId } = await rt.start(fanOut, { n: 0 }, { purpose: 'prod' })
      expect((await rt.wait(runId)).status).toBe('done')
      const parent = await recorded(runId)
      const kid = await sql.run(`${runId}/kids/0`)
      // The parent's record was written while its children's were not.
      expect(kid).toMatchObject({ post_hooks_at: null, cost: null })
      expect(Number(parent.cost)).toBeCloseTo(0.012, 12)
      holdChild = false
      const late = await until(async () => {
        const row = await sql.run(`${runId}/kids/0`)
        return row?.post_hooks_at ? row : null
      }, 'the redelivered child record')
      expect(Number(late.cost)).toBeCloseTo(0.001, 12)
      expect(Number((await sql.run(runId))?.cost)).toBeCloseTo(0.012, 12)
    } finally {
      await rt.close()
      await recordDb.close()
    }
  })
})

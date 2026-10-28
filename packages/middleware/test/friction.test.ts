import { afterAll, describe, expect, test } from 'bun:test'
import { AdmissionRefused, defineWorkflow, WorkflowError } from '@agent-workflows/runtime'
import { FakeAgentHost } from '@agent-workflows/runtime/testing'
import { z } from 'zod'
import {
  type FrictionSource,
  frictionMiddleware,
  frictionRecounter,
  JournalDb,
  MAX_RECOUNT_ATTEMPTS,
  PROBE_CONCURRENCY,
  type SessionCounters,
  type StepSessions,
  totalsOf,
} from '../src/index.ts'
import { captureLogger, freshSchema, inspector, PG_URL, testPlatform, testRuntime, until } from './support.ts'

const db = freshSchema('mwf')
const sql = inspector(db.schema)

afterAll(async () => {
  await sql.close()
  await db.drop()
})

const counters = (c: Partial<SessionCounters> = {}): SessionCounters => ({
  toolErrors: 0,
  repeatToolCalls: 0,
  nudges: 0,
  nudgesMissed: 0,
  ...c,
})

/** What each step's sessions "contain"; the source answers like the OpenCode host does, from the step id. */
const sessions = new Map<string, StepSessions>()
const source: FrictionSource = {
  async stepSessions({ stepId }) {
    return sessions.get(stepId) ?? { sessions: [], incomplete: false }
  },
}
const answer = (list: Record<string, Partial<SessionCounters>>, incomplete = false): StepSessions => ({
  sessions: Object.entries(list).map(([session, c]) => ({ session, ...counters(c) })),
  incomplete,
})

const none = z.object({})
const ok = z.object({ ok: z.literal(true) })

const twoAgents = defineWorkflow({
  id: 'f.two',
  version: 'v1',
  input: none,
  output: none,
  async run(ctx) {
    await ctx.agent('one', { agent: 'a', prompt: 'one' })
    await ctx.agent('two', { agent: 'a', prompt: 'two' })
    return {}
  },
})

const manyAgents = defineWorkflow({
  id: 'f.many',
  version: 'v1',
  input: none,
  output: none,
  async run(ctx) {
    for (let i = 0; i < 12; i++) await ctx.agent(`s${i}`, { agent: 'a', prompt: 'x' })
    return {}
  },
})

const plain = defineWorkflow({
  id: 'f.plain',
  version: 'v1',
  input: none,
  output: none,
  async run(ctx) {
    await ctx.step('a', () => 1)
    return {}
  },
})

const badSchema = defineWorkflow({
  id: 'f.schema',
  version: 'v1',
  input: none,
  output: none,
  async run(ctx) {
    await ctx.agent('answer', { agent: 'a', prompt: 'x', output: ok })
    return {}
  },
})

const reasked = defineWorkflow({
  id: 'f.reask',
  version: 'v1',
  input: none,
  output: none,
  async run(ctx) {
    await ctx.agent('answer:reask', { agent: 'a', prompt: 'x' })
    await ctx.agent('answer:reask:2', { agent: 'a', prompt: 'x' })
    return {}
  },
})

const retried = defineWorkflow({
  id: 'f.retried',
  version: 'v1',
  input: none,
  output: none,
  async run(ctx) {
    await ctx.agent('answer', {
      agent: 'a',
      prompt: 'x',
      output: ok,
      retry: { attempts: 3, backoffMs: 1, maxBackoffMs: 1 },
    })
    return {}
  },
})

const capped = defineWorkflow({
  id: 'f.capped',
  version: 'v1',
  input: none,
  output: none,
  async run(ctx) {
    await ctx.step('work', () => {
      throw new WorkflowError('middleware', 'runaway cap: cost $2.00 > cap $1.00 (learned)')
    })
    return {}
  },
})

const postArgs = (runId: string, workflowId: string) => ({
  runId,
  workflowId,
  version: 'v1',
  purpose: 'prod',
  parentId: null,
  rootId: runId,
  input: {},
  traceparent: null,
  status: 'done' as const,
  output: {},
  error: null,
  startedAt: new Date(),
  finishedAt: new Date(),
})

const refuseAll = {
  name: 'refuse',
  runPre: () => {
    throw new AdmissionRefused('wallet gate: IU rolling 30d $500 >= $400 wallet gate')
  },
}

async function runOf(runId: string) {
  return until(async () => {
    const row = await sql.run(runId)
    return row?.post_hooks_at ? row : null
  }, `runPost of ${runId}`)
}

/** A second middleware instance on the same schema, to deliver `runPost` by hand. */
const manual = (src: FrictionSource | undefined = source) =>
  frictionMiddleware({
    db: new JournalDb({ connectionString: PG_URL, schema: db.schema }, captureLogger()),
    logger: captureLogger(),
    source: src,
  })

function setup(host = new FakeAgentHost(), src: FrictionSource | undefined = source, tail: object[] = []) {
  const platform = testPlatform(db.schema, { friction: src })
  const rt = testRuntime({
    schema: db.schema,
    workflows: [twoAgents, plain, badSchema, reasked, capped, retried, manyAgents],
    host,
    middleware: [...platform.middleware, ...(tail as never[])],
  })
  return { rt, platform }
}

const finish = async (x: ReturnType<typeof setup>) => {
  await x.rt.close()
  await x.platform.close()
}

describe('friction counters', () => {
  test('every run gets a v1 document, zeros included', async () => {
    const x = setup()
    await x.rt.open()
    const { runId } = await x.rt.start(plain, {}, { purpose: 'prod' })
    await x.rt.wait(runId)
    expect((await runOf(runId)).friction).toMatchObject({
      v: 1,
      toolErrors: 0,
      repeatToolCalls: 0,
      nudges: 0,
      nudgesMissed: 0,
      schemaReasks: 0,
      overBudget: 0,
      followUps: 0,
    })
    await finish(x)
  })

  test('session counters are summed per run, repeat is the highest of any session', async () => {
    sessions.clear()
    sessions.set('one', answer({ ses_1: { toolErrors: 2, repeatToolCalls: 5, nudges: 1, nudgesMissed: 1 } }))
    sessions.set('two', answer({ ses_2: { toolErrors: 1, repeatToolCalls: 3, nudges: 1 } }))
    const x = setup(new FakeAgentHost(async () => ({ output: {} })))
    await x.rt.open()
    const { runId } = await x.rt.start(twoAgents, {}, { purpose: 'prod' })
    expect((await x.rt.wait(runId)).status).toBe('done')
    const friction = (await runOf(runId)).friction as Record<string, unknown>
    expect(friction).toMatchObject({
      v: 1,
      toolErrors: 3,
      repeatToolCalls: 5,
      nudges: 2,
      nudgesMissed: 1,
      followUps: 0,
    })
    expect(friction.incomplete).toBeUndefined()
    expect(friction.sessions).toEqual({
      one: { ses_1: counters({ toolErrors: 2, repeatToolCalls: 5, nudges: 1, nudgesMissed: 1 }) },
      two: { ses_2: counters({ toolErrors: 1, repeatToolCalls: 3, nudges: 1 }) },
    })
    await finish(x)
  })

  test('every session of a step counts, and a lost document is rebuilt by runPost alone', async () => {
    sessions.clear()
    sessions.set(
      'one',
      answer({
        ses_a1: { toolErrors: 1, repeatToolCalls: 2 }, // the first attempt
        ses_a2: { toolErrors: 2, repeatToolCalls: 6, nudges: 2 }, // its retry
        ses_a2_fb: { repeatToolCalls: 1 }, // the retry's fallback
      }),
    )
    const x = setup(new FakeAgentHost(async () => ({ output: {} })))
    await x.rt.open()
    const { runId } = await x.rt.start(twoAgents, {}, { purpose: 'prod' })
    await x.rt.wait(runId)
    const done = (await runOf(runId)).friction
    expect(done).toMatchObject({ toolErrors: 3, repeatToolCalls: 6, nudges: 2 })

    await sql.pool.query(`update "${db.schema}".runs set friction = null where id = $1`, [runId])
    await manual().runPost?.(postArgs(runId, 'f.two'))
    expect((await runOf(runId)).friction).toEqual(done)
    await finish(x)
  })

  test('runPost is a true recompute: stale events and vanished steps are gone, a re-delivery changes nothing', async () => {
    sessions.clear()
    sessions.set('one', answer({ ses_1: { toolErrors: 2 } }))
    const x = setup(new FakeAgentHost(async () => ({ output: {} })))
    await x.rt.open()
    const { runId } = await x.rt.start(twoAgents, {}, { purpose: 'prod' })
    await x.rt.wait(runId)
    const before = (await runOf(runId)).friction

    // A document with leftovers: an event an earlier delivery wrote for an attempt that is no longer the last, an
    // event of a step the run does not have, and the counters of a step that no longer exists.
    const stale = {
      ...(before as object),
      events: { 'answer#2': 'invalid_output', 'ghost#1': 'budget' },
      sessions: { ghost: { ses_x: counters({ toolErrors: 9 }) }, one: { ses_old: counters({ toolErrors: 7 }) } },
    }
    await sql.pool.query(`update "${db.schema}".runs set friction = $2::jsonb where id = $1`, [
      runId,
      JSON.stringify(stale),
    ])
    const again = manual()
    await again.runPost?.(postArgs(runId, 'f.two'))
    await again.runPost?.(postArgs(runId, 'f.two'))
    expect((await runOf(runId)).friction).toEqual(before)
    await finish(x)
  })

  test('a step that fails invalid_output counts one schema miss', async () => {
    const x = setup(new FakeAgentHost(async () => ({ output: { ok: false } })))
    await x.rt.open()
    const { runId } = await x.rt.start(badSchema, {}, { purpose: 'prod' })
    expect((await x.rt.wait(runId)).status).toBe('failed')
    expect((await runOf(runId)).friction).toMatchObject({ schemaReasks: 1, overBudget: 0 })
    await finish(x)
  })

  test('only the last attempt of a retried step is in the journal: one event, keyed by the final attempt', async () => {
    const x = setup(new FakeAgentHost(async () => ({ output: { ok: false } })))
    await x.rt.open()
    const { runId } = await x.rt.start(retried, {}, { purpose: 'prod' })
    expect((await x.rt.wait(runId)).status).toBe('failed')
    expect((await sql.step(runId, 'answer'))?.attempts).toBe(3)
    const friction = (await runOf(runId)).friction as { schemaReasks: number; events: Record<string, string> }
    expect(friction.events).toEqual({ 'answer#3': 'invalid_output' })
    expect(friction.schemaReasks).toBe(1)
    await finish(x)
  })

  test('a <id>:reask step adds nothing: the incident is the schema miss, counted once', async () => {
    const x = setup(new FakeAgentHost(async () => ({ output: {} })))
    await x.rt.open()
    const { runId } = await x.rt.start(reasked, {}, { purpose: 'prod' })
    expect((await x.rt.wait(runId)).status).toBe('done')
    expect((await runOf(runId)).friction).toMatchObject({ schemaReasks: 0 })
    await finish(x)
  })

  test('a wallet-gate refusal and a runaway-cap step failure are over budget; other refusals are not', async () => {
    const wallet = setup(new FakeAgentHost(), source, [refuseAll])
    await wallet.rt.open()
    const refused = await wallet.rt.start(plain, {}, { purpose: 'prod' })
    expect((await wallet.rt.wait(refused.runId)).error?.kind).toBe('admission_refused')
    expect((await runOf(refused.runId)).friction).toMatchObject({ overBudget: 1 })
    await finish(wallet)

    const cap = setup()
    await cap.rt.open()
    const run = await cap.rt.start(capped, {}, { purpose: 'prod' })
    expect((await cap.rt.wait(run.runId)).status).toBe('failed')
    expect((await runOf(run.runId)).friction).toMatchObject({ overBudget: 1 })
    await finish(cap)
  })
})

describe('a host that cannot answer completely', () => {
  const down: FrictionSource = {
    stepSessions: async () => {
      throw new Error('opencode is down')
    },
  }

  test('never fails the hooks: the document is flagged incomplete and keeps what an earlier answer wrote', async () => {
    sessions.clear()
    sessions.set('one', answer({ ses_1: { toolErrors: 4 } }))
    const x = setup(new FakeAgentHost(async () => ({ output: {} })))
    await x.rt.open()
    const { runId } = await x.rt.start(twoAgents, {}, { purpose: 'prod' })
    await x.rt.wait(runId)
    expect((await runOf(runId)).friction).toMatchObject({ toolErrors: 4 })

    await manual(down).runPost?.(postArgs(runId, 'f.two')) // does not throw
    expect((await sql.run(runId))?.friction).toMatchObject({ incomplete: true, toolErrors: 4 })
    await finish(x)
  })

  test('a first delivery against a down host: one delivery, no redelivery, the span says incomplete', async () => {
    const x = setup(new FakeAgentHost(async () => ({ output: {} })), down)
    await x.rt.open()
    const { runId } = await x.rt.start(twoAgents, {}, { purpose: 'prod' })
    await x.rt.wait(runId)
    const row = await runOf(runId)
    expect(row.friction).toMatchObject({ incomplete: true, toolErrors: 0 })
    expect(x.platform.logger.lines.some((l) => l.message.includes('runPost threw'))).toBe(false)
    await x.platform.telemetry.flush()
    const span = x.platform.spans
      .getFinishedSpans()
      .find((sp) => sp.attributes['agw.run.id'] === runId && sp.name.startsWith('agw.run'))
    expect(span?.attributes['agw.friction.incomplete']).toBe(true)
    await finish(x)
  })

  test('a partial answer is merged over the kept entries: the fuller entry of a session wins, new sessions are added', async () => {
    sessions.clear()
    sessions.set('one', answer({ ses_1: { toolErrors: 4, nudges: 2 } }))
    const x = setup(new FakeAgentHost(async () => ({ output: {} })))
    await x.rt.open()
    const { runId } = await x.rt.start(twoAgents, {}, { purpose: 'prod' })
    await x.rt.wait(runId)

    const partial: FrictionSource = {
      stepSessions: async ({ stepId }) =>
        stepId === 'one'
          ? answer({ ses_1: { toolErrors: 1 }, ses_2: { toolErrors: 2 } }, true) // an earlier, shorter read of ses_1
          : answer({}),
    }
    await manual(partial).runPost?.(postArgs(runId, 'f.two'))
    const f = (await sql.run(runId))?.friction as {
      incomplete?: boolean
      sessions: Record<string, Record<string, SessionCounters>>
    }
    expect(f.incomplete).toBe(true)
    expect(f.sessions.one).toEqual({
      ses_1: counters({ toolErrors: 4, nudges: 2 }), // not replaced by the smaller read
      ses_2: counters({ toolErrors: 2 }),
    })
    await finish(x)
  })

  test('nudgesMissed comes from the newest answer: a late note that landed makes an earlier miss disappear', async () => {
    sessions.clear()
    sessions.set('one', answer({ ses_1: { toolErrors: 2, nudgesMissed: 2 } }))
    const x = setup(new FakeAgentHost(async () => ({ output: {} })))
    await x.rt.open()
    const { runId } = await x.rt.start(twoAgents, {}, { purpose: 'prod' })
    await x.rt.wait(runId)
    expect((await runOf(runId)).friction).toMatchObject({ nudgesMissed: 2 })
    const partial: FrictionSource = {
      stepSessions: async ({ stepId }) =>
        stepId === 'one' ? answer({ ses_1: { toolErrors: 1, nudgesMissed: 0 } }, true) : answer({}),
    }
    await manual(partial).runPost?.(postArgs(runId, 'f.two'))
    const f = (await sql.run(runId))?.friction as {
      toolErrors: number
      nudgesMissed: number
      sessions: { one: { ses_1: SessionCounters } }
    }
    expect(f.sessions.one.ses_1).toMatchObject({ toolErrors: 2, nudgesMissed: 0 }) // grew-only counters keep the larger, nudgesMissed the newest
    expect(f.nudgesMissed).toBe(0)
    await finish(x)
  })

  test('the daily job gives up on a run after MAX_RECOUNT_ATTEMPTS recounts that stay incomplete', async () => {
    sessions.clear()
    const down: FrictionSource = {
      stepSessions: async () => {
        throw new Error('opencode is down')
      },
    }
    const x = setup(new FakeAgentHost(async () => ({ output: {} })), down)
    await x.rt.open()
    const { runId } = await x.rt.start(twoAgents, {}, { purpose: 'prod' })
    await x.rt.wait(runId)
    expect((await runOf(runId)).friction).toMatchObject({ incomplete: true })
    const recounter = frictionRecounter({
      db: new JournalDb({ connectionString: PG_URL, schema: db.schema }, captureLogger()),
      logger: captureLogger(),
      source: down,
    })
    const states: unknown[] = []
    for (let i = 0; i < MAX_RECOUNT_ATTEMPTS; i++) {
      await recounter.recount(runId, { retry: true })
      const f = (await sql.run(runId))?.friction as { incomplete?: unknown; recountAttempts?: number }
      states.push([f.incomplete, f.recountAttempts])
    }
    expect(states).toEqual([
      [true, 1],
      [true, 2],
      ['gave-up', 3],
    ])
    await recounter.recount(runId) // a plain delivery counts no attempt
    expect(((await sql.run(runId))?.friction as { recountAttempts?: number } | undefined)?.recountAttempts).toBe(3)

    // A host that is back answers completely: the flag and the attempts go.
    sessions.set('one', answer({ ses_1: { toolErrors: 1 } }))
    await frictionRecounter({
      db: new JournalDb({ connectionString: PG_URL, schema: db.schema }, captureLogger()),
      logger: captureLogger(),
      source,
    }).recount(runId, { retry: true })
    const f = (await sql.run(runId))?.friction as Record<string, unknown>
    expect(f.incomplete).toBeUndefined()
    expect(f.recountAttempts).toBeUndefined()
    await finish(x)
  })

  test('a recount with a complete answer replaces the step and clears the flag', async () => {
    sessions.clear()
    sessions.set('one', answer({ ses_1: { toolErrors: 4 } }))
    const x = setup(new FakeAgentHost(async () => ({ output: {} })), down)
    await x.rt.open()
    const { runId } = await x.rt.start(twoAgents, {}, { purpose: 'prod' })
    await x.rt.wait(runId)
    expect((await runOf(runId)).friction).toMatchObject({ incomplete: true, toolErrors: 0 })

    // The daily job's path: the same recount, host back up, a stale entry from the partial days gone.
    await sql.pool.query(
      `update "${db.schema}".runs set friction = jsonb_set(friction, '{sessions}', '{"one":{"ses_stale":{"toolErrors":9,"repeatToolCalls":0,"nudges":0,"nudgesMissed":0}}}'::jsonb) where id = $1`,
      [runId],
    )
    await frictionRecounter({
      db: new JournalDb({ connectionString: PG_URL, schema: db.schema }, captureLogger()),
      logger: captureLogger(),
      source,
    }).recount(runId)
    const f = (await sql.run(runId))?.friction as Record<string, unknown>
    expect(f.incomplete).toBeUndefined()
    expect(f).toMatchObject({ toolErrors: 4 })
    expect((f.sessions as Record<string, unknown>).one).toEqual({ ses_1: counters({ toolErrors: 4 }) })
    await finish(x)
  })
})

describe('probe concurrency', () => {
  test('steps are asked together, never more than PROBE_CONCURRENCY at once', async () => {
    let inflight = 0
    let peak = 0
    const slow: FrictionSource = {
      async stepSessions() {
        peak = Math.max(peak, ++inflight)
        await Bun.sleep(30)
        inflight--
        return answer({})
      },
    }
    const x = setup(new FakeAgentHost(async () => ({ output: {} })), slow)
    await x.rt.open()
    const { runId } = await x.rt.start(manyAgents, {}, { purpose: 'prod' })
    await x.rt.wait(runId)
    await runOf(runId)
    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThanOrEqual(PROBE_CONCURRENCY)
    await finish(x)
  })
})

describe('platform order', () => {
  test('friction comes before record, which reads the finished document', async () => {
    const platform = testPlatform(db.schema)
    const names = platform.middleware.map((m) => m.name)
    expect(names.indexOf('friction')).toBeGreaterThan(-1)
    expect(names.indexOf('friction')).toBeLessThan(names.indexOf('record'))
    await platform.close()
  })
})

describe('totalsOf', () => {
  test('sums sessions across steps, takes the highest repeat, counts events, keeps followUps and the incomplete flag', () => {
    expect(
      totalsOf({
        sessions: {
          a: { x: counters({ toolErrors: 1, repeatToolCalls: 2 }) },
          b: { y: counters({ toolErrors: 4, repeatToolCalls: 8, nudges: 3, nudgesMissed: 1 }) },
        },
        events: { 's#1': 'invalid_output', 'u#1': 'budget' },
        followUps: 1,
        incomplete: true,
      }),
    ).toMatchObject({
      toolErrors: 5,
      repeatToolCalls: 8,
      nudges: 3,
      nudgesMissed: 1,
      schemaReasks: 1,
      overBudget: 1,
      followUps: 1,
      incomplete: true,
    })
    expect(totalsOf(null)).toMatchObject({ toolErrors: 0, repeatToolCalls: 0, followUps: 0 })
  })
})

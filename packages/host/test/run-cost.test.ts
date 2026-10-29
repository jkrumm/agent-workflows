import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { z } from 'zod'
import { defineWorkflow } from '@agent-workflows/runtime'
import { waitFor } from '../src/operations.ts'
import type { StoredRun } from '../src/store.ts'
import { gate, startTestHost, type TestHost, until } from './support.ts'

const runGate = gate() // holds the run's first step: the run is live until a test releases it
const postHooks = gate() // holds the run record (runPost), so a run can have ended without it

/** Steps with a known price, one call without: the record sums 0.03 and counts one unpriced call. */
const mixed = defineWorkflow({
  id: 'cost.mixed',
  version: 'v1',
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  async run(ctx) {
    await ctx.step('hold', ({ signal }) =>
      Promise.race([
        runGate.released,
        new Promise<never>((_, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
        ),
      ]).then(() => true),
    )
    await ctx.step('priced', ({ addUsage }) => {
      addUsage({ model: 'm1', tokens: { input: 10, output: 2, cacheRead: 0, reasoning: 0 }, cost: 0.03 })
      return 1
    })
    await ctx.step('unpriced', ({ addUsage }) => {
      addUsage({ model: 'm1', tokens: { input: 5, output: 1, cacheRead: 0, reasoning: 0 }, cost: null })
      return 2
    })
    return { ok: true }
  },
})

/** Every store read, so a test can tell a wait that is polling from one that has answered, and how often it read. */
const reads: { runId: string; live: boolean; unrecorded: boolean }[] = []
const readsOf = (runId: string) => reads.filter((r) => r.runId === runId)
const endedReadsOf = (runId: string) => readsOf(runId).filter((r) => !r.live)
let t: TestHost
beforeAll(async () => {
  runGate.release()
  postHooks.release()
  t = await startTestHost({
    prefix: 'runcost',
    wrapStore: (store) => ({
      ping: (timeoutMs) => store.ping(timeoutMs),
      async get(runId) {
        const run = await store.get(runId)
        if (run) {
          const live = run.status === 'pending' || run.status === 'running'
          reads.push({ runId, live, unrecorded: !live && !run.postHooksDone })
        }
        return run
      },
    }),
    platform: true,
    extra: [{ workflow: mixed }],
    // holds the run record (the platform middleware runs after this one) whenever the gate is closed
    middleware: [{ name: 'hold-post', runPost: () => postHooks.released }],
  })
})
afterAll(async () => {
  runGate.release()
  postHooks.release()
  await t.close()
})

const sql = (runId: string, set: string) => t.pool.query(`update "${t.schema}".runs set ${set} where id = $1`, [runId])
const latestRun = async () =>
  (
    await t.pool.query(
      `select id from "${t.schema}".runs where workflow = 'cost.mixed' order by created_at desc, id desc limit 1`,
    )
  ).rows[0]?.id as string | undefined

/** A `cost.mixed` run held live on its step gate, with `postHooks` as the caller left them. */
async function liveRun() {
  runGate.reset()
  const started = await t.json(await t.call('/workflows/cost/mixed', { body: {} }))
  expect(started.status).toBe(202)
  return started.body.runId as string
}
const waitCall = (runId: string) => t.call(`/runs/${runId}/wait`, { method: 'POST', headers: { prefer: 'wait=20' } })
const polling = (runId: string) => until(() => readsOf(runId).some((r) => r.live), 'the wait polling the live run')

describe('a wait that sees the run end answers with its cost', () => {
  test('run wait: the final cost of the run own steps, an unpriced call counted', async () => {
    const runId = await liveRun()
    const waiting = waitCall(runId)
    await polling(runId)
    runGate.release()
    const { status, body } = await t.json(await waiting)
    expect(status).toBe(200)
    expect(body.status).toBe('done')
    expect(body.cost).toBeCloseTo(0.03, 6)
    expect(body.unpricedCalls).toBe(1)
    expect(body.costPending).toBeUndefined()
    expect(body.recordFailed).toBeUndefined()
    expect(Object.keys(body)).not.toContain('postHooksDone')
  })

  test('the start route holds the same way', async () => {
    runGate.reset()
    const started = t.call('/workflows/cost/mixed', { body: {}, headers: { prefer: 'wait=20' } })
    const runId = await until(latestRun, 'the started run')
    await polling(runId)
    runGate.release()
    const { status, body } = await t.json(await started)
    expect(status).toBe(200)
    expect(body.cost).toBeCloseTo(0.03, 6)
    expect(body.unpricedCalls).toBe(1)
  })

  test('the record held in runPost: the wait polls for it and does not answer before it lands', async () => {
    postHooks.reset()
    const runId = await liveRun()
    const waiting = waitCall(runId)
    let answered = false
    void waiting.then(() => {
      answered = true
    })
    await polling(runId)
    runGate.release()
    await until(() => readsOf(runId).filter((r) => r.unrecorded).length >= 2, 'two reads of the ended, unrecorded run')
    expect(answered).toBe(false)
    postHooks.release()
    const { body } = await t.json(await waiting)
    expect(body.cost).toBeCloseTo(0.03, 6)
    expect(body.costPending).toBeUndefined()
  })

  test('a priced run read after its hooks delivered carries the cost on run status', async () => {
    const { body: started } = await t.json(
      await t.call('/workflows/smoke/ping', { body: {}, headers: { prefer: 'wait=20' } }),
    )
    await until(
      async () =>
        (
          await t.pool.query(`select 1 from "${t.schema}".runs where id = $1 and post_hooks_at is not null`, [
            started.runId,
          ])
        ).rows[0],
      'the run record',
    )
    const { status, body } = await t.json(await t.call(`/runs/${started.runId}`))
    expect(status).toBe(200)
    expect(body.cost).toBeCloseTo(0.0007, 6)
    expect(body.unpricedCalls).toBe(0)
  })
})

describe('a read that did not see the run end answers the record as it is', () => {
  /** An ended run whose record is held; its reads are counted from here. */
  async function endedHeld() {
    postHooks.reset()
    const runId = await liveRun()
    runGate.release()
    await t.runtime.wait(runId) // the journal's own wait: no store read to count
    return runId
  }

  test('run status never holds: costPending at once, one read', async () => {
    const runId = await endedHeld()
    const { status, body } = await t.json(await t.call(`/runs/${runId}`))
    expect(status).toBe(200)
    expect(body).toMatchObject({ status: 'done', costPending: true })
    expect(body.cost).toBeUndefined()
    expect(endedReadsOf(runId)).toHaveLength(1)
    postHooks.release()
  })

  test('run wait on a run that already ended never holds', async () => {
    const runId = await endedHeld()
    const { body } = await t.json(await waitCall(runId))
    expect(body).toMatchObject({ status: 'done', costPending: true })
    expect(endedReadsOf(runId)).toHaveLength(1)
    postHooks.release()
  })

  test('run cancel of an ended run never holds either', async () => {
    const runId = await endedHeld()
    const { body } = await t.json(await t.call(`/runs/${runId}/cancel`, { method: 'POST' }))
    expect(body).toMatchObject({ status: 'done', costPending: true })
    expect(endedReadsOf(runId)).toHaveLength(2) // the existence check and the wait's single read
    postHooks.release()
  })

  test('a direct capability call does not pay a hold for a record it never reads', async () => {
    postHooks.reset()
    const response = await t.call('/llm/title', { body: { text: 'Hold nothing' } })
    expect(response.status).toBe(200)
    const runId = response.headers.get('agw-run-id') as string
    expect(readsOf(runId).filter((r) => r.unrecorded)).toHaveLength(1) // read once at the end, not polled
    postHooks.release()
  })
})

describe('what the answer says about the record', () => {
  async function endedHeld() {
    postHooks.reset()
    const runId = await liveRun()
    runGate.release()
    await t.runtime.wait(runId)
    return runId
  }

  test('hooks given up on: recordFailed, no cost, never a free run', async () => {
    const runId = await endedHeld()
    await sql(runId, 'post_hooks_at = now(), post_hooks_failed_at = now()') // what postHooksFailed writes at the cap
    const { body } = await t.json(await t.call(`/runs/${runId}`))
    expect(body).toMatchObject({ status: 'done', recordFailed: true })
    for (const absent of ['cost', 'unpricedCalls', 'costPending']) expect(body[absent]).toBeUndefined()
    postHooks.release()
  })

  test('a delivered row without the run-record columns (older than the record) answers a cost of null, not a failure', async () => {
    const runId = await endedHeld()
    await sql(runId, 'post_hooks_at = now(), cost = null, unpriced_calls = null') // delivered, failed_at stays null
    const { body } = await t.json(await t.call(`/runs/${runId}`))
    expect(body).toMatchObject({ status: 'done', cost: null, unpricedCalls: 0 })
    expect(body.costPending).toBeUndefined()
    expect(body.recordFailed).toBeUndefined()
    postHooks.release()
  })
})

describe('waitFor', () => {
  const live: StoredRun = {
    runId: 'r',
    workflowId: 'w',
    status: 'running',
    cost: null,
    unpricedCalls: 0,
    postHooksDone: false,
    postHooksFailed: false,
  }
  const unrecorded: StoredRun = { ...live, status: 'done', output: null }
  const recorded: StoredRun = { ...unrecorded, cost: 0.5, postHooksDone: true }
  const logs: string[] = []
  const logger = { warn: (m: string) => logs.push(m), error: (m: string) => logs.push(m) }
  /** A store replaying `script` (the last entry repeats); an Error entry is a failed read. */
  const scripted = (script: (StoredRun | Error)[]) => {
    const state = { reads: 0 }
    return {
      state,
      store: {
        ping: async () => {},
        get: async () => {
          const step = script[Math.min(state.reads++, script.length - 1)]
          if (step instanceof Error) throw step
          return step as StoredRun
        },
      },
    }
  }
  const sleeps: number[] = []
  const sleep = spyOn(Bun, 'sleep')
  beforeAll(() => {
    sleep.mockImplementation(async (ms) => {
      sleeps.push(Number(ms))
    })
  })
  afterAll(() => sleep.mockRestore())
  const wait = (
    store: ReturnType<typeof scripted>['store'],
    over: { recordWaitMs?: number; seconds?: number } = {},
  ) => {
    sleeps.length = 0
    logs.length = 0
    return waitFor({ store, runId: 'r', seconds: over.seconds ?? 60, logger, ...over })
  }

  test('a run seen ending is held until its record lands, then answers the sums', async () => {
    const { store, state } = scripted([live, unrecorded, unrecorded, recorded])
    const answer = await wait(store, { recordWaitMs: 5000 })
    expect(state.reads).toBe(4)
    expect(answer).toEqual({ runId: 'r', workflowId: 'w', status: 'done', output: null, cost: 0.5, unpricedCalls: 0 })
  })

  test('a record that never lands within the bound answers costPending and no cost', async () => {
    const { store } = scripted([live, unrecorded])
    const answer = await wait(store, { recordWaitMs: 40 })
    expect(answer).toMatchObject({ status: 'done', costPending: true })
    for (const own of ['cost', 'unpricedCalls', 'postHooksDone', 'postHooksFailed'])
      expect(answer).not.toHaveProperty(own)
  })

  test('the backoff restarts when the hold starts', async () => {
    const { store } = scripted([...Array(8).fill(live), unrecorded, unrecorded, recorded])
    await wait(store, { recordWaitMs: 5000 })
    expect(Math.max(...sleeps.slice(0, 8))).toBe(250) // the run phase backed off to its ceiling
    expect(sleeps.slice(8)).toEqual([25, 50]) // the hold's own, from the start
  })

  test('a run already ended at the first read is not held, nor is a wait without recordWaitMs', async () => {
    const ended = scripted([unrecorded])
    expect(await wait(ended.store, { recordWaitMs: 5000 })).toMatchObject({ costPending: true })
    expect(ended.state.reads).toBe(1)
    const noHold = scripted([live, unrecorded])
    expect(await wait(noHold.store)).toMatchObject({ costPending: true })
    expect(noHold.state.reads).toBe(2)
  })

  test('read failures in the hold are retried until the record lands, and warn only a few times', async () => {
    const down = new Error('connection lost')
    const { store, state } = scripted([live, unrecorded, ...Array(10).fill(down), recorded])
    expect(await wait(store, { recordWaitMs: 5000 })).toMatchObject({ cost: 0.5 })
    expect(state.reads).toBe(13)
    expect(logs).toHaveLength(3)
  })

  test('reads that keep failing through the hold answer pending when its deadline passes', async () => {
    const down = new Error('connection lost')
    const { store } = scripted([live, unrecorded, down])
    expect(await wait(store, { recordWaitMs: 40 })).toMatchObject({ status: 'done', costPending: true })
  })

  test('reads failing before the run ended still end the wait with the error', async () => {
    const down = new Error('connection lost')
    const { store, state } = scripted([live, down])
    const outcome = await wait(store, { recordWaitMs: 5000 }).then(
      () => 'answered',
      (error: Error) => error.message,
    )
    expect(outcome).toBe('connection lost')
    expect(state.reads).toBe(6) // the live read, then five failures in a row
  })

  test('hooks given up on answer recordFailed with no cost; delivered sums come with no failure flag', async () => {
    const gaveUp = scripted([{ ...unrecorded, postHooksDone: true, postHooksFailed: true }])
    expect(await wait(gaveUp.store)).toEqual({
      runId: 'r',
      workflowId: 'w',
      status: 'done',
      output: null,
      recordFailed: true,
    })
    expect(await wait(scripted([recorded]).store)).not.toHaveProperty('recordFailed')
  })
})

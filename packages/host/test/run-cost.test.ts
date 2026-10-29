import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { defineWorkflow } from '@agent-workflows/runtime'
import { RECORD_FRESH_MS, waitFor } from '../src/operations.ts'
import type { RunState, StoredRun } from '../src/store.ts'
import { gate, startTestHost, type TestHost, until } from './support.ts'

/** Steps with a known price, one call without: the record sums 0.03 and counts one unpriced call. */
const mixed = defineWorkflow({
  id: 'cost.mixed',
  version: 'v1',
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  async run(ctx) {
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

const postHooks = gate()
postHooks.release() // a gate starts closed; tests close it when they need the record held
/** Every store read, so a test can tell a wait that is polling from one that has answered, and how often it read. */
const reads: { runId: string; unrecorded: boolean; ended: boolean }[] = []
let t: TestHost
beforeAll(async () => {
  t = await startTestHost({
    prefix: 'runcost',
    wrapStore: (store) => ({
      ping: (timeoutMs) => store.ping(timeoutMs),
      async get(runId) {
        const state = await store.get(runId)
        if (state) {
          const ended = state.status === 'done'
          reads.push({ runId, ended, unrecorded: ended && !state.recorded && !state.postHooksDone })
        }
        return state
      },
    }),
    platform: true,
    extra: [{ workflow: mixed }],
    // holds the run record (the platform middleware runs after this one) whenever the gate is closed
    middleware: [{ name: 'hold-post', runPost: () => postHooks.released }],
  })
})
afterAll(async () => {
  postHooks.release()
  await t.close()
})

describe('a run answer carries its final priced cost', () => {
  test('a priced run answers with its cost on the start call, run wait and run status', async () => {
    const started = await t.json(await t.call('/workflows/smoke/ping', { body: {}, headers: { prefer: 'wait=20' } }))
    expect(started.status).toBe(200)
    expect(started.body.cost).toBeCloseTo(0.0007, 6)
    expect(started.body.unpricedCalls).toBe(0)
    expect(started.body.costPending).toBeUndefined()
    expect(started.body.postHooksDone).toBeUndefined() // the wait's business, not the wire's

    for (const [path, method] of [
      [`/runs/${started.body.runId}`, 'GET'],
      [`/runs/${started.body.runId}/wait`, 'POST'],
    ] as const) {
      const again = await t.json(await t.call(path, { method }))
      expect(again.status).toBe(200)
      expect(again.body).toMatchObject({ cost: started.body.cost, unpricedCalls: 0 })
      expect(again.body.costPending).toBeUndefined()
    }
  })

  test('an unpriced call shows in the answer: the cost is the priced part, unpricedCalls counts the rest', async () => {
    const { status, body } = await t.json(
      await t.call('/workflows/cost/mixed', { body: {}, headers: { prefer: 'wait=20' } }),
    )
    expect(status).toBe(200)
    expect(body.cost).toBeCloseTo(0.03, 6)
    expect(body.unpricedCalls).toBe(1)
    expect(body.costPending).toBeUndefined()
  })

  test('a failed run carries a record too, with no cost when nothing was priced', async () => {
    const { body } = await t.json(await t.call('/workflows/boom/fail', { body: {}, headers: { prefer: 'wait=20' } }))
    expect(body).toMatchObject({ status: 'failed', cost: null, unpricedCalls: 0 })
  })

  test('a run that has not ended carries no cost fields', async () => {
    const { body } = await t.json(await t.call('/workflows/hold/open', { body: {} }))
    expect(body.status).not.toBe('done')
    expect(body.cost).toBeUndefined()
    expect(body.unpricedCalls).toBeUndefined()
    expect(body.costPending).toBeUndefined()
    t.gate.release()
    await t.call(`/runs/${body.runId}/cancel`, { method: 'POST' })
  })

  test('the answer to an ended run waits for the record held in runPost: no cost before it lands', async () => {
    postHooks.reset()
    const started = await t.json(await t.call('/workflows/cost/mixed', { body: {} }))
    const wait = t.call(`/runs/${started.body.runId}/wait`, { method: 'POST', headers: { prefer: 'wait=20' } })
    let answered = false
    void wait.then(() => {
      answered = true
    })
    // the wait has read the ended run, hooks still held, and read it again: it is polling for the record, not answering
    await until(
      () => reads.filter((r) => r.runId === started.body.runId && r.unrecorded).length >= 2,
      'two reads of the ended, unrecorded run',
    )
    expect(answered).toBe(false)
    postHooks.release()
    const { status, body } = await t.json(await wait)
    expect(status).toBe(200)
    expect(body.status).toBe('done')
    expect(body.cost).toBeCloseTo(0.03, 6)
    expect(body.unpricedCalls).toBe(1)
    expect(body.costPending).toBeUndefined()
  })

  const readsOf = (runId: string) => reads.filter((r) => r.runId === runId).length
  const setSql = (runId: string, set: string) =>
    t.pool.query(`update "${t.schema}".runs set ${set} where id = $1`, [runId])

  test('an old ended run whose hooks never came answers costPending at once, without the hold', async () => {
    postHooks.reset()
    const started = await t.json(await t.call('/workflows/cost/mixed', { body: {} }))
    const runId = started.body.runId as string
    await t.runtime.wait(runId) // the journal's own wait: no store read to count
    await setSql(runId, `finished_at = now() - interval '1 hour'`)
    const before = readsOf(runId)
    const { status, body } = await t.json(await t.call(`/runs/${runId}`))
    expect(status).toBe(200)
    expect(body).toMatchObject({ status: 'done', costPending: true })
    expect(body.cost).toBeUndefined()
    expect(readsOf(runId) - before).toBe(1) // one read, no polling for a record that is not coming
    postHooks.release()
  })

  test('hooks given up on without a record answer costPending, never a final cost of null', async () => {
    postHooks.reset()
    const started = await t.json(await t.call('/workflows/cost/mixed', { body: {} }))
    const runId = started.body.runId as string
    await t.runtime.wait(runId) // the journal's own wait: no store read to count
    await setSql(runId, 'post_hooks_at = now()') // what postHooksFailed does after maxPostHookAttempts
    const before = readsOf(runId)
    const { body } = await t.json(await t.call(`/runs/${runId}/wait`, { method: 'POST' }))
    expect(body).toMatchObject({ status: 'done', costPending: true })
    expect(body.cost).toBeUndefined()
    expect(body.unpricedCalls).toBeUndefined()
    expect(readsOf(runId) - before).toBe(1)
    postHooks.release()
  })

  test('a direct capability call does not pay the hold for a record it never reads', async () => {
    postHooks.reset()
    const response = await t.call('/llm/title', { body: { text: 'Hold nothing' } })
    expect(response.status).toBe(200)
    const runId = response.headers.get('agw-run-id') as string
    // one read of the ended run, and it was not held for the (held) record
    expect(reads.filter((r) => r.runId === runId && r.unrecorded)).toHaveLength(1)
    postHooks.release()
  })
})

describe('waitFor holds an ended run for its record, bounded', () => {
  const ended: StoredRun = {
    runId: 'r',
    workflowId: 'w',
    status: 'done',
    output: null,
    cost: 0.5,
    unpricedCalls: 0,
    recorded: true,
    postHooksDone: true,
    endedAt: Date.now(),
  }
  const unrecorded: StoredRun = { ...ended, cost: null, recorded: false, postHooksDone: false }
  const quiet = { warn() {}, error() {} }
  const storeOf = (get: () => StoredRun) => ({ get: async () => get(), ping: async () => {} })

  test('a record that never lands within the bound answers costPending, not a number', async () => {
    const answer = await waitFor(
      storeOf(() => unrecorded),
      'r',
      0,
      quiet,
      undefined,
      60,
    )
    expect(answer).toMatchObject({ status: 'done', costPending: true })
    expect(answer).not.toHaveProperty('cost')
    for (const own of ['postHooksDone', 'recorded', 'endedAt']) expect(answer).not.toHaveProperty(own)
  })

  test('a record that lands inside the bound is the answer, with no costPending', async () => {
    let reads = 0
    const answer = await waitFor(
      storeOf(() => (++reads > 3 ? ended : unrecorded)),
      'r',
      0,
      quiet,
      undefined,
      5000,
    )
    expect(reads).toBe(4)
    expect(answer).toEqual({
      runId: 'r',
      workflowId: 'w',
      status: 'done',
      output: null,
      cost: 0.5,
      unpricedCalls: 0,
    })
  })

  test('a read that fails during the hold is retried until the record lands', async () => {
    let reads = 0
    const store = {
      ping: async () => {},
      get: async (): Promise<StoredRun> => {
        reads++
        if (reads === 2 || reads === 3) throw new Error('connection lost')
        return reads > 3 ? ended : unrecorded
      },
    }
    expect(await waitFor(store, 'r', 0, quiet)).toMatchObject({ status: 'done', cost: 0.5 })
    expect(reads).toBe(4)
  })

  test('reads that keep failing through the hold answer pending when its deadline passes', async () => {
    let reads = 0
    const store = {
      ping: async () => {},
      get: async (): Promise<StoredRun> => {
        if (++reads > 1) throw new Error('connection lost')
        return unrecorded
      },
    }
    expect(await waitFor(store, 'r', 0, quiet, undefined, 80)).toMatchObject({ status: 'done', costPending: true })
    expect(reads).toBeGreaterThan(2)
  })

  test('recordWaitMs 0 skips the hold; a run ended long ago, or with its hooks done, is not held either', async () => {
    let reads = 0
    const count = (state: StoredRun) => () => {
      reads++
      return state
    }
    expect(await waitFor(storeOf(count(unrecorded)), 'r', 0, quiet, undefined, 0)).toMatchObject({ costPending: true })
    const old = { ...unrecorded, endedAt: Date.now() - RECORD_FRESH_MS - 1000 }
    expect(await waitFor(storeOf(count(old)), 'r', 0, quiet)).toMatchObject({ costPending: true })
    const gaveUp = { ...unrecorded, postHooksDone: true }
    expect(await waitFor(storeOf(count(gaveUp)), 'r', 0, quiet)).toMatchObject({ costPending: true })
    expect(reads).toBe(3) // one read each, no polling
  })
})

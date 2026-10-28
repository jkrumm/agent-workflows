import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { computeFingerprint, type FingerprintSource } from '@agent-workflows/middleware'
import { defineWorkflow } from '@agent-workflows/runtime'
import { FakeAgentHost } from '@agent-workflows/runtime/testing'
import { z } from 'zod'
import {
  createLearningsWorkflows,
  LEARNINGS_FINGERPRINT_FILE,
  type LearningsStore,
  LearningNotFound,
  LearningStateError,
  MAX_ACTIVE_FACTS,
  pgLearningsStore,
  renderLearnedFacts,
  withLearnedFacts,
  withLearningsFingerprint,
} from '../src/learnings/index.ts'
import { freshSchema, inspector, testRuntime } from '../../runtime/test/support/pg.ts'
import { startTestHost, type TestHost } from './support.ts'

let t: TestHost
let store: LearningsStore
/** The store exists only once the host's schema does; the operations are built first and delegate. */
const late: LearningsStore = {
  list: (...a) => store.list(...a),
  add: (...a) => store.add(...a),
  activate: (...a) => store.activate(...a),
  retire: (...a) => store.retire(...a),
  activeFor: (...a) => store.activeFor(...a),
}

beforeAll(async () => {
  t = await startTestHost({ prefix: 'learn', extra: createLearningsWorkflows(late) })
  store = pgLearningsStore(t.pool, t.schema)
})
afterAll(async () => {
  await t.close()
})

let n = 0
const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  )
const fact = (text = 'f') => `${text} ${++n}`

describe('store', () => {
  test('add proposes; activate makes it read back; retire ends it at once', async () => {
    const f = fact('this shop blocks at TLS')
    const { learning, created } = await store.add({ agent: 'store-a', fact: f, source: 'run-1', evidence: ['run-1'] })
    expect(created).toBe(true)
    expect(learning).toMatchObject({
      agent: 'store-a',
      fact: f,
      source: 'run-1',
      status: 'proposed',
      evidence: ['run-1'],
    })
    expect(await store.activeFor('store-a')).toEqual([])

    const active = await store.activate(learning.id)
    expect(active.status).toBe('active')
    expect(active.activatedAt).not.toBeNull()
    expect((await store.activeFor('store-a')).map((l) => l.id)).toEqual([learning.id])
    expect(await store.activeFor('store-b')).toEqual([]) // per agent

    const retired = await store.retire(learning.id)
    expect(retired).toMatchObject({ status: 'retired' })
    expect(retired.retiredAt).not.toBeNull()
    expect(await store.activeFor('store-a')).toEqual([])
    expect((await store.retire(learning.id)).status).toBe('retired') // idempotent
  })

  test('a live identical fact is stored once; a retired one can be proposed again', async () => {
    const f = fact('dup')
    const first = await store.add({ agent: 'store-dup', fact: f, source: 'run-1' })
    const again = await store.add({ agent: 'store-dup', fact: f, source: 'run-2' })
    expect(again).toMatchObject({ created: false, learning: { id: first.learning.id, source: 'run-1' } })
    await store.retire(first.learning.id)
    const back = await store.add({ agent: 'store-dup', fact: f, source: 'run-3' })
    expect(back.created).toBe(true)
    expect(back.learning.id).not.toBe(first.learning.id)
  })

  test('adding an already proposed fact as active activates it', async () => {
    const f = fact('later active')
    const first = await store.add({ agent: 'store-up', fact: f, source: 'run-1' })
    const up = await store.add({ agent: 'store-up', fact: f, source: 'manual', status: 'active' })
    expect(up).toMatchObject({ created: false, learning: { id: first.learning.id, status: 'active' } })
  })

  test('activating a retired or unknown fact is refused', async () => {
    const { learning } = await store.add({ agent: 'store-r', fact: fact(), source: 'manual' })
    await store.retire(learning.id)
    expect(await failure(store.activate(learning.id))).toBeInstanceOf(LearningStateError)
    expect(await failure(store.activate(999_999_999))).toBeInstanceOf(LearningNotFound)
    expect(await failure(store.retire(999_999_999))).toBeInstanceOf(LearningNotFound)
  })

  test('list filters by agent and status; the read-back keeps the newest facts, oldest first', async () => {
    const agent = 'store-cap'
    const ids: number[] = []
    for (let i = 0; i < MAX_ACTIVE_FACTS + 3; i++) {
      const { learning } = await store.add({ agent, fact: fact('cap'), source: 'manual', status: 'active' })
      ids.push(learning.id)
    }
    const read = await store.activeFor(agent)
    expect(read.map((l) => l.id)).toEqual(ids.slice(3))
    expect(await store.list({ agent, status: 'proposed' })).toEqual([])
    expect((await store.list({ agent, limit: 5 })).map((l) => l.id)).toEqual(ids.slice(-5).reverse())
  })
})

describe('read-back into the agent step', () => {
  const answer = z.object({ answer: z.string() })
  const wf = (id: string) =>
    defineWorkflow({
      id,
      version: 'v1',
      input: z.object({}),
      output: answer,
      run: (ctx) => ctx.agent('ask', { agent: 'readback', prompt: 'the task', output: answer }),
    })
  const db = freshSchema('learnrb')
  const sql = inspector(db.schema)
  afterAll(async () => {
    await sql.close()
    await db.drop()
  })

  test('active facts follow the task in a fenced block; proposed and retired ones do not', async () => {
    const own = pgLearningsStore(sql.pool, db.schema)
    const host = new FakeAgentHost(async (s) => ({ output: { answer: s.spec.prompt } }))
    const first = wf('rb.first')
    const second = wf('rb.second')
    const third = wf('rb.third')
    const rt = testRuntime({
      schema: db.schema,
      workflows: [first, second, third],
      host,
      agentPrompt: async ({ agent, prompt }) => withLearnedFacts(prompt, await own.activeFor(agent)),
    })
    await rt.open()
    try {
      const { learning } = await own.add({ agent: 'readback', fact: 'the build host has no GPU', source: 'run-1' })
      const prompt = async (w: typeof first) => {
        const { runId } = await rt.start(w, {}, { purpose: 'build' })
        return ((await rt.wait(runId)).output as { answer: string }).answer
      }
      expect(await prompt(first)).toBe('the task') // proposed: nothing appended

      await own.activate(learning.id)
      const withFact = await prompt(second)
      expect(withFact.startsWith('the task\n\n<learned_facts>')).toBe(true)
      expect(withFact).toContain('- the build host has no GPU')
      expect(withFact.endsWith('</learned_facts>')).toBe(true)

      await own.retire(learning.id)
      expect(await prompt(third)).toBe('the task') // effective on the very next run
    } finally {
      await rt.close()
    }
  })

  test('the block is empty for no facts and one line per fact otherwise', () => {
    expect(renderLearnedFacts([])).toBe('')
    expect(withLearnedFacts('x', [])).toBe('x')
    expect(
      renderLearnedFacts([{ fact: 'a\n  b' }, { fact: 'c' }])
        .split('\n')
        .filter((l) => l.startsWith('- ')),
    ).toEqual(['- a b', '- c'])
  })
})

describe('fingerprint', () => {
  const inner: FingerprintSource = {
    inputs: async () => ({
      agents: [
        { name: 'fp-a', files: { 'AGENTS.md': 'rules' }, route: 'r' },
        { name: 'fp-b', files: { 'AGENTS.md': 'rules' }, route: 'r' },
      ],
      opencodeVersion: '1',
    }),
  }
  const fingerprint = async (source: FingerprintSource) =>
    computeFingerprint('v1', await source.inputs({ id: 'w', version: 'v1' }))

  test('an agent without active facts keeps the fingerprint it had; activate and retire move it', async () => {
    const wrapped = withLearningsFingerprint(inner, late)
    const base = await fingerprint(inner)
    expect(await fingerprint(wrapped)).toBe(base)

    const { learning } = await store.add({ agent: 'fp-a', fact: fact('fp'), source: 'manual' })
    expect(await fingerprint(wrapped)).toBe(base) // proposed does not count

    await store.activate(learning.id)
    const active = await fingerprint(wrapped)
    expect(active).not.toBe(base)
    expect((await wrapped.inputs({ id: 'w', version: 'v1' })).agents[0]?.files[LEARNINGS_FINGERPRINT_FILE]).toBeString()
    expect(
      (await wrapped.inputs({ id: 'w', version: 'v1' })).agents[1]?.files[LEARNINGS_FINGERPRINT_FILE],
    ).toBeUndefined()

    const other = await store.add({ agent: 'fp-a', fact: fact('fp'), source: 'manual', status: 'active' })
    expect(await fingerprint(wrapped)).not.toBe(active) // a second fact changes the set

    await store.retire(other.learning.id)
    expect(await fingerprint(wrapped)).toBe(active)
    await store.retire(learning.id)
    expect(await fingerprint(wrapped)).toBe(base)
  })
})

describe('agw learnings operations', () => {
  const start = async (path: string, body: unknown) =>
    t.json(await t.call(`/workflows/learnings/${path}`, { body, headers: { prefer: 'wait=20' } }))

  test('add → list → activate → retire over HTTP, each a journaled run', async () => {
    const f = fact('ops')
    const added = await start('add', { agent: 'ops-agent', fact: f })
    expect(added.body).toMatchObject({
      status: 'done',
      output: { learning: { agent: 'ops-agent', fact: f, source: 'manual', status: 'proposed' } },
    })
    const id = added.body.output.learning.id as number

    const listed = await start('list', { agent: 'ops-agent' })
    expect(listed.body.output.learnings.map((l: { id: number }) => l.id)).toEqual([id])

    const activated = await start('activate', { id })
    expect(activated.body.output.learning.status).toBe('active')
    expect((await store.activeFor('ops-agent')).map((l) => l.fact)).toEqual([f])

    const retired = await start('retire', { id })
    expect(retired.body.output.learning.status).toBe('retired')
    expect(await store.activeFor('ops-agent')).toEqual([])
    expect(
      (await t.pool.query(`select workflow from "${t.schema}".runs where workflow like 'learnings.%'`)).rows.length,
    ).toBe(4)
  })

  test('add --activate stores it active; an unknown id fails the run with the reason', async () => {
    const f = fact('ops-active')
    const added = await start('add', { agent: 'ops-agent-2', fact: f, activate: true })
    expect(added.body.output.learning.status).toBe('active')
    const missing = await start('activate', { id: 999_999_999 })
    expect(missing.body).toMatchObject({ status: 'failed' })
    expect(missing.body.error.message).toContain('not found')
  })

  test('bad input is a 400: a fact over the limit, an agent name that is not a name', async () => {
    expect((await start('add', { agent: 'ops', fact: 'x'.repeat(401) })).status).toBe(400)
    expect((await start('add', { agent: '../etc', fact: 'x' })).status).toBe(400)
    expect((await start('add', { agent: 'ops', fact: 'x', status: 'active' })).status).toBe(400) // strict input
  })
})

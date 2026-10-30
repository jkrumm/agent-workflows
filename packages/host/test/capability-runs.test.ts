import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { CapabilityCallError } from '@agent-workflows/capabilities'
import { StepFailed } from '@agent-workflows/runtime'
import { messageResponse } from '@agent-workflows/capabilities/testing'
import { failureOf, journaled, journaledError, RUN_ID_HEADER } from '../src/capability-runs.ts'
import { type Body, SECRET, startTestHost, type TestHost, until } from './support.ts'

const TITLE = 'A Smoke Title'
const ok = () =>
  messageResponse(TITLE, { input_tokens: 40, output_tokens: 6, cache_read_input_tokens: 10, cost: 0.0007 })

const silent = { warn: () => {}, error: () => {} }

let t: TestHost
beforeAll(async () => {
  t = await startTestHost({ prefix: 'caprun', platform: true })
})
afterEach(() => {
  t.iu.on('messages', ok)
})
afterAll(async () => {
  await t.close()
})

const runs = async (workflow: string) =>
  (await t.pool.query(`select * from "${t.schema}".runs where workflow = $1 order by id`, [workflow])).rows
const runRow = async (id: string) =>
  (await t.pool.query(`select * from "${t.schema}".runs where id = $1`, [id])).rows[0]

/** What the capability answers without the host's run: the registry's own door, as before N6. */
const plain = (body: unknown) =>
  t.registry.fetch(
    new Request('http://x/llm/title', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )

test('a direct llm.title call answers as before and leaves a done cap.llm.title run that reaches Argo', async () => {
  const response = await t.call('/llm/title', {
    body: { text: 'Quarterly numbers' },
    headers: { 'x-agw-purpose': 'test' },
  })
  expect(response.status).toBe(200)
  const body = (await response.json()) as Body
  expect(body).toEqual((await (await plain({ text: 'Quarterly numbers' })).json()) as Body)
  expect(body).toEqual({ title: TITLE })

  const runId = response.headers.get(RUN_ID_HEADER) as string
  expect(runId).toBeTruthy()
  const run = await until(async () => {
    const row = await runRow(runId)
    return row?.post_hooks_at ? row : null
  }, 'run record')
  expect(run).toMatchObject({ workflow: 'cap.llm.title', status: 'done', purpose: 'test', tokens_input: '50' })
  expect(Number(run.cost)).toBeCloseTo(0.0007, 6)

  const { rows: steps } = await t.pool.query(`select * from "${t.schema}".steps where run_id = $1`, [runId])
  expect(steps).toHaveLength(1)
  expect(steps[0]).toMatchObject({ step_id: 'call', kind: 'code', status: 'done', tokens_input: '50' })

  await t.platform?.outbox?.flush()
  const stored = [...t.usage.stored.values()].filter((r) => r.source_id.startsWith(`${runId}:call:`))
  expect(stored).toHaveLength(1)
  expect(stored[0]).toMatchObject({
    lane_detail: { workflow: 'cap.llm.title' },
    machine: 'test-machine',
    input_tokens: 40,
  })
})

test('an upstream failure answers with the same error and leaves the run failed', async () => {
  t.iu.on('messages', () => new Response('upstream down', { status: 500 }))
  const response = await t.call('/llm/title', { body: { text: 'Broken' } })
  const expected = await plain({ text: 'Broken' })
  expect(response.status).toBe(expected.status)
  const body = (await response.json()) as Body
  expect(body).toEqual((await expected.json()) as Body)
  expect(body).toMatchObject({ code: 'UPSTREAM_ERROR', status: 502, defined: true })

  const runId = response.headers.get(RUN_ID_HEADER) as string
  const run = await runRow(runId)
  expect(run).toMatchObject({ workflow: 'cap.llm.title', status: 'failed', error_kind: 'step_failed' })
  expect(run.error).toContain('UPSTREAM_ERROR')
})

test('invalid input is refused before any run exists', async () => {
  const before = (await runs('cap.llm.title')).length
  for (const body of [{ text: 1 }, { text: 'x', bogus: true }, {}]) {
    const response = await t.call('/llm/title', { body })
    const expected = await plain(body)
    expect(response.status).toBe(expected.status)
    expect(response.status).toBe(400)
    expect(response.headers.get(RUN_ID_HEADER)).toBeNull()
    expect((await response.json()) as Body).toEqual((await expected.json()) as Body)
  }
  expect(await runs('cap.llm.title')).toHaveLength(before)
})

test('a bad purpose header is a 400 and starts nothing', async () => {
  const before = (await runs('cap.llm.title')).length
  const response = await t.call('/llm/title', { body: { text: 'x' }, headers: { 'x-agw-purpose': 'no spaces' } })
  expect(response.status).toBe(400)
  expect(await runs('cap.llm.title')).toHaveLength(before)
})

test('smoke.ping still creates exactly one run: its capability call is not a nested run', async () => {
  const before = (await runs('cap.llm.title')).length
  const { status, body } = await t.json(
    await t.call('/workflows/smoke/ping', { method: 'POST', headers: { prefer: 'wait=20' } }),
  )
  expect(status).toBe(200)
  const { rows } = await t.pool.query(`select * from "${t.schema}".runs where root_id = $1`, [body.runId])
  expect(rows).toHaveLength(1)
  expect(rows[0].workflow).toBe('smoke.ping')
  expect(await runs('cap.llm.title')).toHaveLength(before)
})

test('the same Idempotency-Key twice answers with the first run, without a second upstream call', async () => {
  const headers = { 'idempotency-key': 'title-once' }
  const calls = t.iu.requests.length
  const first = await t.call('/llm/title', { body: { text: 'Once' }, headers })
  const second = await t.call('/llm/title', { body: { text: 'Once' }, headers })
  expect(first.status).toBe(200)
  expect(second.status).toBe(200)
  expect(await second.json()).toEqual(await first.json())
  expect(second.headers.get(RUN_ID_HEADER)).toBe(first.headers.get(RUN_ID_HEADER))
  expect(t.iu.requests.length).toBe(calls + 1)

  const conflict = await t.call('/llm/title', { body: { text: 'Other' }, headers })
  expect(conflict.status).toBe(409)
})

test('a replayed failed run answers with the same code from the journal', async () => {
  t.iu.on('messages', () => new Response('upstream down', { status: 500 }))
  const headers = { 'idempotency-key': 'title-failing' }
  const first = await t.call('/llm/title', { body: { text: 'Failing' }, headers })
  const calls = t.iu.requests.length
  const second = await t.call('/llm/title', { body: { text: 'Failing' }, headers })
  expect(t.iu.requests.length).toBe(calls)
  const [a, b] = [(await first.json()) as Body, (await second.json()) as Body]
  expect(second.status).toBe(first.status)
  expect(b).toEqual(a)
  expect(b).toMatchObject({ code: 'UPSTREAM_ERROR', defined: true })
})

/** Holds every fake IU answer until `release()`. */
function holdIu() {
  let release = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  t.iu.on('messages', async () => {
    await held
    return ok()
  })
  return release
}

/** A direct `llm.title` request the test can abort. */
function abortable(text: string, headers: Record<string, string> = {}) {
  const controller = new AbortController()
  const response = t.host.fetch(
    new Request('http://127.0.0.1:7791/llm/title', {
      method: 'POST',
      headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    }),
  )
  return { response, abort: () => controller.abort() }
}

const freshRunning = async (before: Set<string>) =>
  until(async () => {
    const fresh = (await runs('cap.llm.title')).find((r) => !before.has(r.id))
    return fresh?.status === 'running' ? fresh : null
  }, 'running run')

const ids = async () => new Set((await runs('cap.llm.title')).map((r) => r.id as string))

test('a client without an Idempotency-Key that goes away cancels its run', async () => {
  const release = holdIu()
  const before = await ids()
  const call = abortable('Abandoned')
  const run = await freshRunning(before)
  call.abort()
  await call.response.catch(() => undefined)
  await until(async () => (await runRow(run.id)).status === 'cancelled', 'cancelled run')
  release()
})

test('a keyed client that goes away leaves the run to finish; the retry gets its output', async () => {
  const release = holdIu()
  const before = await ids()
  const headers = { 'idempotency-key': 'title-abandoned' }
  const call = abortable('Keyed and abandoned', headers)
  const run = await freshRunning(before)
  call.abort()
  await call.response.catch(() => undefined)
  release()
  await until(async () => (await runRow(run.id)).status === 'done', 'done run')
  const calls = t.iu.requests.length
  const retry = await t.call('/llm/title', { body: { text: 'Keyed and abandoned' }, headers })
  expect(retry.status).toBe(200)
  expect(await retry.json()).toEqual({ title: TITLE })
  expect(retry.headers.get(RUN_ID_HEADER)).toBe(run.id)
  expect(t.iu.requests.length).toBe(calls)
})

test("a retry with A's key that goes away does not cancel A's run", async () => {
  const release = holdIu()
  const before = await ids()
  const headers = { 'idempotency-key': 'title-shared' }
  const a = abortable('Shared', headers)
  const run = await freshRunning(before)
  const b = abortable('Shared', headers)
  await Bun.sleep(100) // b is waiting on the same run
  b.abort()
  await b.response.catch(() => undefined)
  release()
  const response = await a.response
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ title: TITLE })
  expect((await runRow(run.id)).status).toBe('done')
})

describe('the journaled error wire format', () => {
  const asRun = (error: CapabilityCallError, kind = 'error') =>
    ({
      runId: 'r1',
      workflowId: 'cap.llm.title',
      status: 'failed',
      error: { kind: 'step_failed', message: `step "call" failed (${kind}): ${journaled(error)}` },
    }) as const

  test('round-trips code, status, message and data, whatever they contain', () => {
    const error = new CapabilityCallError('INVALID_OUTPUT', 502, 'bad answer {"a": 1}', true, {
      attempts: 2,
      reason: 'got {"x": {"y": 1}} \n and more {',
    })
    const answer = journaledError(asRun(error).error.message)
    expect(answer).toMatchObject({ code: 'INVALID_OUTPUT', status: 502, message: 'bad answer {"a": 1}' })
    expect(answer?.data).toEqual(error.data)
    expect(failureOf(asRun(error), silent).toJSON()).toMatchObject({ code: 'INVALID_OUTPUT', data: error.data })
  })

  test("the runtime's own wording of a failed step parses: a wording change fails here, not as a silent 500", async () => {
    const error = new CapabilityCallError('UPSTREAM_ERROR', 502, 'down', true, { status: 500 })
    const failed = new StepFailed('call', 'error', journaled(error))
    expect(journaledError(failed.message)?.toJSON()).toMatchObject({ code: 'UPSTREAM_ERROR', data: { status: 500 } })

    // ... and the run row a real upstream failure leaves in the journal
    t.iu.on('messages', () => new Response('upstream down', { status: 500 }))
    const response = await t.call('/llm/title', { body: { text: 'Journaled' } })
    const run = await runRow(response.headers.get(RUN_ID_HEADER) as string)
    expect(journaledError(run.error)?.toJSON()).toMatchObject({ code: 'UPSTREAM_ERROR', status: 502 })
  })

  test('a message that only looks journaled is not taken for one', () => {
    expect(journaledError('step "call" failed (error): boom\n{"code":"X","status":400}')).toBeNull()
    expect(journaledError('step "call" failed (error): UPSTREAM_ERROR: down {"status":502}')).toBeNull()
  })

  test("a failure that is not the capability's is an opaque 500; a refusal a 503 with its reason", () => {
    const errors: unknown[] = []
    const logger = { warn: () => {}, error: (_: string, meta?: unknown) => void errors.push(meta) }
    const infra = failureOf(
      {
        runId: 'r2',
        workflowId: 'cap.llm.title',
        status: 'failed',
        error: { kind: 'invalid_output', message: 'db secret detail' },
      },
      logger,
    )
    expect(infra.toJSON()).toMatchObject({ code: 'INTERNAL_SERVER_ERROR', status: 500, message: 'run r2 failed' })
    expect(JSON.stringify(infra.toJSON())).not.toContain('secret')
    expect(JSON.stringify(errors)).toContain('db secret detail')

    const wallet = failureOf(
      {
        runId: 'r3',
        workflowId: 'cap.llm.title',
        status: 'failed',
        error: { kind: 'admission_refused', message: 'wallet gate: paused' },
      },
      logger,
    )
    expect(wallet.toJSON()).toMatchObject({ code: 'SERVICE_UNAVAILABLE', status: 503, message: 'wallet gate: paused' })
    const runaway = failureOf(
      {
        runId: 'r4',
        workflowId: 'cap.llm.title',
        status: 'failed',
        error: { kind: 'step_failed', message: 'step "call" failed (middleware): runaway cap: steps 9 > cap 8' },
      },
      logger,
    )
    expect(runaway.toJSON()).toMatchObject({
      status: 503,
      message: 'runaway cap: steps 9 > cap 8',
      data: { kind: 'middleware' },
    })
  })
})

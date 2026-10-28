import { afterAll, beforeAll, expect, test } from 'bun:test'
import { SMOKE_TEXT } from '../src/workflows/smoke.ts'
import { startTestHost, type TestHost, until } from './support.ts'

let t: TestHost
beforeAll(async () => {
  t = await startTestHost({ prefix: 'smoke', platform: true })
})
afterAll(async () => {
  await t.close()
})

test('smoke.ping end to end: llm.title through the registry, usage on the step, the row reaches Argo', async () => {
  const { status, body } = await t.json(
    await t.call('/workflows/smoke/ping', { method: 'POST', headers: { prefer: 'wait=20' } }),
  )
  expect(status).toBe(200)
  expect(body).toMatchObject({ workflowId: 'smoke.ping', status: 'done', output: { title: 'A Smoke Title' } })

  // the default sentence went to the capability
  const [request] = t.iu.requests
  expect(JSON.stringify(request?.body)).toContain(SMOKE_TEXT)

  // usage is recorded on the step, priced by the provider
  const { rows } = await t.pool.query(`select * from "${t.schema}".steps where run_id = $1`, [body.runId])
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({
    step_id: 'title',
    kind: 'code',
    status: 'done',
    tokens_input: '50',
    tokens_output: '6',
    tokens_cache_read: '10',
    unpriced_calls: 0,
  })
  expect(Number(rows[0].cost)).toBeCloseTo(0.0007, 6)

  // ... and the record lands in Argo through the outbox
  await until(
    async () =>
      (await t.pool.query(`select post_hooks_at from "${t.schema}".runs where id = $1`, [body.runId])).rows[0]
        .post_hooks_at,
    'run record',
  )
  await t.platform?.outbox?.flush()
  const stored = [...t.argo.stored.values()].filter((r) => r.source_id.startsWith(`${body.runId}:title`))
  expect(stored).toHaveLength(1)
  expect(stored[0]).toMatchObject({
    sub_tool: 'smoke.ping',
    machine: 'test-machine',
    input_tokens: 40,
    output_tokens: 6,
    cache_read_tokens: 10,
  })
})

test('a given text is what gets titled; an empty one is a 400', async () => {
  const sent = await t.json(
    await t.call('/workflows/smoke/ping', { body: { text: 'Quarterly numbers' }, headers: { prefer: 'wait=20' } }),
  )
  expect(sent.status).toBe(200)
  expect(JSON.stringify(t.iu.requests.at(-1)?.body)).toContain('Quarterly numbers')
  expect((await t.call('/workflows/smoke/ping', { body: { text: '' } })).status).toBe(400)
})

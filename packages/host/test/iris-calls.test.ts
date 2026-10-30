import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { messageResponse } from '@agent-workflows/capabilities/testing'
import { RUN_ID_HEADER } from '../src/capability-runs.ts'
import { type Body, startTestHost, type TestHost, until } from './support.ts'

// How iris calls the host: `POST /triage` and `POST /decide` with the platform bearer and `x-agw-purpose: iris`. The
// purpose is the host's only per-call attribution; it lands on the run, in its span and in the Argo row's `raw`.
const SUMMARY = { headline: 'Deploy geprüft', detail: 'Der Deploy ist grün.', spoken: 'Der Deploy ist grün.' }
const TRIAGE = { destination: 'terminal: agent-gateway', transcript: 'Bitte den Deploy prüfen.', reply: 'Grün.' }
const DECIDE = {
  state: 'Bitte den Deploy prüfen.',
  questions: { destination: { type: 'choice', instructions: 'Where?', options: { a: 'first', b: 'second' } } },
}
const IRIS = { 'x-agw-purpose': 'iris' }

let t: TestHost
beforeAll(async () => {
  t = await startTestHost({ prefix: 'iris', platform: true })
})
afterAll(async () => {
  await t.close()
})

const runRow = async (id: string) =>
  (await t.pool.query(`select * from "${t.schema}".runs where id = $1`, [id])).rows[0]

const recorded = (runId: string) =>
  until(async () => {
    const row = await runRow(runId)
    return row?.post_hooks_at ? row : null
  }, 'run record')

describe('a call that identifies as iris', () => {
  test('triage answers the summary with usage and cost, and the run and its Argo row carry purpose iris', async () => {
    t.iu.on('messages', () =>
      messageResponse(JSON.stringify(SUMMARY), { input_tokens: 100, output_tokens: 20, cost: 0.0004 }),
    )
    const response = await t.call('/triage', { body: TRIAGE, headers: IRIS })
    expect(response.status).toBe(200)
    expect((await response.json()) as Body).toMatchObject({
      ...SUMMARY,
      attempts: 1,
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, costUsd: 0.0004 },
    })

    const runId = response.headers.get(RUN_ID_HEADER) as string
    expect(await recorded(runId)).toMatchObject({ workflow: 'cap.triage', status: 'done', purpose: 'iris' })
    await t.platform?.outbox?.flush()
    const rows = [...t.usage.stored.values()].filter((r) => r.source_id.startsWith(`${runId}:call:`))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      lane_detail: { workflow: 'cap.triage' },
      cost_reported_usd: 0.0004,
      raw: { purpose: 'iris' },
    })
  })

  test('decide answers with usage and cost, and the run carries purpose iris', async () => {
    t.iu.on('decide', () =>
      Response.json({
        model: 'fake-decider',
        answers: { destination: { type: 'choice', choice: 'a', confidence: 0.9, probabilities: { a: 0.9, b: 0.1 } } },
        usage: { input_tokens: 100, output_tokens: 10 },
      }),
    )
    const response = await t.call('/decide', { body: DECIDE, headers: IRIS })
    expect(response.status).toBe(200)
    const body = (await response.json()) as Body
    expect(body.answers.destination).toMatchObject({ choice: 'a', confidence: 0.9 })
    expect(body.usage).toMatchObject({ inputTokens: 100, outputTokens: 10, totalTokens: 110 })
    expect(body.usage.costUsd).toBeGreaterThan(0)
    const runId = response.headers.get(RUN_ID_HEADER) as string
    expect(await recorded(runId)).toMatchObject({ workflow: 'cap.decide', status: 'done', purpose: 'iris' })
  })

  test('without the header a call is purpose prod, not iris', async () => {
    t.iu.on('messages', () => messageResponse(JSON.stringify(SUMMARY), { input_tokens: 1, output_tokens: 1 }))
    const response = await t.call('/triage', { body: TRIAGE })
    expect((await recorded(response.headers.get(RUN_ID_HEADER) as string)).purpose).toBe('prod')
  })
})

describe('the run cancel of a call held by a slow provider', () => {
  test.each([
    ['triage', 'messages', TRIAGE],
    ['decide', 'decide', DECIDE],
  ] as const)(
    '%s: POST /runs/{runId}/cancel ends the call and the held request answers CANCELLED',
    async (path, wire, body) => {
      const arrived = Promise.withResolvers<void>()
      t.iu.on(wire, () => {
        arrived.resolve()
        return new Promise<Response>(() => {})
      })
      const pending = t.call(`/${path}`, { body, headers: IRIS })
      await arrived.promise
      const running = await until(async () => {
        const { rows } = await t.pool.query(
          `select id from "${t.schema}".runs where workflow = $1 and status = 'running'`,
          [`cap.${path}`],
        )
        return rows[0] ?? null
      }, 'running run')

      const cancel = await t.json(await t.call(`/runs/${running.id}/cancel`, { method: 'POST' }))
      expect(cancel.status).toBe(200)
      expect(cancel.body).toMatchObject({ status: 'cancelled' })

      const answered = await pending
      expect(answered.status).toBe(499)
      expect(((await answered.json()) as Body).code).toBe('CANCELLED')
      expect((await runRow(running.id)).status).toBe('cancelled')
    },
  )
})

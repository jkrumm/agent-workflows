import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { fakeTransports } from '@agent-workflows/testing/transports'
import { resolveRoute, type RouteId, routeIds } from '@agent-workflows/routes'
import { FakeAgentHost } from '@agent-workflows/testing/agent-host'
import { AGENT_PROMPT, COMPLETE_PROMPT, createSmokeRoute, SMOKE_AGENT } from '../src/workflows/smoke/route.ts'
import { freshSchema, testRuntime } from '../../runtime/test/support/pg.ts'
import { startTestHost, type TestHost } from './support.ts'

const routes = routeIds().map((id) => resolveRoute(id, {}))
const first = (match: (r: (typeof routes)[number]) => boolean) => {
  const route = routes.find(match)
  if (!route) throw new Error('no route in the table matches')
  return route
}
const openai = first((r) => r.wire === 'iu-openai' && r.price === undefined && r.rate !== undefined)
const agent = first((r) => r.wire === 'opencode')

const transports = fakeTransports({
  openai: [{ text: 'hello', tokens: { input: 20, output: 4, cacheRead: 0, reasoning: 0 }, cost: null }],
})

describe('smoke.route over HTTP', () => {
  let t: TestHost
  beforeAll(async () => {
    t = await startTestHost({ prefix: 'smokeroute', extra: [createSmokeRoute({ transports })] })
  })
  afterAll(async () => {
    await t.close()
  })
  const run = async (route: string) =>
    t.json(await t.call('/workflows/smoke/route', { body: { route }, headers: { prefer: 'wait=20' } }))

  test('the prompt is fixed at eight words', () => {
    expect(COMPLETE_PROMPT.split(' ')).toHaveLength(8)
  })

  test('a single-call route gets one completion on its own wire and model, priced by its rate', async () => {
    const { status, body } = await run(openai.id)
    expect(status).toBe(200)
    expect(body).toMatchObject({
      status: 'done',
      output: { route: openai.id, model: openai.model, wire: 'iu-openai', text: 'hello' },
    })
    const [call] = transports.chatCalls.filter((c) => c.wire === 'openai')
    expect(call?.request).toMatchObject({ model: openai.model, prompt: COMPLETE_PROMPT })
    expect(call?.request.attribution).toMatchObject({ workflow: 'smoke.route', step: 'complete' })
    const { rows } = await t.pool.query(`select * from "${t.schema}".steps where run_id = $1`, [body.runId])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ step_id: 'complete', status: 'done', tokens_input: '20', unpriced_calls: 0 })
    expect(Number(rows[0].cost)).toBeGreaterThan(0)
  })

  test('empty text, a truncated answer and a refusal fail the run, with one transport call each', async () => {
    const tokens = { input: 20, output: 4, cacheRead: 0, reasoning: 0 }
    for (const reply of [
      { text: '   ' },
      { text: 'half a sent', stop: 'length' as const },
      { text: 'no', stop: 'other' as const, stopDetail: 'refusal' },
    ]) {
      const bad = fakeTransports({ openai: [{ ...reply, tokens, cost: null }] })
      const host = await startTestHost({ prefix: 'smokeroutebad', extra: [createSmokeRoute({ transports: bad })] })
      try {
        const res = host.json(
          await host.call('/workflows/smoke/route', {
            body: { route: openai.id },
            headers: { prefer: 'wait=20' },
          }),
        )
        const { body } = await res
        expect(body).toMatchObject({ status: 'failed' })
        expect(bad.chatCalls).toHaveLength(1)
      } finally {
        await host.close()
      }
    }
  })

  test('unknown routes and media routes are a 400 that names where they are covered', async () => {
    const unknown = await run('no.such.route')
    expect(unknown.status).toBe(400)
    const calls = transports.chatCalls.length
    const media = routes.filter(
      (r) => r.wire === 'iu-gemini' || r.wire === 'iu-replicate' || r.wire === 'iu-decision' || r.price !== undefined,
    )
    expect(media.length).toBeGreaterThan(0)
    for (const route of [...new Map(media.map((r) => [r.wire + (r.price ? 'p' : ''), r])).values()]) {
      const refused = await run(route.id)
      expect(refused.status).toBe(400)
      expect(JSON.stringify(refused.body)).toContain('make verify')
    }
    expect(transports.chatCalls).toHaveLength(calls)
  })
})

describe('smoke.route on an agent route', () => {
  const db = freshSchema('smokeroute_agent')
  afterAll(() => db.drop())

  test('one agent step with the fixed prompt, on the named route and the smoke agent', async () => {
    const host = new FakeAgentHost(async () => ({ output: 'ok' }))
    const entry = createSmokeRoute({ transports })
    const rt = testRuntime({ schema: db.schema, workflows: [entry.workflow], host })
    await rt.open()
    try {
      const { runId } = await rt.start(entry.workflow, { route: agent.id as RouteId }, { purpose: 'verify' })
      expect(await rt.wait(runId)).toMatchObject({
        status: 'done',
        output: { route: agent.id, model: agent.model, wire: 'opencode', text: 'ok' },
      })
      const [session] = [...host.sessions.values()]
      expect(host.count('open')).toBe(1)
      expect(session?.spec).toMatchObject({
        agent: SMOKE_AGENT,
        prompt: AGENT_PROMPT,
        options: { output: 'text', route: agent.id },
      })
    } finally {
      await rt.close()
    }
  })
})

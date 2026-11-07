import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { messageResponse, startFakeGateway } from '@agent-workflows/testing/gateway'
import { createFactorySteward } from '../src/workflows/factory-steward/index.ts'
import stewardModule from '../src/workflows/factory-steward/module.ts'
import fixture from './fixtures/software-factory-loops.json'
import { type Body, startTestHost, type TestHost } from './support.ts'

const stall = fixture.steward.input
const wake = fixture.steward.output
const tokens = { input_tokens: 900, output_tokens: 80 }

const promptOf = (request: { body: Record<string, unknown> } | undefined) =>
  String(((request?.body.messages ?? []) as Body[])[0]?.content)

let t: TestHost
let broken: Error | null = null
beforeAll(async () => {
  const iu = startFakeGateway({ messages: () => messageResponse(JSON.stringify(wake), tokens) })
  t = await startTestHost({
    prefix: 'factorysteward',
    iu,
    extra: [
      createFactorySteward({
        registry: {
          call: (...args: unknown[]) =>
            broken ? Promise.reject(broken) : Reflect.apply(t.registry.call, t.registry, args),
        } as never,
      }),
    ],
  })
})
afterAll(() => t.close())

// A distinct input per run, so no run is adopted from an earlier one.
let n = 0
const run = async (over: Record<string, unknown> = {}) =>
  t.json(
    await t.call('/workflows/factory-steward', {
      method: 'POST',
      body: { stall: { ...stall, title: `${stall.title} ${n++}`, ...over } },
      headers: { prefer: 'wait=20' },
    }),
  )
const answers = (answer: unknown) => t.iu.on('messages', () => messageResponse(JSON.stringify(answer), tokens))

describe('factory-steward workflow', () => {
  test('the module is registered under the workflow id', () => {
    expect(stewardModule.id).toBe('factory-steward')
  })

  test('one run, one call: the fixture answer passes through and the step scope reached the wire', async () => {
    const { status, body } = await run()
    expect(status).toBe(200)
    expect(body.status).toBe('done')
    expect(body.output).toEqual(wake)
    const sent = t.iu.requests.filter((r) =>
      String((r.body.messages as Body[])[0]?.content).includes('staging database'),
    )
    expect(sent).toHaveLength(1)
    expect(Object.fromEntries(sent[0]?.headers ?? [])).toMatchObject({
      'x-agw-run-id': body.runId,
      'x-agw-workflow': 'factory-steward',
      'x-agw-step': 'steward',
    })
    const prompt = promptOf(sent[0])
    expect(prompt).toContain('Cause: blocked')
    expect(prompt).toContain('the staging database is back')
  })

  test('the CLI reads the stall JSON from stdin as the one `stall` property', async () => {
    const doc = (await (await t.call('/openapi.json')).json()) as {
      paths: Record<string, Record<string, { 'x-cli': { command: string[]; stdin?: string } }>>
    }
    expect(doc.paths['/workflows/factory-steward']?.post?.['x-cli']).toMatchObject({
      command: ['factory-steward'],
      stdin: 'stall',
    })
  })

  test('a Decision passes through when its form is complete', async () => {
    answers(fixture.steward.decisionOutput)
    const { body } = await run()
    expect(body.output).toEqual(fixture.steward.decisionOutput)
    answers(wake)
  })

  test('a malformed stall is a 400, nothing runs', async () => {
    const response = await t.call('/workflows/factory-steward', {
      method: 'POST',
      body: { stall: { ...stall, cause: 'asleep' } },
    })
    expect(response.status).toBe(400)
  })
})

describe('the guard', () => {
  test('requeue ends only a lead_gone stall', async () => {
    answers({ ...wake, action: 'requeue' })
    const { body } = await run()
    expect(body.output).toMatchObject({ action: 'none', decision: null })
    expect(body.output.reason).toContain('requeue ends only a lead_gone stall')
    answers(wake)
  })

  test('a lead_gone stall is not woken', async () => {
    const { body } = await run({ cause: 'lead_gone' })
    expect(body.output).toMatchObject({ action: 'none' })
    expect(body.output.reason).toContain('lead_gone')
  })

  test('a Decision whose default is not reversible is refused', async () => {
    const bad = structuredClone(fixture.steward.decisionOutput)
    bad.decision.options[0] = { label: 'wait', reversible: false, cost: 'for good' }
    answers(bad)
    const { body } = await run()
    expect(body.output).toMatchObject({ action: 'none' })
    expect(body.output.reason).toContain('reversible')
    answers(wake)
  })

  test('a Decision whose recommendation is not an option is refused', async () => {
    answers({
      ...fixture.steward.decisionOutput,
      decision: { ...fixture.steward.decisionOutput.decision, recommendation: 'sleep' },
    })
    const { body } = await run()
    expect(body.output).toMatchObject({ action: 'none' })
    answers(wake)
  })
})

describe('fail closed', () => {
  test('a registry that throws says none, the run is done', async () => {
    broken = new Error('gateway exploded sk-secret-token')
    try {
      const { status, body } = await run()
      expect(status).toBe(200)
      expect(body.status).toBe('done')
      expect(body.output).toMatchObject({ action: 'none', note: '', decision: null })
      expect(body.output.reason).toStartWith('steward unavailable: ')
      expect(JSON.stringify(body.output)).not.toContain('sk-secret-token')
    } finally {
      broken = null
    }
  })
})

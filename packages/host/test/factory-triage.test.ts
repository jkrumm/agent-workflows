import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { messageResponse, startFakeGateway } from '@agent-workflows/testing/gateway'
import { createFactoryTriage } from '../src/workflows/factory-triage/index.ts'
import triageModule from '../src/workflows/factory-triage/module.ts'
import fixture from './fixtures/software-factory-loops.json'
import { type Body, startTestHost, type TestHost } from './support.ts'

const { amendInput, amendOutput, settleInput, settleOutput } = fixture.triage
const tokens = { input_tokens: 700, output_tokens: 60 }

const promptOf = (request: { body: Record<string, unknown> } | undefined) =>
  String(((request?.body.messages ?? []) as Body[])[0]?.content)

let t: TestHost
let broken: Error | null = null
beforeAll(async () => {
  const iu = startFakeGateway({ messages: () => messageResponse(JSON.stringify(amendOutput), tokens) })
  t = await startTestHost({
    prefix: 'factorytriage',
    iu,
    extra: [
      createFactoryTriage({
        registry: {
          call: (...args: unknown[]) =>
            broken ? Promise.reject(broken) : Reflect.apply(t.registry.call, t.registry, args),
        } as never,
      }),
    ],
  })
})
afterAll(() => t.close())

let n = 0
const run = async (request: Record<string, unknown>) => {
  const subject = request.mode === 'amend' ? 'signal' : 'issue'
  const own = request[subject] as Record<string, unknown>
  return t.json(
    await t.call('/workflows/factory-triage', {
      method: 'POST',
      body: { request: { ...request, [subject]: { ...own, title: `${String(own.title)} ${n++}` } } },
      headers: { prefer: 'wait=20' },
    }),
  )
}
const answers = (answer: unknown) => t.iu.on('messages', () => messageResponse(JSON.stringify(answer), tokens))
const none = { amend: null, after: [], kind: null, size: null }

describe('factory-triage workflow', () => {
  test('the module is registered under the workflow id', () => {
    expect(triageModule.id).toBe('factory-triage')
  })

  test('amend: the fixture answer passes through, and the prompt lists the open Issues', async () => {
    const { status, body } = await run(amendInput)
    expect(status).toBe(200)
    expect(body.output).toEqual(amendOutput)
    const sent = t.iu.requests.filter((r) =>
      String((r.body.messages as Body[])[0]?.content).includes('still wrong for coupons'),
    )
    const prompt = promptOf(sent.at(-1))
    expect(prompt).toContain('Mode: amend')
    expect(prompt).toContain('issue_15 [feature, queued]: Add a dark theme')
    expect(Object.fromEntries(sent.at(-1)?.headers ?? [])).toMatchObject({
      'x-agw-workflow': 'factory-triage',
      'x-agw-step': 'triage',
    })
  })

  test('settle: the fixture answer passes through', async () => {
    answers(settleOutput)
    const { body } = await run(settleInput)
    expect(body.output).toEqual(settleOutput)
    answers(amendOutput)
  })

  test('the CLI reads the request JSON from stdin as the one `request` property', async () => {
    const doc = (await (await t.call('/openapi.json')).json()) as {
      paths: Record<string, Record<string, { 'x-cli': { command: string[]; stdin?: string } }>>
    }
    expect(doc.paths['/workflows/factory-triage']?.post?.['x-cli']).toMatchObject({
      command: ['factory-triage'],
      stdin: 'request',
    })
  })

  test('a request without a mode is a 400', async () => {
    const { mode: _mode, ...rest } = amendInput
    const response = await t.call('/workflows/factory-triage', { method: 'POST', body: { request: rest } })
    expect(response.status).toBe(400)
  })
})

describe('the guard: only Issues the request showed', () => {
  test('amend: an Issue that was not shown is the empty answer', async () => {
    answers({ ...amendOutput, amend: 'issue_999' })
    const { body } = await run(amendInput)
    expect(body.output).toMatchObject(none)
    expect(body.output.reason).toContain('not one of those shown')
    answers(amendOutput)
  })

  test('settle: an edge to an Issue that was not shown is the empty answer', async () => {
    answers({ ...settleOutput, after: ['issue_12', 'issue_999'] })
    const { body } = await run(settleInput)
    expect(body.output).toMatchObject(none)
    answers(amendOutput)
  })

  test('settle: an Issue is not after itself, and no edge twice', async () => {
    answers({ ...settleOutput, after: ['issue_20'] })
    expect((await run(settleInput)).body.output).toMatchObject(none)
    answers({ ...settleOutput, after: ['issue_12', 'issue_12'] })
    expect((await run(settleInput)).body.output).toMatchObject(none)
    answers(amendOutput)
  })

  test('the field of the other mode is refused', async () => {
    answers({ ...settleOutput, after: ['issue_12'], amend: null })
    expect((await run(amendInput)).body.output).toMatchObject(none)
    answers({ ...amendOutput })
    expect((await run(settleInput)).body.output).toMatchObject(none)
    answers(amendOutput)
  })
})

describe('fail closed', () => {
  test('a registry that throws gives the empty answer, the run is done', async () => {
    broken = new Error('gateway exploded sk-secret-token')
    try {
      const { status, body } = await run(settleInput)
      expect(status).toBe(200)
      expect(body.status).toBe('done')
      expect(body.output).toMatchObject(none)
      expect(body.output.reason).toStartWith('triage unavailable: ')
      expect(JSON.stringify(body.output)).not.toContain('sk-secret-token')
    } finally {
      broken = null
    }
  })
})

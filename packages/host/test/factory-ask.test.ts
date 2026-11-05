import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { messageResponse, startFakeGateway } from '@agent-workflows/testing/gateway'
import { createFactoryAsk } from '../src/workflows/factory-ask/index.ts'
import askModule from '../src/workflows/factory-ask/module.ts'
import { type Body, startTestHost, type TestHost } from './support.ts'

const ask = {
  question: 'Which command runs the checks?',
  options: ['make check', 'bun test'],
  default: 'make check',
  facts: 'A Bun monorepo.',
  plan: 'AGENTS.md: `make check` is the gate.',
  repo: 'agent-workflows',
}
const answer = {
  verdict: 'answer',
  answer: 'make check',
  reason: 'the plan names it',
  source: 'plan: AGENTS.md, make check is the gate',
}
const owner = { verdict: 'owner', answer: '', source: '', reason: 'spend' }
const tokens = { input_tokens: 900, output_tokens: 60 }

let t: TestHost
let broken: Error | null = null
beforeAll(async () => {
  const iu = startFakeGateway({ messages: () => messageResponse(JSON.stringify(answer), tokens) })
  t = await startTestHost({
    prefix: 'factoryask',
    iu,
    extra: [
      createFactoryAsk({
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
    await t.call('/workflows/factory-ask', {
      method: 'POST',
      body: { ask: { ...ask, facts: `${ask.facts} ${n++}`, ...over } },
      headers: { prefer: 'wait=20' },
    }),
  )

describe('factory-ask workflow', () => {
  test('the module is registered under the workflow id', () => {
    expect(askModule.id).toBe('factory-ask')
  })

  test('one run, one call: the verdict passes through and the step scope reached the wire', async () => {
    const { status, body } = await run()
    expect(status).toBe(200)
    expect(body.status).toBe('done')
    expect(body.output).toEqual(answer)
    const sent = t.iu.requests.filter((r) => String((r.body.messages as Body[])[0]?.content).includes('Bun monorepo'))
    expect(sent).toHaveLength(1)
    expect(Object.fromEntries(sent[0]?.headers ?? [])).toMatchObject({
      'x-agw-run-id': body.runId,
      'x-agw-workflow': 'factory-ask',
      'x-agw-step': 'judge',
    })
  })

  test('the CLI reads the ask JSON from stdin as the one `ask` property', async () => {
    const doc = (await (await t.call('/openapi.json')).json()) as {
      paths: Record<string, Record<string, { 'x-cli': { command: string[]; stdin?: string } }>>
    }
    expect(doc.paths['/workflows/factory-ask']?.post?.['x-cli']).toMatchObject({
      command: ['factory-ask'],
      stdin: 'ask',
    })
  })

  test('a malformed ask is a 400, nothing runs', async () => {
    const response = await t.call('/workflows/factory-ask', {
      method: 'POST',
      body: { ask: { ...ask, options: 'make check' } },
    })
    expect(response.status).toBe(400)
  })

  test('an owner verdict passes through', async () => {
    t.iu.on('messages', () => messageResponse(JSON.stringify(owner), tokens))
    expect((await run()).body.output).toEqual(owner)
    t.iu.on('messages', () => messageResponse(JSON.stringify(answer), tokens))
  })

  test('a model answer outside the options never leaves the workflow as an answer', async () => {
    t.iu.on('messages', () => messageResponse(JSON.stringify({ ...answer, answer: 'make test' }), tokens))
    const { body } = await run()
    expect(body.status).toBe('done')
    expect(body.output).toMatchObject({ verdict: 'owner', answer: '', source: '' })
    expect(body.output.reason).toStartWith('judge unavailable: ')
    t.iu.on('messages', () => messageResponse(JSON.stringify(answer), tokens))
  })
})

describe('fail closed', () => {
  test('a registry that throws leaves the ask with the owner, the run is done', async () => {
    broken = new Error('gateway exploded sk-secret-token')
    try {
      const { status, body } = await run()
      expect(status).toBe(200)
      expect(body.status).toBe('done')
      expect(body.output).toEqual({
        verdict: 'owner',
        answer: '',
        source: '',
        reason: expect.stringMatching(/^judge unavailable: [^\n]{1,200}$/),
      })
      expect(JSON.stringify(body.output)).not.toContain('sk-secret-token')
    } finally {
      broken = null
    }
  })
})

import fixture from './fixtures/software-factory-loops.json'
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

const promptOf = (request: { body: Record<string, unknown> } | undefined) =>
  String(((request?.body.messages ?? []) as Body[])[0]?.content)

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

describe('the Decision shape (software-factory JudgeInput)', () => {
  const decision = fixture.judge.input
  const runDecision = async (over: Record<string, unknown> = {}) =>
    t.json(
      await t.call('/workflows/factory-ask', {
        method: 'POST',
        body: { ask: { ...decision, issue: `${decision.issue} ${n++}`, ...over } },
        headers: { prefer: 'wait=20' },
      }),
    )

  test('the fixture verdict passes through, and the prompt carries the form and the precedent', async () => {
    t.iu.on('messages', () => messageResponse(JSON.stringify(fixture.judge.output), tokens))
    const { status, body } = await runDecision()
    expect(status).toBe(200)
    expect(body.output).toEqual(fixture.judge.output)
    const sent = t.iu.requests.filter((r) => String((r.body.messages as Body[])[0]?.content).includes('access log'))
    const prompt = promptOf(sent.at(-1))
    expect(prompt).toContain('can be taken back')
    expect(prompt).toContain('Which logging library for the worker?')
    expect(prompt).toContain('need not have been asked')
    t.iu.on('messages', () => messageResponse(JSON.stringify(answer), tokens))
  })

  test("an answer outside the labels is the owner's", async () => {
    t.iu.on('messages', () => messageResponse(JSON.stringify({ ...fixture.judge.output, answer: 'bunyan' }), tokens))
    expect((await runDecision()).body.output).toMatchObject({ verdict: 'owner', answer: '', source: '' })
    t.iu.on('messages', () => messageResponse(JSON.stringify(answer), tokens))
  })

  test('an option that cannot be taken back is never the answer', async () => {
    const options = [
      { label: 'pino', reversible: false, cost: 'rewrites the log format for good' },
      { label: 'winston', reversible: true, cost: 'one dependency' },
    ]
    t.iu.on('messages', () => messageResponse(JSON.stringify(fixture.judge.output), tokens))
    const { body } = await runDecision({ options })
    expect(body.output).toMatchObject({ verdict: 'owner', answer: '', source: '' })
    expect(body.output.reason).toContain('cannot be taken back')
    t.iu.on('messages', () => messageResponse(JSON.stringify(answer), tokens))
  })

  test('a Decision whose assembled facts pass the cap is refused, not cut: the owner’s', async () => {
    t.iu.on('messages', () => messageResponse(JSON.stringify(fixture.judge.output), tokens))
    const before = t.iu.requests.length
    const { status, body } = await runDecision({
      checked: 'c'.repeat(19_000),
      options: [
        { label: 'pino', reversible: true, cost: 'x'.repeat(900) },
        { label: 'winston', reversible: true, cost: 'y'.repeat(900) },
      ],
    })
    expect(status).toBe(200)
    expect(body.output).toMatchObject({ verdict: 'owner', answer: '', source: '' })
    expect(body.output.reason).toStartWith('judge unavailable: ')
    // nothing went to the model: the Judge never saw a prefix
    expect(t.iu.requests.length).toBe(before)
    t.iu.on('messages', () => messageResponse(JSON.stringify(answer), tokens))
  })

  test('two options with one label, one of them irreversible, are never the Judge’s', async () => {
    const options = [
      { label: 'pino', reversible: true, cost: 'one dependency' },
      { label: 'pino', reversible: false, cost: 'rewrites the format for good' },
    ]
    t.iu.on('messages', () => messageResponse(JSON.stringify(fixture.judge.output), tokens))
    const { body } = await runDecision({ options })
    expect(body.output).toMatchObject({ verdict: 'owner', answer: '', source: '' })
    t.iu.on('messages', () => messageResponse(JSON.stringify(answer), tokens))
  })

  test('a Decision that is missing a field is a 400', async () => {
    const { recommendation: _drop, ...rest } = decision
    const response = await t.call('/workflows/factory-ask', { method: 'POST', body: { ask: rest } })
    expect(response.status).toBe(400)
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

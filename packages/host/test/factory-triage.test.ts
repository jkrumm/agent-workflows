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
const none = { amend: null, settled: null, after: [], kind: null, size: null }

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

// The two real cases (software-factory Issues 319/316 and 392/329). The fake gateway returns what a correct model
// answers; the test pins the prompt sections, the instruction wording and that the guard lets the answer through.
const ciRedInput = {
  mode: 'amend',
  repo: 'example-app',
  signal: {
    title: 'CI is red on master again',
    text: 'Please get the pipeline green; the build job fails on every push.',
    source: 'owner:hermes',
    kind: 'request',
    origin: 'you',
  },
  candidates: [
    { id: 'issue_316', title: 'Fix the failing build job in the pipeline', kind: 'bug', state: 'working' },
    { id: 'issue_330', title: 'Add a dark theme', kind: 'feature', state: 'queued' },
  ],
}
const diskInput = {
  mode: 'amend',
  repo: 'example-app',
  signal: {
    title: 'Disk filling fast on the mini',
    text: 'Alert: the data volume is at 91% and growing.',
    source: 'monitor:disk',
    kind: 'alert',
    origin: 'monitor',
  },
  candidates: [{ id: 'issue_330', title: 'Add a dark theme', kind: 'feature', state: 'queued' }],
  settled: [
    {
      id: 'issue_329',
      title: 'Disk filling fast on the mini',
      outcome: 'dropped',
      reason: 'false alarm: a one-off cache rebuild, the volume recovered by itself',
    },
    { id: 'issue_327', title: 'Rotate the host logs', outcome: 'done', reason: null },
  ],
}
const quiet = { after: [], kind: null, size: null }

describe('amend: restated open Issue and settled closed Issue', () => {
  test('a request restating an open Issue in other words is amended into it', async () => {
    answers({ ...quiet, amend: 'issue_316', settled: null, reason: 'the same red build, said differently' })
    const { body } = await run(ciRedInput)
    expect(body.output).toMatchObject({ amend: 'issue_316', settled: null })
    const prompt = promptOf(t.iu.requests.at(-1))
    expect(prompt).toContain('even with little title overlap')
    expect(prompt).not.toContain('Recently closed:')
    answers(amendOutput)
  })

  test('an alert for a subject closed as a false alarm is settled', async () => {
    answers({ ...quiet, amend: null, settled: 'issue_329', reason: 'closed 6h ago as a false alarm' })
    const { body } = await run(diskInput)
    expect(body.output).toMatchObject({ amend: null, settled: 'issue_329' })
    const prompt = promptOf(t.iu.requests.at(-1))
    const [open, closed] = prompt.split('Recently closed:')
    expect(open).toContain('issue_330 [feature, queued]')
    expect(open).not.toContain('issue_329')
    expect(closed).toContain('issue_329 [dropped]: Disk filling fast on the mini | reason: false alarm')
    expect(closed).toContain('issue_327 [done]: Rotate the host logs | reason: (none)')
    expect(prompt).toContain('A regression, a new symptom or a changed fact is NOT settled')
    answers(amendOutput)
  })

  test('a request without settled is read as none (an older caller)', async () => {
    const { settled: _settled, ...older } = diskInput
    answers({ ...quiet, amend: null, settled: null, reason: 'new' })
    const { status, body } = await run(older)
    expect(status).toBe(200)
    expect(body.output).toMatchObject({ amend: null, settled: null })
    expect(promptOf(t.iu.requests.at(-1))).not.toContain('Recently closed:')
    answers(amendOutput)
  })

  test('an answer that omits settled is read as null', async () => {
    answers({ amend: 'issue_12', ...quiet, reason: 'same bug' })
    expect((await run(amendInput)).body.output).toMatchObject({ amend: 'issue_12', settled: null })
    answers(amendOutput)
  })
})

describe('the guard: settled', () => {
  test('a settled Issue that was not shown is the empty answer', async () => {
    answers({ ...quiet, amend: null, settled: 'issue_999', reason: 'x' })
    const { body } = await run(diskInput)
    expect(body.output).toMatchObject({ amend: null, settled: null })
    expect(body.output.reason).toContain('settled Issue was not one of those shown')
    answers(amendOutput)
  })

  test('an open Issue is not a settled Issue', async () => {
    answers({ ...quiet, amend: null, settled: 'issue_330', reason: 'x' })
    expect((await run(diskInput)).body.output).toMatchObject({ settled: null })
    answers(amendOutput)
  })

  test('amend and settled are never both set', async () => {
    answers({ ...quiet, amend: 'issue_330', settled: 'issue_329', reason: 'x' })
    const { body } = await run(diskInput)
    expect(body.output).toMatchObject({ amend: null, settled: null })
    expect(body.output.reason).toContain('not both')
    answers(amendOutput)
  })

  test('settle mode answers settled null', async () => {
    answers({ ...settleOutput, settled: 'issue_12' })
    const { body } = await run(settleInput)
    expect(body.output).toMatchObject(none)
    expect(body.output.reason).toContain('settles nothing')
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

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { factoryQueueInput, guardQueue } from '@agent-workflows/capabilities'
import { messageResponse, startFakeGateway } from '@agent-workflows/testing/gateway'
import { createFactoryQueue } from '../src/workflows/factory-queue/index.ts'
import queueModule from '../src/workflows/factory-queue/module.ts'
import fixture from './fixtures/software-factory-loops.json'
import { type Body, startTestHost, type TestHost } from './support.ts'

const input = factoryQueueInput.parse(fixture.queue.input)
const { output } = fixture.queue
const tokens = { input_tokens: 900, output_tokens: 80 }
const none = { edges: [], order: [] }

const promptOf = (request: { body: Record<string, unknown> } | undefined) =>
  String(((request?.body.messages ?? []) as Body[])[0]?.content)

let t: TestHost
let broken: Error | null = null
beforeAll(async () => {
  const iu = startFakeGateway({ messages: () => messageResponse(JSON.stringify(output), tokens) })
  t = await startTestHost({
    prefix: 'factoryqueue',
    iu,
    extra: [
      createFactoryQueue({
        registry: {
          call: (...args: unknown[]) =>
            broken ? Promise.reject(broken) : Reflect.apply(t.registry.call, t.registry, args),
        } as never,
      }),
    ],
  })
})
afterAll(() => t.close())

// A distinct title per run, so no run is adopted from an earlier one.
let n = 0
const run = async () =>
  t.json(
    await t.call('/workflows/factory-queue', {
      method: 'POST',
      body: {
        queue: {
          ...input,
          issues: input.issues.map((i) => (i.id === 'issue_15' ? { ...i, title: `${i.title} ${n++}` } : i)),
        },
      },
      headers: { prefer: 'wait=20' },
    }),
  )
const answers = (answer: unknown) => t.iu.on('messages', () => messageResponse(JSON.stringify(answer), tokens))

describe('factory-queue workflow', () => {
  test('the module is registered under the workflow id', () => {
    expect(queueModule.id).toBe('factory-queue')
  })

  test('the fixture answer passes through, the prompt lists the Issues, the step scope reached the wire', async () => {
    const { status, body } = await run()
    expect(status).toBe(200)
    expect(body.status).toBe('done')
    expect(body.output).toEqual(output)
    const sent = t.iu.requests.filter((r) => promptOf(r).includes('Rework the checkout page layout'))
    const prompt = promptOf(sent.at(-1))
    expect(prompt).toContain('issue_22 [feature, queued, prio 50')
    expect(prompt).toContain('waits for: issue_12')
    expect(Object.fromEntries(sent.at(-1)?.headers ?? [])).toMatchObject({
      'x-agw-workflow': 'factory-queue',
      'x-agw-step': 'queue',
    })
  })

  test('the CLI reads the queue JSON from stdin as the one `queue` property', async () => {
    const doc = (await (await t.call('/openapi.json')).json()) as {
      paths: Record<string, Record<string, { 'x-cli': { command: string[]; stdin?: string } }>>
    }
    expect(doc.paths['/workflows/factory-queue']?.post?.['x-cli']).toMatchObject({
      command: ['factory-queue'],
      stdin: 'queue',
    })
  })

  test('an empty queue is a 400', async () => {
    const response = await t.call('/workflows/factory-queue', {
      method: 'POST',
      body: { queue: { repo: 'example-app', issues: [] } },
    })
    expect(response.status).toBe(400)
  })
})

describe('the guard through the workflow', () => {
  test.each([
    [
      'an edge to an Issue that was not shown',
      { ...output, edges: [{ issue: 'issue_20', after: 'issue_999', reason: 'x' }] },
    ],
    ['an order against the owner priority', { ...output, order: ['issue_15', 'issue_20', 'issue_21', 'issue_22'] }],
  ])('%s is the empty answer', async (_name, answer) => {
    answers(answer)
    try {
      const { body } = await run()
      expect(body.output).toMatchObject(none)
      expect(body.output.reason).toStartWith('guard: ')
    } finally {
      answers(output)
    }
  })
})

describe('guardQueue', () => {
  const guard = (answer: Partial<typeof output>) => guardQueue({ ...output, ...answer }, input)
  const refused = (answer: Partial<typeof output>, why: string) => {
    const result = guard(answer)
    expect(result).toMatchObject(none)
    expect(result.reason).toContain(why)
  }

  test('the fixture answer holds', () => {
    expect(guard({})).toEqual(output)
  })

  test('[] edges and [] order is the common answer', () => {
    expect(guard({ edges: [], order: [] })).toMatchObject({ edges: [], order: [] })
  })

  test('edges: a running Issue cannot wait, nothing waits for itself, twice or again', () => {
    const edge = (issue: string, after: string) => ({ issue, after, reason: 'x' })
    refused({ edges: [edge('issue_12', 'issue_15')] }, 'not queued')
    refused({ edges: [edge('issue_20', 'issue_20')] }, 'itself')
    refused({ edges: [edge('issue_20', 'issue_12'), edge('issue_20', 'issue_12')] }, 'twice')
    refused({ edges: [edge('issue_22', 'issue_12')] }, 'exists already')
  })

  test('edges: at most three for one Issue', () => {
    const blockers = ['issue_12', 'issue_15', 'issue_21', 'issue_22']
    const edges = blockers.map((after) => ({ issue: 'issue_20', after, reason: 'x' }))
    refused({ edges, order: [] }, 'three edges')
    expect(guard({ edges: edges.slice(0, 3), order: [] }).edges).toHaveLength(3)
  })

  test('edges: a cycle through proposed edges is refused', () => {
    const edge = (issue: string, after: string) => ({ issue, after, reason: 'x' })
    refused({ edges: [edge('issue_20', 'issue_21'), edge('issue_21', 'issue_20')], order: [] }, 'cycle')
    refused({ edges: [edge('issue_15', 'issue_22'), edge('issue_12', 'issue_15')] }, 'not queued')
    // issue_22 waits for issue_12 already: issue_12 is running, so only a queued Issue can close a loop through it
    const chained = {
      ...input,
      issues: input.issues.map((i) => (i.id === 'issue_20' ? { ...i, after: ['issue_22'] } : i)),
    }
    const result = guardQueue({ edges: [edge('issue_22', 'issue_20')], order: [], reason: 'x' }, chained)
    expect(result.reason).toContain('cycle')
  })

  test('order: every queued Issue once, none unknown', () => {
    refused({ order: ['issue_22', 'issue_21', 'issue_15'] }, 'once')
    refused({ order: ['issue_22', 'issue_21', 'issue_15', 'issue_15'] }, 'once')
    refused({ order: ['issue_22', 'issue_21', 'issue_15', 'issue_12'] }, 'not queued')
  })

  test('order: a blocker goes before the Issue that waits for it, proposed edges included', () => {
    const edges = [{ issue: 'issue_21', after: 'issue_15', reason: 'x' }]
    expect(guard({ edges, order: ['issue_22', 'issue_15', 'issue_21', 'issue_20'] }).order).toHaveLength(4)
    refused({ edges, order: ['issue_22', 'issue_21', 'issue_15', 'issue_20'] }, 'before one it waits for')
  })

  test('order: only a tie may be broken; a lower prio goes first only for a blocker', () => {
    refused({ order: ['issue_21', 'issue_22', 'issue_15', 'issue_20'] }, 'priority')
    const edges = [{ issue: 'issue_22', after: 'issue_21', reason: 'x' }]
    expect(guard({ edges, order: ['issue_21', 'issue_22', 'issue_15', 'issue_20'] }).order[0]).toBe('issue_21')
  })
})

describe('fail closed', () => {
  test('a registry that throws gives the empty answer, the run is done', async () => {
    broken = new Error('gateway exploded sk-secret-token')
    try {
      const { status, body } = await run()
      expect(status).toBe(200)
      expect(body.status).toBe('done')
      expect(body.output).toMatchObject(none)
      expect(body.output.reason).toStartWith('queue unavailable: ')
      expect(JSON.stringify(body.output)).not.toContain('sk-secret-token')
    } finally {
      broken = null
    }
  })
})

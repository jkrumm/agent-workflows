import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import {
  type Attribution as CapabilityAttribution,
  createCapabilities,
  createRegistry,
  gatewayTransports,
} from '@agent-workflows/capabilities'
import { type FakeGateway, messageResponse, startFakeGateway } from '@agent-workflows/capabilities/testing'
import { z } from 'zod'
import { type Attribution, defineWorkflow, type StepScope } from '../src/index.ts'
import { freshSchema, testRuntime } from './support/pg.ts'

const db = freshSchema('attribution')
const gateway: FakeGateway = startFakeGateway({
  messages: () => messageResponse('A title', { input_tokens: 10, output_tokens: 2 }),
})
beforeEach(() => {
  gateway.requests.length = 0
})
afterAll(async () => {
  gateway.stop()
  await db.drop()
})

const registry = () =>
  createRegistry(
    createCapabilities({
      transports: gatewayTransports({ env: { AGW_API_SECRET: 'agw-token', AGW_GATEWAY_URL: gateway.url } }),
      env: {},
    }),
  )

/** Compile-time: the runtime's step scope is a capability call's options, attribution included. */
const _scopeIsCallOptions = (scope: StepScope): Parameters<ReturnType<typeof registry>['call']>[2] => scope
const _sameShape = (a: Attribution): CapabilityAttribution => a

const TRACEPARENT = '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01'
const headers = (index: number) => Object.fromEntries(gateway.requests[index]?.headers ?? [])

describe('a step scope passed to a capability reaches the gateway as attribution', () => {
  const r = registry()
  const child = defineWorkflow({
    id: 'attr.child',
    version: 'v1',
    input: z.object({ text: z.string() }),
    output: z.object({ title: z.string() }),
    run: (ctx, { text }) => ctx.step('title', (scope) => r.call('llm.title', { text }, scope)),
  })
  const parent = defineWorkflow({
    id: 'attr.parent',
    version: 'v1',
    input: z.object({}),
    output: z.object({ titles: z.array(z.string()) }),
    async run(ctx) {
      const own = await ctx.step('name', (scope) => r.call('llm.title', { text: 'a sentence' }, scope))
      const [fanned] = await ctx.workflow('fan', child, [{ text: 'another sentence' }])
      return { titles: [own.title, fanned?.title ?? 'none'] }
    },
  })

  test('the run, its child, the workflow, the step, purpose, project, workspace and trace', async () => {
    const rt = testRuntime({ schema: db.schema, workflows: [parent, child] })
    await rt.open()
    try {
      const { runId } = await rt.start(
        parent,
        {},
        { purpose: 'build', project: 'Übersetzung', workspace: 'private', traceparent: TRACEPARENT },
      )
      expect((await rt.wait(runId)).status).toBe('done')
      expect(gateway.requests).toHaveLength(2)
      expect(headers(0)).toMatchObject({
        authorization: 'Bearer agw-token',
        'x-agw-session': runId,
        'x-agw-run-id': runId,
        'x-agw-workflow': 'attr.parent',
        'x-agw-step': 'name',
        'x-agw-purpose': 'build',
        'x-agw-workspace': 'private',
        traceparent: TRACEPARENT,
      })
      // A project name that is not printable ASCII is dropped; the call went through anyway.
      expect(headers(0)).not.toHaveProperty('x-agw-project')
      // The child run has its own id and shares the root's session.
      const childRun = headers(1)['x-agw-run-id']
      expect(childRun).toBeString()
      expect(childRun).not.toBe(runId)
      expect(headers(1)).toMatchObject({
        'x-agw-session': runId,
        'x-agw-workflow': 'attr.child',
        'x-agw-step': 'title',
        'x-agw-purpose': 'build',
      })
    } finally {
      await rt.close()
    }
  })

  test('an ASCII project is sent; no project, no header', async () => {
    const rt = testRuntime({ schema: db.schema, workflows: [parent, child] })
    await rt.open()
    try {
      const first = await rt.start(child, { text: 'x' }, { purpose: 'prod', project: 'agent-workflows' })
      await rt.wait(first.runId)
      const second = await rt.start(child, { text: 'y' }, { purpose: 'prod' })
      await rt.wait(second.runId)
      expect(headers(0)).toMatchObject({ 'x-agw-project': 'agent-workflows', 'x-agw-session': first.runId })
      expect(headers(1)).not.toHaveProperty('x-agw-project')
      expect(headers(1)).not.toHaveProperty('x-agw-workspace')
      expect(headers(1)).not.toHaveProperty('traceparent')
    } finally {
      await rt.close()
    }
  })
})

import { afterAll, afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gatewayHeaders } from '@agent-workflows/capabilities'
import { type AgentDefinition, createClient, OpenCodeHost } from '@agent-workflows/opencode-host'
import { type Attribution, defineWorkflow } from '@agent-workflows/runtime'
import { z } from 'zod'
import { freshSchema, testRuntime } from '../../runtime/test/support/pg.ts'
import { startFake } from '../../opencode-host/test/fake-opencode.ts'

// The attribution of an agent step, from the run through the runtime and the OpenCode host to what the plugin puts on a
// model request: a real `Runtime` and `OpenCodeHost` on the fake server, the real plugin reading what the host stored.

const db = freshSchema('attr_opencode')
afterAll(() => db.drop())

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

const TRACEPARENT = '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01'
const AGENT: AgentDefinition = { name: 'tester', agentsMd: '# tester\n', route: 'check' }
const ENV = {
  AGW_ROUTES: JSON.stringify({
    check: {
      model: 'claude-haiku-5-5',
      effort: null,
      fallback: { model: 'gpt-6.1-terra', effort: 'medium', maxOutputTokens: 32_000 },
    },
  }),
}

/** What the plugin sets on a request of this session. */
async function pluginHeaders(session: (id: string) => Promise<unknown>, sessionID: string) {
  const path = join(import.meta.dir, '../../opencode-host/plugin/agw-attribution/server.js')
  const plugin = ((await import(path)) as { default: { setup: (ctx: unknown) => Promise<void> } }).default
  let hook: ((event: { sessionID: string; headers: Record<string, string> }) => Promise<void>) | undefined
  await plugin.setup({
    session: {
      get: ({ sessionID: id }: { sessionID: string }) => session(id),
      hook: async (_: string, fn: typeof hook) => {
        hook = fn
      },
    },
  })
  const event = { sessionID, headers: {} }
  await hook?.(event)
  return event.headers
}

function start() {
  const dir = mkdtempSync(join(tmpdir(), 'attr-opencode-'))
  const fake = startFake({ password: 'pw', statePath: join(dir, 'fake.json') })
  const endpoint = () => ({ baseUrl: fake.url, password: 'pw' })
  const server = { endpoint, ready: async () => {} }
  const host = new OpenCodeHost({
    server,
    agents: [AGENT],
    stateDir: dir,
    pollIntervalMs: 20,
    cutoffGraceMs: 150,
    env: ENV,
    logger: { warn: () => {}, error: () => {} },
  })
  const client = createClient(endpoint)
  cleanups.push(() => {
    host.close()
    fake.stop()
    rmSync(dir, { recursive: true, force: true })
  })
  return { host, fake, session: (id: string) => client.getSession(id) }
}

test('an agent step, its balance fallback and a follow-up turn each reach the plugin with their step', async () => {
  const { host, fake, session } = start()
  const seen: Attribution[] = []
  const workflow = defineWorkflow({
    id: 'attr.agent',
    version: 'v1',
    input: z.object({}),
    output: z.object({ done: z.boolean() }),
    async run(ctx) {
      await ctx.step('own', ({ attribution }) => {
        seen.push(attribution)
        return { ok: true }
      })
      await ctx.agent('draft', { agent: 'tester', prompt: '[balance] draft it' })
      await ctx.continue('reask', 'draft', 'again')
      return { done: true }
    },
  })
  const runtime = testRuntime({ schema: db.schema, workflows: [workflow], host })
  await runtime.open()
  cleanups.push(() => runtime.close())

  const { runId } = await runtime.start(
    workflow,
    {},
    { purpose: 'verify', project: 'agent-workflows', workspace: 'private', traceparent: TRACEPARENT },
  )
  expect((await runtime.wait(runId)).status).toBe('done')

  const [primary, fallback] = Object.values(fake.state.sessions)
  expect(fallback).toBeDefined()
  const of = (step: string): Attribution => ({ ...(seen[0] as Attribution), step })
  expect(of('draft')).toEqual({
    runId,
    rootId: runId,
    workflow: 'attr.agent',
    step: 'draft',
    purpose: 'verify',
    project: 'agent-workflows',
    workspace: 'private',
    traceparent: TRACEPARENT,
  })
  // Under the names of `Attribution`, and the headers `gatewayHeaders` writes for the same step.
  expect(primary?.metadata?.agw).toMatchObject(of('draft'))
  expect(await pluginHeaders(session, primary?.id as string)).toEqual(gatewayHeaders(of('draft')))
  // The step fell back, so the follow-up turn ran there and moved that session on to its own step.
  expect(fallback?.metadata?.agw).toMatchObject(of('reask'))
  expect(await pluginHeaders(session, fallback?.id as string)).toEqual(gatewayHeaders(of('reask')))
})

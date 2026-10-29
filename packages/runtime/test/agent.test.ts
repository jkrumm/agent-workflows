import { afterAll, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { defineWorkflow, type Json, type Middleware, type ToolEvent } from '../src/index.ts'
import { FakeAgentHost } from '../src/testing.ts'
import { freshSchema, inspector, testRuntime, until } from './support/pg.ts'

const db = freshSchema('agent')
const sql = inspector(db.schema)

afterAll(async () => {
  await sql.close()
  await db.drop()
})

const empty = z.object({})
const answer = z.object({ answer: z.string() })
const usage = {
  model: 'fake-1',
  tokens: { input: 10, output: 5, cacheRead: 2, reasoning: 1 },
  cost: 0.01,
  toolCalls: 1,
}

function agentWorkflow(id: string, spec: { idleTimeoutMs?: number | null } = {}) {
  return defineWorkflow({
    id,
    version: 'v1',
    input: empty,
    output: answer,
    run: (ctx) => ctx.agent('ask', { agent: 'helper', prompt: 'what?', output: answer, ...spec }),
  })
}

describe('agent steps', () => {
  test('open → journal handle → prompt → wait; output validated, usage and tool hooks recorded', async () => {
    const tools: { phase: string; event: ToolEvent }[] = []
    const mw: Middleware = {
      name: 'tools',
      toolPre: (event) => void tools.push({ phase: 'pre', event }),
      toolPost: (event) => void tools.push({ phase: 'post', event }),
    }
    const host = new FakeAgentHost(async (s) => {
      await s.attached // the session starts at the prompt; hooks fire only once the step has attached its waiter
      await s.tool('read', { path: 'a' }, 'content')
      return { output: { answer: 'forty-two' }, usage }
    })
    const wf = agentWorkflow('agent.happy')
    const rt = testRuntime({ schema: db.schema, workflows: [wf], host, middleware: [mw] })
    await rt.open()
    try {
      const { runId } = await rt.start(wf, {}, { purpose: 'build' })
      expect((await rt.wait(runId)).output).toEqual({ answer: 'forty-two' })
      expect(host.events.map((e) => e.op)).toEqual(['open', 'prompt'])
      expect(await sql.step(runId, 'ask')).toMatchObject({
        kind: 'agent',
        status: 'done',
        handle: { handle: { sessionId: 'ses_1' }, prompted: true },
        model: 'fake-1',
        tokens_input: '10',
        tool_calls: 1,
      })
      expect(tools.map((t) => `${t.phase}:${t.event.tool}:${t.event.stepId}`)).toEqual([
        'pre:read:ask',
        'post:read:ask',
      ])
    } finally {
      await rt.close()
    }
  })

  test('output that fails the agent schema fails the step as invalid_output', async () => {
    const host = new FakeAgentHost(async () => ({ output: { nope: 1 } }))
    const wf = agentWorkflow('agent.invalid')
    const rt = testRuntime({ schema: db.schema, workflows: [wf], host })
    await rt.open()
    try {
      const { runId } = await rt.start(wf, {}, { purpose: 'build' })
      expect((await rt.wait(runId)).status).toBe('failed')
      expect(await sql.step(runId, 'ask')).toMatchObject({ status: 'failed', error_kind: 'invalid_output' })
    } finally {
      await rt.close()
    }
  })

  test('resume with a prompted handle re-attaches: one session, one prompt', async () => {
    const host = new FakeAgentHost(async (s) => {
      await s.sleep(400)
      return { output: { answer: 'late' } }
    })
    const wf = agentWorkflow('agent.reattach')
    const first = testRuntime({ schema: db.schema, workflows: [wf], host })
    await first.open()
    const { runId } = await first.start(wf, {}, { purpose: 'build' })
    await until(() => host.count('prompt', 'sent') === 1, 'prompt')
    await until(async () => (await sql.step(runId, 'ask'))?.handle, 'handle journaled')
    await first.close()

    const second = testRuntime({ schema: db.schema, workflows: [wf], host })
    await second.open()
    try {
      expect((await second.wait(runId)).output).toEqual({ answer: 'late' })
      expect(host.count('open')).toBe(1)
      expect(host.count('prompt')).toBe(1)
      expect(await sql.step(runId, 'ask')).toMatchObject({ attempts: 2, status: 'done' })
    } finally {
      await second.close()
    }
  })

  test('resume with a handle but no journaled prompt prompts the same session once', async () => {
    let hang = true
    class HangingHost extends FakeAgentHost {
      override async prompt(handle: Json): Promise<void> {
        if (hang) return new Promise(() => {}) // the first process dies inside the send
        return super.prompt(handle)
      }
    }
    const host = new HangingHost(async () => ({ output: { answer: 'prompted once' } }))
    const wf = agentWorkflow('agent.prompt-on-resume')
    const first = testRuntime({ schema: db.schema, workflows: [wf], host })
    await first.open()
    const { runId } = await first.start(wf, {}, { purpose: 'build' })
    await until(async () => (await sql.step(runId, 'ask'))?.handle, 'handle journaled')
    await first.close()
    hang = false

    const second = testRuntime({ schema: db.schema, workflows: [wf], host })
    await second.open()
    try {
      expect((await second.wait(runId)).output).toEqual({ answer: 'prompted once' })
      expect(host.count('open')).toBe(1)
      expect(host.count('prompt', 'sent')).toBe(1)
    } finally {
      await second.close()
    }
  })

  test('an agent without host progress for idleTimeoutMs fails as timeout and the session is aborted', async () => {
    const host = new FakeAgentHost(async (s) => {
      await s.sleep(5000)
      return { output: { answer: 'never' } }
    })
    const wf = agentWorkflow('agent.idle', { idleTimeoutMs: 100 })
    const rt = testRuntime({ schema: db.schema, workflows: [wf], host })
    await rt.open()
    try {
      const { runId } = await rt.start(wf, {}, { purpose: 'build' })
      expect((await rt.wait(runId)).status).toBe('failed')
      expect(await sql.step(runId, 'ask')).toMatchObject({ status: 'failed', error_kind: 'timeout' })
      await until(() => host.count('abort') === 1, 'host.abort')
    } finally {
      await rt.close()
    }
  })

  test('host progress keeps a long agent alive', async () => {
    const host = new FakeAgentHost(async (s) => {
      await s.sleep(500, 40)
      return { output: { answer: 'slow but alive' } }
    })
    const wf = agentWorkflow('agent.alive', { idleTimeoutMs: 120 })
    const rt = testRuntime({ schema: db.schema, workflows: [wf], host })
    await rt.open()
    try {
      const { runId } = await rt.start(wf, {}, { purpose: 'build' })
      expect((await rt.wait(runId)).output).toEqual({ answer: 'slow but alive' })
    } finally {
      await rt.close()
    }
  })
})

describe('agent edge cases', () => {
  test('a cancel that lands while the session opens aborts it and never prompts', async () => {
    let releaseOpen: () => void = () => {}
    const opened = new Promise<void>((resolve) => {
      releaseOpen = resolve
    })
    let opening = false
    class SlowOpenHost extends FakeAgentHost {
      override async open(spec: Parameters<FakeAgentHost['open']>[0]): Promise<Json> {
        opening = true
        await opened
        return super.open(spec)
      }
    }
    const host = new SlowOpenHost()
    const wf = agentWorkflow('agent.cancel-open')
    const rt = testRuntime({ schema: db.schema, workflows: [wf], host })
    await rt.open()
    try {
      const { runId } = await rt.start(wf, {}, { purpose: 'build' })
      await until(() => opening, 'open in flight')
      await rt.cancel(runId)
      releaseOpen()
      expect((await rt.wait(runId)).status).toBe('cancelled')
      await until(() => host.count('abort') === 1, 'host.abort')
      expect(host.count('prompt')).toBe(0)
    } finally {
      await rt.close()
    }
  })

  test('a timeout during the prompt send never lets the superseded attempt overwrite the new handle', async () => {
    let prompts = 0
    class SlowPromptHost extends FakeAgentHost {
      override async prompt(handle: Json): Promise<void> {
        prompts++
        if (prompts === 1) await Bun.sleep(250) // outlives the idle timeout, resolves during the retry
        return super.prompt(handle)
      }
    }
    const host = new SlowPromptHost(async (s) => {
      await s.sleep(300, 20)
      return { output: { answer: s.id } }
    })
    const wf = defineWorkflow({
      id: 'agent.stale-attempt',
      version: 'v1',
      input: empty,
      output: answer,
      run: (ctx) =>
        ctx.agent('ask', {
          agent: 'helper',
          prompt: 'q',
          output: answer,
          idleTimeoutMs: 100,
          retry: { attempts: 2, backoffMs: 10 },
        }),
    })
    const rt = testRuntime({ schema: db.schema, workflows: [wf], host })
    await rt.open()
    try {
      const { runId } = await rt.start(wf, {}, { purpose: 'build' })
      expect((await rt.wait(runId)).output).toEqual({ answer: 'ses_2' })
      await Bun.sleep(100)
      expect(await sql.step(runId, 'ask')).toMatchObject({ handle: { handle: { sessionId: 'ses_2' }, prompted: true } })
    } finally {
      await rt.close()
    }
  })

  test('a retry after invalid output opens a fresh session instead of re-reading the old one', async () => {
    let n = 0
    const host = new FakeAgentHost(async () => {
      n++
      const output: Json = n === 1 ? { wrong: true } : { answer: `try ${n}` }
      return { output }
    })
    const wf = defineWorkflow({
      id: 'agent.retry-fresh',
      version: 'v1',
      input: empty,
      output: answer,
      run: (ctx) =>
        ctx.agent('ask', { agent: 'helper', prompt: 'q', output: answer, retry: { attempts: 2, backoffMs: 10 } }),
    })
    const rt = testRuntime({ schema: db.schema, workflows: [wf], host })
    await rt.open()
    try {
      const { runId } = await rt.start(wf, {}, { purpose: 'build' })
      expect((await rt.wait(runId)).output).toEqual({ answer: 'try 2' })
      expect(host.count('open')).toBe(2)
      expect(host.count('prompt', 'sent')).toBe(2)
    } finally {
      await rt.close()
    }
  })
})

describe('fan-out', () => {
  test('ctx.workflow runs children under the parent; a failing child yields null', async () => {
    const child = defineWorkflow({
      id: 'fan.child',
      version: 'v1',
      input: z.object({ i: z.number() }),
      output: z.object({ v: z.number() }),
      async run(ctx, { i }) {
        const v = await ctx.step('work', () => {
          if (i === 1) throw new Error('child 1 fails by design')
          return i * 10
        })
        return { v }
      },
    })
    const parent = defineWorkflow({
      id: 'fan.parent',
      version: 'v1',
      input: empty,
      output: z.object({ results: z.array(z.object({ v: z.number() }).nullable()) }),
      async run(ctx) {
        const results = await ctx.workflow('kids', child, [{ i: 0 }, { i: 1 }, { i: 2 }, { i: 'bad' as never }])
        return { results }
      },
    })
    const rt = testRuntime({ schema: db.schema, workflows: [parent] })
    await rt.open()
    try {
      const { runId } = await rt.start(parent, {}, { purpose: 'build' })
      expect((await rt.wait(runId)).output).toEqual({ results: [{ v: 0 }, null, { v: 20 }, null] })
      const kid = await sql.run(`${runId}/kids/1`)
      expect(kid).toMatchObject({ parent_id: runId, root_id: runId, status: 'failed', purpose: 'build' })
      expect(await sql.run(`${runId}/kids/3`)).toMatchObject({ status: 'failed', error_kind: 'invalid_input' })
      expect(await sql.step(runId, 'kids')).toMatchObject({ kind: 'workflow', status: 'done' })
    } finally {
      await rt.close()
    }
  })
})

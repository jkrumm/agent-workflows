import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentWaitOptions, Json } from '@agent-workflows/runtime'
import { WorkflowError } from '@agent-workflows/runtime'
import { type AgentDefinition, createClient, type OpenCodeHandle, OpenCodeHost, type ServerPort } from '../src/index.ts'
import { type FakeServer, startFake } from './fake-opencode.ts'

const AGENT: AgentDefinition = { name: 'tester', agentsMd: '# tester\n', route: 'check' }
const cleanups: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn()
})

function setup(options: { env?: Record<string, string>; turnMs?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'och-host-'))
  const statePath = join(dir, 'fake.json')
  let fake: FakeServer = startFake({ password: 'pw', statePath, defaultTurnMs: options.turnMs })
  const port = fake.port
  const server: ServerPort = {
    endpoint: () => ({ baseUrl: `http://127.0.0.1:${port}`, password: 'pw' }),
    ready: async () => {},
  }
  const warnings: string[] = []
  const host = new OpenCodeHost({
    logger: { warn: (m) => warnings.push(m), error: (m) => warnings.push(m) },
    server,
    agents: [AGENT],
    stateDir: dir,
    pollIntervalMs: 20,
    cutoffGraceMs: 150,
    env: options.env ?? {},
    locations: { evictAfterMs: 0, tickMs: 60_000 },
  })
  const t = {
    dir,
    host,
    warnings,
    get fake() {
      return fake
    },
    /** SIGKILL-like: the listener goes and running turns stop where they are. */
    kill: () => fake.stop(),
    /** A fresh server on the same port and store. */
    boot: () => {
      fake = startFake({ port, password: 'pw', statePath, defaultTurnMs: options.turnMs })
    },
    client: createClient(() => server.endpoint()),
  }
  cleanups.push(() => {
    host.close()
    fake.stop()
    rmSync(dir, { recursive: true, force: true })
  })
  return t
}

const spec = (prompt: string, options?: Json) => ({
  runId: 'run-1',
  stepId: 'agent',
  key: 'run-1:agent',
  agent: 'tester',
  prompt,
  ...(options === undefined ? {} : { options }),
})

function waitOptions(over: Partial<AgentWaitOptions> = {}): AgentWaitOptions {
  return { signal: new AbortController().signal, onProgress: () => {}, onTool: async () => {}, ...over }
}

const userMessages = async (t: ReturnType<typeof setup>, handle: Json) =>
  (await t.client.messages((handle as OpenCodeHandle).sessionId)).filter((m) => m.type === 'user')

describe('open / prompt / wait', () => {
  test('a turn returns the final text and usage from the messages', async () => {
    const t = setup()
    const handle = await t.host.open(spec('hello'))
    expect(handle).toMatchObject({ v: 1, agent: 'tester', route: 'check', output: 'text', runId: 'run-1' })
    expect(JSON.parse(JSON.stringify(handle))).toEqual(handle)
    await t.host.prompt(handle, 'hello')
    const result = await t.host.wait(handle, waitOptions())
    expect(result.output).toBe('echo: hello')
    expect(result.usage?.tokens).toEqual({ input: 130, output: 6, cacheRead: 100, cacheWrite: 20, reasoning: 1 })
    expect(result.usage?.cost).toBe(0.001)
    expect(result.usage?.costSource).toBe('provider')
  })

  test('prompt is idempotent: a second call reads the session and sends nothing', async () => {
    const t = setup()
    const handle = await t.host.open(spec('once'))
    await t.host.prompt(handle, 'once')
    await t.host.prompt(handle, 'once')
    await t.host.wait(handle, waitOptions())
    await t.host.prompt(handle, 'once')
    expect(t.fake.count(`POST /api/session/${(handle as OpenCodeHandle).sessionId}/prompt`)).toBe(1)
    expect(await userMessages(t, handle)).toHaveLength(1)
  })

  test('structured output is parsed from a fenced block', async () => {
    const t = setup()
    const handle = await t.host.open(spec('[json]', { output: 'json' }))
    await t.host.prompt(handle, '[json] give me data')
    expect((await t.host.wait(handle, waitOptions())).output).toEqual({ ok: true, inputs: 1 })
  })

  test('a failed turn fails the step', async () => {
    const t = setup()
    const handle = await t.host.open(spec('x'))
    await t.host.prompt(handle, '[fail]')
    const err = await t.host.wait(handle, waitOptions()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(WorkflowError)
    expect((err as Error).message).toContain('provider said no')
  })

  test('unknown agent and a non-opencode route are refused', async () => {
    const t = setup()
    expect(t.host.open({ ...spec('x'), agent: 'nobody' })).rejects.toThrow('unknown agent')
    expect(t.host.open(spec('x', { route: 'cheap.classify' }))).rejects.toThrow('not opencode')
  })

  test('a route without any rate in the table is reported unpriced, never as cost 0', async () => {
    const t = setup({ env: { AGW_ROUTES: JSON.stringify({ check: { model: 'some-unpriced-model' } }) } })
    const handle = await t.host.open(spec('x'))
    await t.host.prompt(handle, 'x')
    const { usage } = await t.host.wait(handle, waitOptions())
    expect(usage?.model).toBe('some-unpriced-model')
    expect(usage?.cost).toBeNull()
    expect(usage?.costSource).toBe('unknown')
  })
})

describe('re-attach across a server restart', () => {
  test('prompt after a restart finds the admitted prompt and does not send it again', async () => {
    const t = setup({ turnMs: 5_000 })
    const handle = await t.host.open(spec('long'))
    await t.host.prompt(handle, 'long task')
    t.kill()
    t.boot()
    await t.host.prompt(handle, 'long task') // the runtime re-sends when it crashed before journaling `prompted`
    expect(t.fake.count(`POST /api/session/${(handle as OpenCodeHandle).sessionId}/prompt`)).toBe(0)
    expect(await userMessages(t, handle)).toHaveLength(1)
  })

  test('a wait in flight survives a kill and restart, resumes the cut-off turn once, never re-prompts', async () => {
    const t = setup({ turnMs: 400 })
    const handle = await t.host.open(spec('long'))
    await t.host.prompt(handle, 'long task')
    let progress = 0
    const waiting = t.host.wait(handle, waitOptions({ onProgress: () => progress++ }))
    await Bun.sleep(100)
    t.kill()
    await Bun.sleep(200) // the wait sees refused connections and keeps polling
    t.boot()
    const result = await waiting
    expect(result.output).toBe('resumed: echo: long task')
    const messages = await t.client.messages((handle as OpenCodeHandle).sessionId)
    expect(messages.filter((m) => m.type === 'user')).toHaveLength(1)
    expect(messages.filter((m) => m.type === 'synthetic')).toHaveLength(1)
    expect(progress).toBeGreaterThan(0)
    expect(t.warnings).toEqual(['opencode session cut off, resuming'])
  })

  test('a session that finished while nobody waited is read, not resumed', async () => {
    const t = setup()
    const handle = await t.host.open(spec('quick'))
    await t.host.prompt(handle, 'quick')
    await Bun.sleep(200)
    t.kill()
    t.boot()
    expect((await t.host.wait(handle, waitOptions())).output).toBe('echo: quick')
    expect(t.fake.count(`POST /api/session/${(handle as OpenCodeHandle).sessionId}/synthetic`)).toBe(0)
  })

  test('a lost session fails the step', async () => {
    const t = setup()
    const handle = { ...((await t.host.open(spec('x'))) as OpenCodeHandle), sessionId: 'ses_gone' }
    expect(t.host.wait(handle, waitOptions())).rejects.toThrow('is gone')
  })
})

describe('steer and abort', () => {
  test('steer appends a user message to the running turn; a re-delivered steer is deduped', async () => {
    const t = setup({ turnMs: 300 })
    const handle = await t.host.open(spec('s'))
    await t.host.prompt(handle, 'first')
    const waiting = t.host.wait(handle, waitOptions())
    await Bun.sleep(50)
    await t.host.steer(handle, 'use the second plan')
    await t.host.steer(handle, 'use the second plan')
    expect((await waiting).output).toBe('echo: use the second plan')
    const users = await userMessages(t, handle)
    expect(users.map((m) => m.text)).toEqual(['first', 'use the second plan'])
  })

  test('abort interrupts once and is idempotent; the wait ends with its signal', async () => {
    const t = setup({ turnMs: 5_000 })
    const handle = await t.host.open(spec('a'))
    await t.host.prompt(handle, 'a')
    const controller = new AbortController()
    const waiting = t.host.wait(handle, waitOptions({ signal: controller.signal }))
    await Bun.sleep(50)
    await t.host.abort(handle)
    await t.host.abort(handle)
    controller.abort(new Error('cancelled by test'))
    expect(waiting).rejects.toThrow('cancelled by test')
    const messages = await t.client.messages((handle as OpenCodeHandle).sessionId)
    expect(messages.filter((m) => m.type === 'idle').map((m) => m.outcome)).toEqual(['interrupted'])
    await t.host.abort({ ...(handle as OpenCodeHandle), sessionId: 'ses_gone' })
  })
})

describe('progress and tools', () => {
  test('tool calls are reported pre and post, once each', async () => {
    const t = setup({ turnMs: 60 })
    const handle = await t.host.open(spec('t'))
    await t.host.prompt(handle, '[tool:read] look around')
    const events: string[] = []
    const result = await t.host.wait(
      handle,
      waitOptions({
        onTool: async (e) => {
          events.push(`${e.phase}:${e.tool}:${e.phase === 'post' ? String(e.output) : ''}`)
        },
      }),
    )
    expect(events).toEqual(['pre:read:', 'post:read:a.txt'])
    expect(result.usage?.toolCalls).toBe(1)
  })

  test('a refusing onTool ends the wait with its error', async () => {
    const t = setup({ turnMs: 200 })
    const handle = await t.host.open(spec('t'))
    await t.host.prompt(handle, '[tool:shell] go')
    const refused = new Error('tool refused')
    const err = await t.host
      .wait(
        handle,
        waitOptions({
          onTool: async () => {
            throw refused
          },
        }),
      )
      .catch((e: unknown) => e)
    expect(err).toBe(refused)
  })

  test('a running shell that only prints still counts as progress', async () => {
    const t = setup({ turnMs: 50 })
    const handle = await t.host.open(spec('sh'))
    await t.host.prompt(handle, '[shell:500] build')
    const at: number[] = []
    await t.host.wait(handle, waitOptions({ onProgress: () => at.push(Date.now()) }))
    expect(at.length).toBeGreaterThan(5)
  })
})

describe('locations', () => {
  test('the first open warms the location, a second does not, an idle one is evicted', async () => {
    const t = setup()
    const handle = (await t.host.open(spec('x'))) as OpenCodeHandle
    expect(handle.directory).toBe(join(t.dir, 'locations', 'tester'))
    expect(t.host.warmLocations()).toEqual([handle.directory])
    expect(t.fake.count('GET /api/location')).toBe(1)
    await t.host.open(spec('x'))
    expect(t.fake.count('GET /api/location')).toBe(1)
    await t.host.evictIdle()
    expect(t.host.warmLocations()).toEqual([])
    expect(t.fake.count('DELETE /api/debug/location')).toBe(1)
    expect([...t.fake.locations]).toEqual([])
  })

  test('a location is not evicted while a wait uses it', async () => {
    const t = setup({ turnMs: 300 })
    const handle = await t.host.open(spec('x'))
    await t.host.prompt(handle, 'x')
    const waiting = t.host.wait(handle, waitOptions())
    await Bun.sleep(80)
    await t.host.evictIdle()
    expect(t.fake.count('DELETE /api/debug/location')).toBe(0)
    await waiting
    await t.host.evictIdle()
    expect(t.fake.count('DELETE /api/debug/location')).toBe(1)
  })
})

import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentWaitOptions, Json } from '@agent-workflows/runtime'
import { WorkflowError } from '@agent-workflows/runtime'
import { type AgentDefinition, createClient, type OpenCodeHandle, OpenCodeHost, type ServerPort } from '../src/index.ts'
import { sessionState } from '../src/session.ts'
import { type FakeServer, startFake } from './fake-opencode.ts'

const AGENT: AgentDefinition = { name: 'tester', agentsMd: '# tester\n', route: 'check' }
const cleanups: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn()
})

/** The rejection's message; fails the test when the promise resolves. */
async function failure(promise: Promise<unknown>): Promise<string> {
  const outcome = await promise.then(
    () => null,
    (err: unknown) => err,
  )
  if (!(outcome instanceof Error)) throw new Error('expected a rejection')
  return outcome.message
}

function setup(options: { env?: Record<string, string>; turnMs?: number; agents?: AgentDefinition[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'och-host-'))
  const statePath = join(dir, 'fake.json')
  let fake: FakeServer = startFake({ password: 'pw', statePath, defaultTurnMs: options.turnMs })
  const port = fake.port
  const server: ServerPort = {
    endpoint: () => ({ baseUrl: `http://127.0.0.1:${port}`, password: 'pw' }),
    ready: async () => {},
  }
  const warnings: string[] = []
  const makeHost = (agents = options.agents ?? [AGENT], locations: Record<string, number> = {}, pinTtlMs?: number) =>
    new OpenCodeHost({
      ...(pinTtlMs === undefined ? {} : { pinTtlMs }),
      logger: { warn: (m) => warnings.push(m), error: (m) => warnings.push(m) },
      server,
      agents,
      stateDir: dir,
      pollIntervalMs: 20,
      cutoffGraceMs: 150,
      env: options.env ?? {},
      locations: { evictAfterMs: 0, tickMs: 60_000, retentionMs: 0, ...locations },
    })
  const host = makeHost()
  const t = {
    dir,
    host,
    makeHost,
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

const spec = (prompt: string, options?: Json, key = 'run-1:agent') => ({
  runId: 'run-1',
  stepId: 'agent',
  key,
  agent: 'tester',
  prompt,
  ...(options === undefined ? {} : { options }),
})

function waitOptions(over: Partial<AgentWaitOptions> = {}): AgentWaitOptions {
  return { signal: new AbortController().signal, onProgress: () => {}, onTool: async () => {}, ...over }
}

const sid = (handle: Json) => (handle as OpenCodeHandle).sessionId
const userMessages = async (t: ReturnType<typeof setup>, handle: Json) =>
  (await t.client.messages(sid(handle))).filter((m) => m.type === 'user')

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
    expect(t.fake.count(`POST /api/session/${sid(handle)}/prompt`)).toBe(1)
    expect(await userMessages(t, handle)).toHaveLength(1)
  })

  test('open is idempotent per step key until the session is prompted; a retry then gets a new session', async () => {
    const t = setup()
    const first = await t.host.open(spec('x'))
    const again = await t.host.open(spec('x')) // a crash between create and journaling the handle
    expect(sid(again)).toBe(sid(first))
    expect(sid(first)).toMatch(/^ses_agw[0-9a-f]{24}$/)
    await t.host.prompt(first, 'x')
    await t.host.wait(first, waitOptions()) // the attempt's turn ended (and the step then failed, say)
    const retry = await t.host.open(spec('x')) // the runtime forgot the failed attempt's handle
    expect(sid(retry)).not.toBe(sid(first))
    expect(sid(await t.host.open(spec('x')))).toBe(sid(retry))
    expect(sid(await t.host.open(spec('x', undefined, 'run-2:agent')))).not.toBe(sid(first))
  })

  test('a retry while the earlier attempt still runs re-attaches to it instead of a sibling session', async () => {
    const t = setup({ turnMs: 400 })
    const first = await t.host.open(spec('x'))
    await t.host.prompt(first, '[tool:read] the task')
    // The attempt's wait fails while its turn goes on server-side: a throwing onTool, nobody aborted the session.
    const onTool = async () => {
      throw new Error('onTool threw')
    }
    expect(await failure(t.host.wait(first, waitOptions({ onTool })))).toBe('onTool threw')
    const retry = await t.host.open(spec('x'))
    expect(sid(retry)).toBe(sid(first))
    expect(t.warnings).toContain('opencode session of an earlier attempt still runs; re-attaching')
    await t.host.prompt(retry, '[tool:read] the task') // a no-op: the prompt is there
    expect((await t.host.wait(retry, waitOptions())).output).toBe('echo: [tool:read] the task')
    expect(Object.keys(t.fake.state.sessions)).toEqual([sid(first)])
    expect(await userMessages(t, retry)).toHaveLength(1)
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

  test('an idle without a known outcome is unknown, never a success', () => {
    const messages = [
      { id: 'p', type: 'user', metadata: { agw: { kind: 'prompt' } } },
      { id: 'a', type: 'assistant' },
      { id: 'i', type: 'idle' },
    ]
    expect(sessionState(messages, { promptId: 'p', active: false, pending: false })).toEqual({
      kind: 'done',
      outcome: 'unknown',
    })
  })

  test('unknown agent and a non-opencode route are refused', async () => {
    const t = setup()
    expect(await failure(t.host.open({ ...spec('x'), agent: 'nobody' }))).toContain('unknown agent')
    expect(await failure(t.host.open(spec('x', { route: 'cheap.classify' })))).toContain('not opencode')
  })

  test('OpenCode cost 0 with tokens is priced with the route rate', async () => {
    const t = setup()
    const handle = await t.host.open(spec('x'))
    await t.host.prompt(handle, '[free] x')
    const { usage } = await t.host.wait(handle, waitOptions())
    expect(usage?.costSource).toBe('rate')
    // 10 input, 100 cache read, 20 cache write, 6 output at the Haiku 5.5 EU rate.
    expect(usage?.cost).toBeCloseTo((10 * 0.1 + 100 * 0.01 + 20 * 0.125 + 6 * 0.5) / 1e6, 12)
  })

  test('cost 0 on a route without a rate is unpriced, never 0', async () => {
    const t = setup({ env: { AGW_ROUTES: JSON.stringify({ check: { model: 'some-unpriced-model' } }) } })
    const handle = await t.host.open(spec('x'))
    await t.host.prompt(handle, '[free] x')
    const { usage } = await t.host.wait(handle, waitOptions())
    expect(usage?.model).toBe('some-unpriced-model')
    expect(usage?.cost).toBeNull()
    expect(usage?.costSource).toBe('unknown')
  })

  test('the shell tool is denied unless the agent opts in; agent rules come after', async () => {
    const t = setup({
      agents: [
        AGENT,
        {
          name: 'builder',
          agentsMd: '# b\n',
          route: 'check',
          permissions: { shell: true, rules: [{ action: 'edit', resource: '*', effect: 'deny' }] },
        },
      ],
    })
    const plain = await t.host.open(spec('x'))
    const builder = await t.host.open({ ...spec('x', undefined, 'run-1:b'), agent: 'builder' })
    const perms = (s: { permissions?: unknown }) => s.permissions
    expect(perms(t.fake.state.sessions[sid(plain)] as { permissions?: unknown })).toEqual([
      { action: 'shell', resource: '*', effect: 'deny' },
    ])
    expect(perms(t.fake.state.sessions[sid(builder)] as { permissions?: unknown })).toEqual([
      { action: 'shell', resource: '*', effect: 'allow' },
      { action: 'edit', resource: '*', effect: 'deny' },
    ])
  })
})

describe('wait reads', () => {
  test('a prompt still in the inbox is running, not unprompted', async () => {
    const t = setup()
    const handle = await t.host.open(spec('x'))
    // Admitted, not yet projected into messages: the real server's window right after POST /prompt.
    await fetch(`${t.fake.url}/api/session/${sid(handle)}/prompt`, {
      method: 'POST',
      headers: { authorization: `Basic ${btoa('opencode:pw')}`, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'msg_admitted', text: 'x', metadata: { agw: { kind: 'prompt' } }, resume: false }),
    })
    const waiting = t.host.wait(handle, waitOptions())
    await Bun.sleep(400) // longer than the grace: still pending, never "unprompted"
    await t.host.steer(handle, 'go') // schedules the run
    expect((await waiting).output).toBe('echo: go')
  })

  test('wait without any prompt fails after the grace, not at once', async () => {
    const t = setup()
    const handle = await t.host.open(spec('x'))
    const started = Date.now()
    expect(await failure(t.host.wait(handle, waitOptions()))).toContain('holds no prompt')
    expect(Date.now() - started).toBeGreaterThanOrEqual(140)
  })

  test('polls read one newest-first page, not the whole session', async () => {
    const t = setup({ turnMs: 300 })
    const handle = await t.host.open(spec('x'))
    await t.host.prompt(handle, 'x')
    await t.host.wait(handle, waitOptions())
    const reads = t.fake.urls.filter((r) => r.startsWith(`GET /api/session/${sid(handle)}/message`))
    const walks = reads.filter((r) => r.includes('order=asc'))
    const pages = reads.filter((r) => r.includes('order=desc&limit=50'))
    // prompt's check, the first read and the final usage read walk the session; every other poll is one page.
    expect(walks).toHaveLength(3)
    expect(pages.length).toBeGreaterThan(5)
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
    expect(t.fake.count(`POST /api/session/${sid(handle)}/prompt`)).toBe(0)
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
    const messages = await t.client.messages(sid(handle))
    expect(messages.filter((m) => m.type === 'user')).toHaveLength(1)
    expect(messages.filter((m) => m.type === 'synthetic')).toHaveLength(1)
    expect(progress).toBeGreaterThan(0)
    expect(t.warnings.filter((w) => w !== 'opencode session read failed; retried next poll')).toEqual([
      'opencode session cut off, resuming',
    ])
  })

  test('a session that finished while nobody waited is read, not resumed', async () => {
    const t = setup()
    const handle = await t.host.open(spec('quick'))
    await t.host.prompt(handle, 'quick')
    await Bun.sleep(200)
    t.kill()
    t.boot()
    expect((await t.host.wait(handle, waitOptions())).output).toBe('echo: quick')
    expect(t.fake.count(`POST /api/session/${sid(handle)}/synthetic`)).toBe(0)
  })

  test('a lost session fails the step', async () => {
    const t = setup()
    const handle = { ...((await t.host.open(spec('x'))) as OpenCodeHandle), sessionId: 'ses_gone' }
    expect(await failure(t.host.wait(handle, waitOptions()))).toContain('is gone')
  })
})

describe('steer and abort', () => {
  test('steer appends; the same signal twice is one message, two identical signals are two', async () => {
    const t = setup({ turnMs: 300 })
    const handle = await t.host.open(spec('s'))
    await t.host.prompt(handle, 'first')
    const waiting = t.host.wait(handle, waitOptions())
    await Bun.sleep(50)
    await t.host.steer(handle, 'use plan B', { signalId: '7' })
    await t.host.steer(handle, 'use plan B', { signalId: '7' }) // a re-delivery of row 7
    await t.host.steer(handle, 'use plan B', { signalId: '8' })
    await t.host.steer(handle, 'no id') // a nonce each: never deduped by text
    await t.host.steer(handle, 'no id')
    await waiting
    const users = await userMessages(t, handle)
    expect(users.map((m) => m.text)).toEqual(['first', 'use plan B', 'use plan B', 'no id', 'no id'])
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
    expect(await failure(waiting)).toContain('cancelled by test')
    const messages = await t.client.messages(sid(handle))
    expect(messages.filter((m) => m.type === 'idle').map((m) => m.outcome)).toEqual(['interrupted'])
    await t.host.abort({ ...(handle as OpenCodeHandle), sessionId: 'ses_gone' })
  })
})

describe('progress and tools', () => {
  test('tool calls are reported pre and post, once each, per wait', async () => {
    const t = setup({ turnMs: 60 })
    const handle = await t.host.open(spec('t'))
    await t.host.prompt(handle, '[tool:read] look around')
    const events: string[] = []
    const onTool: AgentWaitOptions['onTool'] = async (e) => {
      events.push(`${e.phase}:${e.tool}:${e.phase === 'post' ? String(e.output) : ''}`)
    }
    const result = await t.host.wait(handle, waitOptions({ onTool }))
    expect(events).toEqual(['pre:read:', 'post:read:a.txt'])
    expect(result.usage?.toolCalls).toBe(1)
    await t.host.wait(handle, waitOptions({ onTool })) // a second wait has its own record (at-least-once)
    expect(events).toHaveLength(4)
  })

  test('a refusing onTool ends the wait with its error', async () => {
    const t = setup({ turnMs: 200 })
    const handle = await t.host.open(spec('t'))
    await t.host.prompt(handle, '[tool:shell] go')
    const refused = new Error('tool refused')
    const onTool = async () => {
      throw refused
    }
    expect(await t.host.wait(handle, waitOptions({ onTool })).catch((e: unknown) => e)).toBe(refused)
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
    expect(handle.directory).toMatch(new RegExp(`^${t.dir}/locations/tester/[0-9a-f]{16}$`))
    expect(t.host.warmLocations()).toEqual([handle.directory])
    expect(t.fake.count('GET /api/location')).toBe(1)
    await t.host.open(spec('x'))
    expect(t.fake.count('GET /api/location')).toBe(1)
    await t.host.maintain()
    expect(t.host.warmLocations()).toEqual([handle.directory]) // pinned by open until its wait
    await t.host.prompt(handle, 'x')
    await t.host.wait(handle, waitOptions())
    await t.host.maintain()
    expect(t.host.warmLocations()).toEqual([])
    expect(t.fake.count('DELETE /api/debug/location')).toBe(2) // once before the first warm (new content), once now
    expect([...t.fake.locations]).toEqual([])
  })

  test('a location is not evicted while a wait uses it', async () => {
    const t = setup({ turnMs: 300 })
    const handle = await t.host.open(spec('x'))
    await t.host.prompt(handle, 'x')
    const deletes = () => t.fake.count('DELETE /api/debug/location')
    const before = deletes()
    const waiting = t.host.wait(handle, waitOptions())
    await Bun.sleep(80)
    await t.host.maintain()
    expect(deletes()).toBe(before)
    await waiting
    await t.host.maintain()
    expect(deletes()).toBe(before + 1)
  })

  test('a session re-attached in an older hash directory stays pinned, warm and unpruned until its wait ends', async () => {
    const t = setup({ turnMs: 600 })
    const first = (await t.host.open(spec('x'))) as OpenCodeHandle
    await t.host.prompt(first, '[tool:read] the task')
    const onTool = async () => {
      throw new Error('onTool threw')
    }
    expect(await failure(t.host.wait(first, waitOptions({ onTool })))).toBe('onTool threw') // the turn runs on
    const marker = join(first.directory, '.agw-location.json')
    const old = new Date(Date.now() - 3_600_000)
    utimesSync(marker, old, old)
    // A new process with a changed agent, at most one warm location, eviction after 0 ms.
    const edited = t.makeHost([{ ...AGENT, agentsMd: '# tester v2\n' }], { maxWarm: 1 })
    cleanups.push(() => edited.close())
    const retry = (await edited.open(spec('x'))) as OpenCodeHandle
    expect(retry.sessionId).toBe(first.sessionId)
    expect(retry.directory).toBe(first.directory) // the session's own, older directory
    expect(statSync(marker).mtimeMs).toBeGreaterThan(old.getTime()) // renewed for pruning
    const deletesOf = (dir: string) =>
      t.fake.urls.filter((u) => u.startsWith('DELETE') && u.includes(encodeURIComponent(dir))).length - before
    const before = 1 // the dispose before the first warm of new content
    await edited.open(spec('x', undefined, 'run-2:agent')) // warms the new directory: past maxWarm
    await Bun.sleep(20)
    await edited.maintain() // past evictAfterMs
    expect(deletesOf(first.directory)).toBe(0)
    expect(existsSync(first.directory)).toBe(true)
    expect((await edited.wait(retry, waitOptions())).output).toBe('echo: [tool:read] the task')
    await edited.maintain()
    expect(deletesOf(first.directory)).toBe(1) // released by the wait, then evicted like any idle location
  })

  test('a claimed pin outlives its lapse: the location stays in use until the wait releases it', async () => {
    const t = setup({ turnMs: 400 })
    const host = t.makeHost(undefined, {}, 50) // the lapse fires 50 ms after open
    cleanups.push(() => host.close())
    const handle = (await host.open(spec('x'))) as OpenCodeHandle
    await host.prompt(handle, 'x')
    const deletes = () => t.fake.count('DELETE /api/debug/location')
    const before = deletes()
    const waiting = host.wait(handle, waitOptions()) // claims the pin
    await Bun.sleep(150) // past the lapse, turn still running
    await host.maintain() // evictAfterMs is 0: only the wait's use keeps it
    expect(deletes()).toBe(before)
    expect(host.warmLocations()).toEqual([handle.directory])
    await waiting
    await host.maintain()
    expect(deletes()).toBe(before + 1)
  })

  test('a failed session lookup skips the prune for that tick', async () => {
    const t = setup({ turnMs: 600 })
    const first = (await t.host.open(spec('x'))) as OpenCodeHandle
    await t.host.prompt(first, 'x')
    const edited = t.makeHost([{ ...AGENT, agentsMd: '# tester v2\n' }]) // knows nothing of the old directory
    cleanups.push(() => edited.close())
    t.fake.failSessionLookups(true)
    expect(await edited.maintain()).toEqual([])
    expect(existsSync(first.directory)).toBe(true)
    expect(t.warnings).toContain('opencode session lookup failed; pruning skipped this tick')
    t.fake.failSessionLookups(false)
    await t.host.wait(first, waitOptions())
  })

  test('a handle with a missing field is refused', async () => {
    const t = setup()
    const handle = (await t.host.open(spec('x'))) as OpenCodeHandle
    const { directory: _, ...broken } = handle
    expect(await failure(t.host.wait(broken, waitOptions()))).toContain('not an OpenCode host handle')
  })

  test('a changed agent runs in a new hash directory; the old one is pruned only when nothing uses it', async () => {
    const t = setup({ turnMs: 400 })
    const old = (await t.host.open(spec('x'))) as OpenCodeHandle
    await t.host.prompt(old, 'x')
    const waiting = t.host.wait(old, waitOptions()) // a session running in the old head
    const edited = t.makeHost([{ ...AGENT, agentsMd: '# tester v2\n' }])
    cleanups.push(() => edited.close())
    const next = (await edited.open(spec('x', undefined, 'run-2:agent'))) as OpenCodeHandle
    expect(next.directory).not.toBe(old.directory)
    expect(await edited.maintain()).toEqual([]) // the old session runs: kept
    expect(existsSync(old.directory)).toBe(true)
    await waiting
    // Nothing runs there any more and retention is 0 here (default 24 h, which also covers two host processes on
    // one state dir during a deploy: each keeps only what it knows).
    expect(await edited.maintain()).toEqual([old.directory])
    expect(existsSync(next.directory)).toBe(true)
  })
})

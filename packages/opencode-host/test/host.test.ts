import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentWaitOptions, Json } from '@agent-workflows/runtime'
import { WorkflowError } from '@agent-workflows/runtime'
import {
  type AgentDefinition,
  createClient,
  type OpenCodeHandle,
  OpenCodeHost,
  type PermissionRule,
  type ServerPort,
} from '../src/index.ts'
import { sessionPermissions } from '../src/host.ts'
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

  test('the shell tool is refused unless the agent opts in; agent rules come after', async () => {
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
    const readOnly = ['read', 'glob', 'grep', 'skill'].map((action) => ({
      action,
      resource: '*',
      effect: 'allow' as const,
    }))
    expect(perms(t.fake.state.sessions[sid(plain)] as { permissions?: unknown })).toEqual([
      { action: '*', resource: '*', effect: 'deny' },
      ...readOnly,
    ])
    expect(perms(t.fake.state.sessions[sid(builder)] as { permissions?: unknown })).toEqual([
      { action: '*', resource: '*', effect: 'deny' },
      ...readOnly,
      { action: 'shell', resource: '*', effect: 'allow' },
      { action: 'edit', resource: '*', effect: 'deny' },
    ])
  })
})

describe('re-attach applies the current policy', () => {
  const OLD = [{ action: 'shell', resource: '*', effect: 'deny' }]
  const stored = (t: ReturnType<typeof setup>, handle: Json) => t.fake.state.sessions[sid(handle)]

  test('a fresh session is created with the policy and never patched', async () => {
    const t = setup()
    const handle = await t.host.open(spec('x', { allowDirectories: ['/tmp/repo'] }))
    expect(stored(t, handle)?.permissions).toEqual(sessionPermissions(AGENT, ['/tmp/repo']))
    expect(stored(t, handle)?.permissionUpdates).toBeUndefined()
  })

  test('an unprompted session made before the deploy (old, allow-all policy) gets the current one on open', async () => {
    const t = setup()
    const first = await t.host.open(spec('x', { allowDirectories: ['/tmp/repo'] }))
    ;(stored(t, first) as { permissions: unknown[] }).permissions = OLD
    const again = await t.host.open(spec('x', { allowDirectories: ['/tmp/repo'] }))
    expect(sid(again)).toBe(sid(first))
    expect(stored(t, again)?.permissions).toEqual(sessionPermissions(AGENT, ['/tmp/repo']))
    expect(stored(t, again)?.permissionUpdates).toBe(1)
  })

  test('a running session of an earlier attempt, re-attached, gets it too', async () => {
    const t = setup({ turnMs: 400 })
    const first = await t.host.open(spec('x'))
    ;(stored(t, first) as { permissions: unknown[] }).permissions = OLD
    await t.host.prompt(first, '[tool:read] the task')
    const retry = await t.host.open(spec('x'))
    expect(sid(retry)).toBe(sid(first))
    expect(stored(t, retry)?.permissions).toEqual(sessionPermissions(AGENT))
    await t.host.wait(retry, waitOptions())
  })

  test('nothing is written when the session already has the current policy', async () => {
    const t = setup()
    const first = await t.host.open(spec('x', { allowDirectories: ['/tmp/repo'] }))
    const again = await t.host.open(spec('x', { allowDirectories: ['/tmp/repo'] }))
    expect(sid(again)).toBe(sid(first))
    expect(stored(t, again)?.permissionUpdates).toBeUndefined()
    // A fresh fallback session is created with the policy: no write either.
    await t.host.prompt(first, '[balance] review this')
    await t.host.wait(first, waitOptions())
    const fallback = Object.values(t.fake.state.sessions).find((s) => s.id !== sid(first))
    expect(fallback?.permissions).toEqual(sessionPermissions(AGENT, ['/tmp/repo']))
    expect(fallback?.permissionUpdates).toBeUndefined()
  })

  test('a failed patch fails the open and gives back the warm-location pin', async () => {
    const t = setup()
    const first = await t.host.open(spec('x'))
    ;(stored(t, first) as { permissions: unknown[] }).permissions = OLD
    t.fake.failSessionPatches(true)
    expect(await failure(t.host.open(spec('x')))).toContain('PATCH')
    expect((t.host as unknown as { pins: Map<string, unknown> }).pins.size).toBe(0)
    t.fake.failSessionPatches(false)
    expect(stored(t, first)?.permissions).toEqual(OLD) // fail closed: nothing proceeded on the old rules
  })

  describe('a follow-up turn', () => {
    const turn = { runId: 'run-1', stepId: 'agent:reask', key: 'run-1:agent:reask', attempt: 1 }

    test('sets the current policy on the session it continues, once', async () => {
      const t = setup()
      const first = await t.host.open(spec('draft'))
      await t.host.prompt(first, 'draft it')
      await t.host.wait(first, waitOptions())
      ;(stored(t, first) as { permissions: unknown[] }).permissions = OLD
      const next = await t.host.followUp(first, turn)
      expect(sid(next)).toBe(sid(first))
      expect(stored(t, first)?.permissions).toEqual(sessionPermissions(AGENT))
      expect(stored(t, first)?.permissionUpdates).toBe(1)
      await t.host.followUp(first, { ...turn, attempt: 2, key: 'run-1:agent:reask:2' })
      expect(stored(t, first)?.permissionUpdates).toBe(1) // equal now: no second write
    })

    test('when it moves to the fallback session, that session gets it', async () => {
      const t = setup()
      const first = await t.host.open(spec('x', { allowDirectories: ['/tmp/repo'] }))
      await t.host.prompt(first, '[balance] review this')
      await t.host.wait(first, waitOptions())
      const fallback = Object.values(t.fake.state.sessions).find((s) => s.id !== sid(first))
      expect(fallback).toBeDefined()
      ;(fallback as { permissions: unknown[] }).permissions = OLD
      const next = (await t.host.followUp(first, turn)) as OpenCodeHandle
      expect(next.sessionId).toBe(fallback?.id as string)
      expect(fallback?.permissions).toEqual(sessionPermissions(AGENT, ['/tmp/repo']))
    })
  })
})

describe('step options', () => {
  test.each([
    ['a removed option', { repoShell: true }, '"repoShell"'],
    ['a typo', { allowDirectorys: ['/work/repo'] }, '"allowDirectorys"'],
    ['two unknown keys', { a: 1, b: 2 }, '"a", "b"'],
  ])('%s fails the step before a session exists, naming the key', async (_name, options, named) => {
    const t = setup()
    const message = await failure(t.host.open(spec('x', options)))
    expect(message).toContain('unknown option')
    expect(message).toContain(named)
    expect(Object.keys(t.fake.state.sessions)).toEqual([])
  })

  test.each([
    ['a string', 'json'],
    ['an array', ['json']],
  ])('%s is not an options object', async (_name, options) => {
    const t = setup()
    expect(await failure(t.host.open(spec('x', options as Json)))).toContain('options must be an object')
  })

  test('the known options are accepted', async () => {
    const t = setup()
    await t.host.open(spec('x', { route: 'check', output: 'json', allowDirectories: ['/tmp/repo'] }))
  })
})

describe('a handle persisted before repoShell was removed', () => {
  test('still loads, and the fallback session ignores the field', async () => {
    const t = setup()
    const fresh = (await t.host.open(spec('x', { allowDirectories: ['/tmp/repo'] }))) as OpenCodeHandle
    const handle = { ...fresh, repoShell: true } as Json
    await t.host.prompt(handle, '[balance] review this')
    expect((await t.host.wait(handle, waitOptions())).output).toBe('echo: [balance] review this')
    const [primary, fallback] = Object.values(t.fake.state.sessions)
    expect(fallback?.permissions).toEqual(sessionPermissions(AGENT, ['/tmp/repo']))
    expect(fallback?.permissions).toEqual(primary?.permissions)
    expect(JSON.stringify(fallback?.permissions)).not.toContain('git -C')
  })
})

describe('allowDirectories', () => {
  const perms = (t: ReturnType<typeof setup>, handle: Json) =>
    (t.fake.state.sessions[sid(handle)] as { permissions?: unknown }).permissions

  test('a step opens its directories for reads: external_directory allow rules after the host and agent rules', async () => {
    const t = setup({
      agents: [
        {
          name: 'tester',
          agentsMd: '# t\n',
          route: 'check',
          permissions: { rules: [{ action: 'edit', resource: '*', effect: 'deny' }] },
        },
      ],
    })
    const handle = await t.host.open(spec('x', { allowDirectories: ['/work/repo', '/work/clone/'] }))
    expect(perms(t, handle)).toEqual([
      ...sessionPermissions({ name: 'x', agentsMd: '' }),
      { action: 'edit', resource: '*', effect: 'deny' },
      { action: 'external_directory', resource: '/work/repo/*', effect: 'allow' },
      { action: 'external_directory', resource: '/work/clone/*', effect: 'allow' },
    ])
  })

  test('without the option the session gets no external_directory rule', async () => {
    const t = setup()
    const handle = await t.host.open(spec('x', { route: 'check' }))
    expect(perms(t, handle)).toEqual(sessionPermissions(AGENT))
  })

  test.each([
    ['a relative path', ['repo']],
    ['the root', ['/']],
    ['a wildcard', ['/work/*']],
    ['a parent hop', ['/work/../etc']],
    ['a non-string', [1]],
    ['a non-array', '/work'],
  ])('%s is refused before any session is created', async (_name, bad) => {
    const t = setup()
    expect(await failure(t.host.open(spec('x', { allowDirectories: bad as Json })))).toContain('allowDirectories')
    expect(Object.keys(t.fake.state.sessions)).toEqual([])
  })
})

describe('sessionPermissions', () => {
  const deny = (action: string): PermissionRule => ({ action, resource: '*', effect: 'deny' })
  const allow = (action: string): PermissionRule => ({ action, resource: '*', effect: 'allow' })
  const READ_ONLY = [allow('read'), allow('glob'), allow('grep'), allow('skill')]
  const perms = (t: ReturnType<typeof setup>, handle: Json) =>
    (t.fake.state.sessions[sid(handle)] as { permissions?: unknown }).permissions

  test('the catch-all deny comes first, then exactly the measured read-only allows', () => {
    expect(sessionPermissions(AGENT)).toEqual([deny('*'), ...READ_ONLY])
  })

  test('shell is allowed only when the agent opts in, after the read-only allows', () => {
    const rules = sessionPermissions({ ...AGENT, permissions: { shell: true } })
    expect(rules).toEqual([deny('*'), ...READ_ONLY, allow('shell')])
    expect(sessionPermissions({ ...AGENT, permissions: { shell: false } }).some((r) => r.action === 'shell')).toBe(
      false,
    )
  })

  test.each(['edit', 'webfetch', 'websearch', 'subagent', 'execute'])(
    '%s is refused by the catch-all and allowed only by the agent’s own rule, which comes after it',
    (action) => {
      const plain = sessionPermissions(AGENT)
      expect(plain.some((r) => r.action === action)).toBe(false)
      expect(plain[0]).toEqual(deny('*'))
      const opted = sessionPermissions({ ...AGENT, permissions: { rules: [allow(action)] } })
      expect(opted.findLast((r) => r.action === action || r.action === '*')).toEqual(allow(action))
      expect(opted.findIndex((r) => r.action === action)).toBeGreaterThan(0)
    },
  )

  test('the order is catch-all, read-only, shell, agent rules, external_directory', () => {
    const rules = sessionPermissions(
      { ...AGENT, permissions: { shell: true, rules: [allow('webfetch'), deny('grep')] } },
      ['/work/repo'],
    )
    expect(rules).toEqual([
      deny('*'),
      ...READ_ONLY,
      allow('shell'),
      allow('webfetch'),
      deny('grep'),
      { action: 'external_directory', resource: '/work/repo/*', effect: 'allow' },
    ])
  })

  test('a session carries the rules, and a provider-balance fallback session the same ones', async () => {
    const t = setup({
      agents: [{ ...AGENT, permissions: { rules: [allow('webfetch')] } }],
    })
    const handle = await t.host.open(spec('x', { allowDirectories: ['/tmp/repo'] }))
    expect(perms(t, handle)).toEqual(
      sessionPermissions({ ...AGENT, permissions: { rules: [allow('webfetch')] } }, ['/tmp/repo']),
    )
    await t.host.prompt(handle, '[balance] review this')
    await t.host.wait(handle, waitOptions())
    const [primary, fallback] = Object.values(t.fake.state.sessions)
    expect(fallback?.permissions).toEqual(primary?.permissions)
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

  test('a handle with a missing or mistyped field is refused', async () => {
    const t = setup()
    const handle = (await t.host.open(spec('x'))) as OpenCodeHandle
    const { directory: _, ...broken } = handle
    for (const bad of [broken, { ...handle, model: 7 }, { ...handle, output: 'yaml' }]) {
      expect(await failure(t.host.wait(bad as Json, waitOptions()))).toContain('not an OpenCode host handle')
    }
  })

  test('a lookup that rejects with a non-Error still skips the prune', async () => {
    const t = setup({ turnMs: 600 })
    const first = (await t.host.open(spec('x'))) as OpenCodeHandle
    await t.host.prompt(first, 'x')
    const edited = t.makeHost([{ ...AGENT, agentsMd: '# tester v2\n' }])
    cleanups.push(() => edited.close())
    // The client normally throws Errors; force the odd case through the private client.
    const client = (edited as unknown as { client: { getSession: () => Promise<never> } }).client
    client.getSession = () => Promise.reject('not an error')
    expect(await edited.maintain()).toEqual([])
    expect(existsSync(first.directory)).toBe(true)
    expect(t.warnings).toContain('opencode session lookup failed; pruning skipped this tick')
    await t.host.wait(first, waitOptions())
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

describe('provider-balance fallback', () => {
  const sessions = (t: ReturnType<typeof setup>) => Object.values(t.fake.state.sessions)

  test('a turn refused for balance reopens the step on the fallback route once; usage is the fallback’s', async () => {
    const t = setup()
    const handle = await t.host.open(spec('x', { allowDirectories: ['/tmp/repo'] }))
    await t.host.prompt(handle, '[balance] review this')
    const result = await t.host.wait(handle, waitOptions())
    expect(result.output).toBe('echo: [balance] review this')

    const [primary, fallback] = sessions(t)
    expect(primary?.model.providerID).not.toBe('iu-responses')
    expect(fallback?.model).toMatchObject({ providerID: 'iu-responses', variant: 'medium' })
    expect(fallback?.directory).toBe(primary?.directory)
    // The same permissions, the step's directories included.
    expect(fallback?.permissions).toEqual(primary?.permissions)
    expect(fallback?.messages.filter((m) => m.type === 'user')).toHaveLength(1)
    expect(result.usage?.model).toBe(fallback?.model.id)
    expect(t.warnings).toContain('opencode turn failed on provider balance; falling back')
  })

  test('re-attach after a crash finds the fallback session: no second session, no second prompt', async () => {
    const t = setup({ turnMs: 300 })
    const handle = await t.host.open(spec('x'))
    await t.host.prompt(handle, '[balance] once')
    const controller = new AbortController()
    const first = t.host.wait(handle, waitOptions({ signal: controller.signal }))
    // Abort once the fallback session exists, as a crashed process would stop waiting.
    while (sessions(t).length < 2) await Bun.sleep(10)
    controller.abort(new Error('crash'))
    await first.catch(() => {})
    const again = t.makeHost()
    cleanups.push(() => again.close())
    expect((await again.wait(handle, waitOptions())).output).toBe('echo: [balance] once')
    expect(sessions(t)).toHaveLength(2)
    const fallbackId = sessions(t)[1]?.id as string
    expect(t.fake.count(`POST /api/session/${fallbackId}/prompt`)).toBe(1)
  })

  test('the fallback failing on balance too fails the step with the balance error; no third session', async () => {
    const t = setup()
    const handle = await t.host.open(spec('x'))
    await t.host.prompt(handle, '[balance-all] x')
    expect(await failure(t.host.wait(handle, waitOptions()))).toContain('Insufficient Balance')
    expect(sessions(t)).toHaveLength(2)
  })

  test('a turn that ran before the balance refusal is never prompted again', async () => {
    const t = setup()
    const handle = await t.host.open(spec('x'))
    await t.host.prompt(handle, '[tool:read][balance] x')
    expect(await failure(t.host.wait(handle, waitOptions()))).toContain('Insufficient Balance')
    expect(sessions(t)).toHaveLength(1)
    expect(t.warnings).toContain('opencode turn failed on provider balance after it ran; no fallback')
  })

  test('any other failure keeps today’s behaviour', async () => {
    const t = setup()
    const handle = await t.host.open(spec('x'))
    await t.host.prompt(handle, '[fail]')
    expect(await failure(t.host.wait(handle, waitOptions()))).toContain('provider said no')
    expect(sessions(t)).toHaveLength(1)
  })

  test('AGW_ROUTES without a fallback for the route: the balance error fails the step', async () => {
    const t = setup({ env: { AGW_ROUTES: JSON.stringify({ check: { fallback: null } }) } })
    const handle = await t.host.open(spec('x'))
    await t.host.prompt(handle, '[balance] x')
    expect(await failure(t.host.wait(handle, waitOptions()))).toContain('Insufficient Balance')
    expect(sessions(t)).toHaveLength(1)
  })

  test('a retry while the fallback session still runs re-attaches to it: no new session, no second prompt', async () => {
    const t = setup()
    const first = await t.host.open(spec('x'))
    await t.host.prompt(first, '[balance][slow:600] the task')
    // The attempt's wait fails while the fallback turn goes on server-side (a throwing onTool, say).
    const controller = new AbortController()
    const waiting = t.host.wait(first, waitOptions({ signal: controller.signal }))
    while (sessions(t).length < 2) await Bun.sleep(10)
    controller.abort(new Error('the wait failed'))
    await waiting.catch(() => {})
    const fallbackId = sessions(t)[1]?.id as string

    const retry = await t.host.open(spec('x'))
    expect(sid(retry)).toBe(sid(first))
    expect(t.warnings).toContain('opencode fallback session of an earlier attempt still runs; re-attaching')
    await t.host.prompt(retry, '[balance][slow:600] the task') // a no-op: the primary holds its prompt
    expect((await t.host.wait(retry, waitOptions())).output).toBe('echo: [balance][slow:600] the task')
    expect(sessions(t)).toHaveLength(2)
    expect(t.fake.count(`POST /api/session/${sid(first)}/prompt`)).toBe(1)
    expect(t.fake.count(`POST /api/session/${fallbackId}/prompt`)).toBe(1)
  })

  test('abort interrupts the fallback even when the primary’s interrupt fails, then raises', async () => {
    const t = setup()
    const handle = await t.host.open(spec('x'))
    await t.host.prompt(handle, '[balance][slow:1500] long')
    const controller = new AbortController()
    const waiting = t.host.wait(handle, waitOptions({ signal: controller.signal }))
    // The fallback turn is running.
    while (!sessions(t)[1]?.messages.some((m) => m.type === 'assistant')) await Bun.sleep(10)
    t.fake.failInterruptFor(sid(handle))
    expect(await failure(t.host.abort(handle))).toContain('HTTP 500')
    controller.abort(new Error('cancel'))
    await waiting.catch(() => {})
    const fallbackId = sessions(t)[1]?.id as string
    expect(t.fake.count(`POST /api/session/${fallbackId}/interrupt`)).toBe(1)
    expect(sessions(t)[1]?.messages.at(-1)).toMatchObject({ type: 'idle', outcome: 'interrupted' })
  })

  test('abort reaches the fallback session through the step’s first handle', async () => {
    const t = setup()
    const handle = await t.host.open(spec('x'))
    await t.host.prompt(handle, '[balance][slow:1500] long')
    const controller = new AbortController()
    const waiting = t.host.wait(handle, waitOptions({ signal: controller.signal }))
    while (sessions(t).length < 2) await Bun.sleep(10)
    await t.host.abort(handle)
    controller.abort(new Error('cancel'))
    await waiting.catch(() => {})
    const fallbackId = sessions(t)[1]?.id as string
    expect(t.fake.count(`POST /api/session/${fallbackId}/interrupt`)).toBe(1)
  })
})

describe('followUp (ctx.continue)', () => {
  const turn = (key = 'run-1:agent:reask', attempt = 1) => ({ runId: 'run-1', stepId: 'agent:reask', key, attempt })

  test('a follow-up turn runs in the same session; wait answers with that turn only', async () => {
    const t = setup()
    const first = await t.host.open(spec('draft'))
    await t.host.prompt(first, 'draft it')
    expect((await t.host.wait(first, waitOptions())).output).toBe('echo: draft it')

    const next = await t.host.followUp(first, turn())
    expect(next).toMatchObject({ sessionId: sid(first), stepId: 'agent:reask', turn: 'run-1:agent:reask#1' })
    expect(JSON.parse(JSON.stringify(next))).toEqual(next)
    await t.host.prompt(next, 'fix the title')
    await t.host.prompt(next, 'fix the title') // idempotent: read first, deduped by id
    const result = await t.host.wait(next, waitOptions())
    expect(result.output).toBe('echo: fix the title')
    // Only the turn's assistant message is counted, not the first turn's.
    expect(result.usage?.tokens).toEqual({ input: 130, output: 6, cacheRead: 100, cacheWrite: 20, reasoning: 1 })
    expect(result.usage?.cost).toBe(0.001)
    expect(Object.keys(t.fake.state.sessions)).toEqual([sid(first)])
    const users = await userMessages(t, first)
    expect(users.map((m) => m.metadata?.agw?.kind)).toEqual(['prompt', 'followup'])
  })

  test('a retried continue (next attempt) sends a new turn instead of re-reading the old one', async () => {
    const t = setup()
    const first = await t.host.open(spec('draft'))
    await t.host.prompt(first, 'draft it')
    await t.host.wait(first, waitOptions())
    const one = await t.host.followUp(first, turn('run-1:agent:reask', 1))
    await t.host.prompt(one, '[fail] try')
    expect(await failure(t.host.wait(one, waitOptions()))).toContain('provider said no')
    const two = await t.host.followUp(first, turn('run-1:agent:reask', 2))
    await t.host.prompt(two, 'try again')
    expect((await t.host.wait(two, waitOptions())).output).toBe('echo: try again')
    expect(await userMessages(t, first)).toHaveLength(3)
  })

  test('a turn cut off by a server restart is resumed and finishes', async () => {
    const t = setup({ turnMs: 300 })
    const first = await t.host.open(spec('draft'))
    await t.host.prompt(first, 'draft it')
    await t.host.wait(first, waitOptions())
    const next = await t.host.followUp(first, turn())
    await t.host.prompt(next, 'more')
    await Bun.sleep(100)
    t.kill()
    t.boot()
    expect((await t.host.wait(next, waitOptions())).output).toMatch(/^resumed: echo: /)
  })

  test('a step that moved to its fallback session continues there', async () => {
    const t = setup()
    const first = await t.host.open(spec('x'))
    await t.host.prompt(first, '[balance] review this')
    await t.host.wait(first, waitOptions())
    const next = (await t.host.followUp(first, turn())) as OpenCodeHandle
    expect(next.fallback).toBe(true)
    expect(next.sessionId).not.toBe(sid(first))
    await t.host.prompt(next, 'and the tests')
    expect((await t.host.wait(next, waitOptions())).output).toBe('echo: and the tests')
  })

  test('a gone session cannot be continued', async () => {
    const t = setup()
    const handle = { ...((await t.host.open(spec('x'))) as OpenCodeHandle), sessionId: 'ses_agw_missing' }
    expect(await failure(t.host.followUp(handle, turn()))).toContain('is gone')
  })
})

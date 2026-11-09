import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BALANCE_MARKER, fallbackRoute, isBalanceFailure, type Rate, resolveRoute } from '@agent-workflows/routes'
import type { AgentWaitOptions, Arm, Json, Usage } from '@agent-workflows/runtime'
import { Cancelled, WorkflowError } from '@agent-workflows/runtime'
import {
  type AgentDefinition,
  createClient,
  type Message,
  type OpenCodeHandle,
  OpenCodeHost,
  type PermissionRule,
  type ServerPort,
} from '../src/index.ts'
import { isCompactionFailure, onlyReadOnlyTools, priceOpenCodeMessages, sessionPermissions } from '../src/host.ts'
import { sessionState } from '../src/session.ts'
import { type FakeServer, startFake } from '@agent-workflows/testing/opencode'
import { attributionOf } from './attribution.ts'

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

/** `check` as the table has it: the host tests price with its rate (Haiku 5.5, a long-prompt tier) and its fallback. */
const CHECK = resolveRoute('check')
const RATE = CHECK.rate as Rate
const TIER = RATE.longPrompt as { inputMultiplier: number; outputMultiplier: number }

function setup(
  options: {
    turnMs?: number
    agents?: AgentDefinition[]
    traceparent?: (runId: string, stepId: string) => string | undefined
  } = {},
) {
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
      ...(options.traceparent ? { traceparent: options.traceparent } : {}),
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
  attribution: attributionOf('run-1', 'agent'),
  ...(options === undefined ? {} : { options }),
})

function waitOptions(over: Partial<AgentWaitOptions> = {}): AgentWaitOptions {
  return { signal: new AbortController().signal, onProgress: () => {}, onTool: async () => {}, ...over }
}

/** The one report of a step that ran on one session; a step that moved between sessions reports several. */
const one = (usage: Usage | Usage[] | undefined): Usage | undefined => {
  const all = [usage ?? []].flat()
  expect(all.length).toBeLessThanOrEqual(1)
  return all[0]
}

const sid = (handle: Json) => (handle as OpenCodeHandle).sessionId
const userMessages = async (t: ReturnType<typeof setup>, handle: Json) =>
  (await t.client.messages(sid(handle))).filter((m) => m.type === 'user')

/** Polls a condition on a short tick; the condition, not a duration, decides when the test goes on. */
async function until(check: () => boolean | Promise<boolean>, label: string, ms = 10_000) {
  const deadline = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await Bun.sleep(10)
  }
}

/** `host.wait` reads the session's messages on every poll: once the fake has seen one more, the wait is in flight. */
const messageReads = (t: ReturnType<typeof setup>, handle: Json) =>
  t.fake.count(`GET /api/session/${sid(handle)}/message`)
const waitPolling = (t: ReturnType<typeof setup>, handle: Json, since: number) =>
  until(() => messageReads(t, handle) > since, 'the wait polling the session')

describe('open / prompt / wait', () => {
  test('a turn returns the final text and usage from the messages', async () => {
    const t = setup()
    const handle = await t.host.open(spec('hello'))
    expect(handle).toMatchObject({ v: 1, agent: 'tester', route: 'check', output: 'text', runId: 'run-1' })
    expect(JSON.parse(JSON.stringify(handle))).toEqual(handle)
    await t.host.prompt(handle, 'hello')
    const result = await t.host.wait(handle, waitOptions())
    expect(result.output).toBe('echo: hello')
    expect(one(result.usage)?.tokens).toEqual({ input: 130, output: 6, cacheRead: 100, cacheWrite: 20, reasoning: 1 })
    expect(one(result.usage)?.cost).toBe(0.001)
    expect(one(result.usage)?.costSource).toBe('provider')
    // The step's route id, for the journal's `steps.route`.
    expect(one(result.usage)?.route).toBe('check')
  })

  test('a wait reports the session spend so far while it polls: a snapshot, not a delta', async () => {
    const t = setup()
    const handle = await t.host.open(spec('hello'))
    await t.host.prompt(handle, 'hello')
    const snapshots: Usage[] = []
    const result = await t.host.wait(handle, waitOptions({ onUsage: (usage) => snapshots.push(usage) }))
    expect(snapshots.length).toBeGreaterThanOrEqual(1)
    expect(snapshots.at(-1)?.tokens).toEqual(one(result.usage)?.tokens as Usage['tokens'])
    expect(snapshots.at(-1)?.cost).toBe(one(result.usage)?.cost)
  })

  test('a throwing usage listener never fails the wait', async () => {
    const t = setup()
    const handle = await t.host.open(spec('hello'))
    await t.host.prompt(handle, 'hello')
    const result = await t.host.wait(
      handle,
      waitOptions({
        onUsage: () => {
          throw new Error('listener broke')
        },
      }),
    )
    expect(result.output).toBe('echo: hello')
    expect(t.warnings).toContain('opencode live usage report failed')
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
    const usage = one((await t.host.wait(handle, waitOptions())).usage)
    expect(usage?.costSource).toBe('rate')
    // 10 input, 100 cache read, 20 cache write, 6 output at the route's rate.
    const { inputPerM, outputPerM, cacheReadPerM = 0, cacheWritePerM = 0 } = RATE
    expect(usage?.cost).toBeCloseTo(
      (10 * inputPerM + 100 * cacheReadPerM + 20 * cacheWritePerM + 6 * outputPerM) / 1e6,
      12,
    )
  })

  // Haiku 5.5: 5x on every column for a prompt over 100K tokens; the tier is per message, not per step.
  const HAIKU_LONG =
    ((150_000 * RATE.inputPerM + 100 * (RATE.cacheReadPerM ?? 0) + 20 * (RATE.cacheWritePerM ?? 0)) *
      TIER.inputMultiplier +
      6 * RATE.outputPerM * TIER.outputMultiplier) /
    1e6

  test('a message above the long-prompt tier is priced at the tier, not at the cost OpenCode reported', async () => {
    const t = setup()
    const handle = await t.host.open(spec('x'))
    await t.host.prompt(handle, '[long] x')
    const usage = one((await t.host.wait(handle, waitOptions())).usage)
    expect(usage?.costSource).toBe('rate')
    expect(usage?.cost).toBeCloseTo(HAIKU_LONG, 12)
  })

  test('one long message does not void a step: the short messages keep the cost OpenCode reported', async () => {
    const t = setup()
    const handle = await t.host.open(spec('x'))
    await t.host.prompt(handle, '[tool:read] [long] x')
    const usage = one((await t.host.wait(handle, waitOptions())).usage)
    expect(usage?.costSource).toBe('rate')
    expect(usage?.cost).toBeCloseTo(0.001 + HAIKU_LONG, 12)
  })

  test('a long message OpenCode reported at 0 is priced at the tier too', async () => {
    const t = setup()
    const handle = await t.host.open(spec('x'))
    await t.host.prompt(handle, '[free] [long] x')
    expect(one((await t.host.wait(handle, waitOptions())).usage)?.cost).toBeCloseTo(HAIKU_LONG, 12)
  })

  // A rate without a tier, priced directly: no opencode route of the table has one, and an arm cannot patch a rate there.
  const FLAT = { inputPerM: 0.1, outputPerM: 0.5, cacheReadPerM: 0.01, cacheWritePerM: 0.125 }
  const longMessage = (cost: number) =>
    ({
      type: 'assistant',
      tokens: { input: 150_000, output: 6, reasoning: 0, cache: { read: 100, write: 20 } },
      cost,
    }) as never

  test('a long message on a rate without a tier keeps the cost OpenCode reported', () => {
    expect(priceOpenCodeMessages([longMessage(0.001)], FLAT)).toEqual({ cost: 0.001, byRate: false })
  })

  test('a long message on a rate without a tier that OpenCode reported at 0 is priced flat, at any size', () => {
    const priced = priceOpenCodeMessages([longMessage(0)], FLAT)
    expect(priced?.byRate).toBe(true)
    expect(priced?.cost).toBeCloseTo((150_000 * 0.1 + 100 * 0.01 + 20 * 0.125 + 6 * 0.5) / 1e6, 12)
  })

  test('cost 0 without a rate is unpriced, never 0', () => {
    expect(priceOpenCodeMessages([longMessage(0)], null)).toBeNull()
  })

  test("an armed step opens its session on the arm's effort and model, and its handle keeps the patch", async () => {
    const t = setup()
    const arm: Arm = { routes: { check: { effort: 'low' } } }
    const handle = await t.host.open({ ...spec('x'), arm })
    expect((handle as OpenCodeHandle).patch).toEqual({ effort: 'low' })
    const unarmed = await t.host.open(spec('y', undefined, 'run-1:other'))
    const [armed, plain] = Object.values(t.fake.state.sessions)
    expect(armed?.model).toMatchObject({ id: CHECK.model, variant: 'low' })
    expect(plain?.model).toMatchObject({ id: CHECK.model, variant: CHECK.effort as string })
    expect((unarmed as OpenCodeHandle).patch).toBeUndefined()
    const sonnet = resolveRoute('retro.analyze').model
    await t.host.open({
      ...spec('z', undefined, 'run-1:sonnet'),
      arm: { routes: { check: { model: sonnet, effort: 'max' } } },
    })
    expect(Object.values(t.fake.state.sessions)[2]?.model).toMatchObject({ id: sonnet, variant: 'max' })
  })

  test('an armed step on a model the server does not serve is refused at open, naming the route and the model', async () => {
    const t = setup()
    // A table model only single calls use (the cheap seat's fallback): named by the table, not served by OpenCode.
    const callOnly = resolveRoute('cheap.classify').fallback?.model as string
    const arm: Arm = { routes: { check: { model: callOnly } } }
    expect(await failure(t.host.open({ ...spec('x'), arm }))).toContain(
      `route "check": model "${callOnly}" is not served`,
    )
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

describe('attribution in metadata.agw', () => {
  const stored = (t: ReturnType<typeof setup>, sessionId: string) =>
    t.fake.state.sessions[sessionId]?.metadata?.agw as Record<string, unknown> | undefined
  const { traceparent: _, ...ATTRIBUTION } = attributionOf('run-1', 'agent')

  test("open writes the step's attribution beside the host's own fields, under its own names", async () => {
    const t = setup()
    const handle = await t.host.open(spec('x'))
    expect(stored(t, sid(handle))).toMatchObject({ agent: 'tester', route: 'check', ...ATTRIBUTION })
  })

  test('no traceparent is stored, and a new one costs no PATCH', async () => {
    const t = setup()
    const handle = await t.host.open(spec('x'))
    expect(stored(t, sid(handle))?.traceparent).toBeUndefined()
    expect((handle as OpenCodeHandle).attribution?.step).toBe('agent')
    expect((handle as Record<string, unknown>).attribution).not.toHaveProperty('traceparent')
    const again = spec('x')
    await t.host.open({
      ...again,
      attribution: { ...again.attribution, traceparent: '00-33333333333333333333333333333333-4444444444444444-01' },
    })
    expect(t.fake.urls.filter((url) => url.startsWith('PATCH'))).toEqual([])
  })

  test('a provider-balance fallback session carries it too, from the journaled handle', async () => {
    const t = setup()
    const handle = JSON.parse(JSON.stringify(await t.host.open(spec('x')))) as Json
    await t.host.prompt(handle, '[balance] review this')
    await t.host.wait(handle, waitOptions())
    const fallback = Object.keys(t.fake.state.sessions).find((id) => id !== sid(handle)) as string
    expect(stored(t, fallback)).toMatchObject({ fallbackOf: sid(handle), ...ATTRIBUTION })
  })

  test('after a provider-balance fallback the live usage still holds the failed primary turn', async () => {
    const t = setup()
    const handle = JSON.parse(JSON.stringify(await t.host.open(spec('x')))) as Json
    await t.host.prompt(handle, '[balance] review this')
    const snapshots: Usage[] = []
    const result = await t.host.wait(handle, waitOptions({ onUsage: (usage) => snapshots.push(usage) }))
    const reports = [result.usage ?? []].flat()
    const sum = (pick: (u: Usage) => number) => reports.reduce((n, u) => n + pick(u), 0)
    expect(snapshots.length).toBeGreaterThanOrEqual(1)
    expect(snapshots.at(-1)?.tokens.input).toBe(sum((u) => u.tokens.input))
    expect(snapshots.at(-1)?.tokens.output).toBe(sum((u) => u.tokens.output))
    expect(snapshots.at(-1)?.cost).toBeCloseTo(
      sum((u) => u.cost ?? 0),
      9,
    )
  })

  test('origin rides with the run; only the fallback session names a refusal, as unknown, on its follow-up turn too', async () => {
    const t = setup()
    const handle = JSON.parse(JSON.stringify(await t.host.open(spec('x')))) as Json
    expect(stored(t, sid(handle))).toMatchObject({ origin: 'claude-code' })
    expect(stored(t, sid(handle))).not.toHaveProperty('routeFallback')
    await t.host.prompt(handle, '[balance] review this')
    await t.host.wait(handle, waitOptions())
    const fallback = Object.keys(t.fake.state.sessions).find((id) => id !== sid(handle)) as string
    expect(stored(t, sid(handle))).not.toHaveProperty('routeFallback')
    expect(stored(t, fallback)).toMatchObject({ origin: 'claude-code', routeFallback: 'unknown' })
    // The turn after it runs on the fallback session still: the marker is not rewritten away.
    const turn = {
      runId: 'run-1',
      stepId: 'reask',
      key: 'run-1:reask',
      attempt: 1,
      attribution: attributionOf('run-1', 'reask'),
    }
    const next = (await t.host.followUp(handle, turn)) as OpenCodeHandle
    expect(next.sessionId).toBe(fallback)
    expect(stored(t, fallback)).toMatchObject({ step: 'reask', origin: 'claude-code', routeFallback: 'unknown' })
  })

  test('a handle from before the deploy holds none: its fallback session carries the run and step', async () => {
    const t = setup()
    const { attribution: _, ...old } = (await t.host.open(spec('x'))) as OpenCodeHandle
    await t.host.prompt(old, '[balance] review this')
    await t.host.wait(old, waitOptions())
    const fallback = Object.keys(t.fake.state.sessions).find((id) => id !== old.sessionId) as string
    expect(stored(t, fallback)).toMatchObject({ runId: 'run-1', step: 'agent' })
    expect(stored(t, fallback)?.rootId).toBeUndefined()
  })

  test('a follow-up turn moves the session to the continuing step, keeps the rest, and costs one write', async () => {
    const t = setup()
    const first = await t.host.open(spec('draft'))
    await t.host.prompt(first, 'draft it')
    await t.host.wait(first, waitOptions())
    const attribution = attributionOf('run-1', 'reask')
    const turn = { runId: 'run-1', stepId: 'reask', key: 'run-1:reask', attempt: 1, attribution }
    const next = (await t.host.followUp(first, turn)) as OpenCodeHandle
    expect(next.attribution).toEqual({ ...ATTRIBUTION, step: 'reask' })
    expect(stored(t, sid(first))).toMatchObject({ agent: 'tester', route: 'check', ...ATTRIBUTION, step: 'reask' })
    expect(t.fake.state.sessions[sid(first)]?.permissionUpdates).toBeUndefined()
    const patched = t.fake.state.sessions[sid(first)]?.metadata
    await t.host.followUp(first, { ...turn, attempt: 2 })
    expect(t.fake.state.sessions[sid(first)]?.metadata).toEqual(patched as Record<string, unknown>)
  })

  test('a field the continuing step lacks does not stay from the step before', async () => {
    const t = setup()
    const first = await t.host.open(spec('draft'))
    await t.host.prompt(first, 'draft it')
    await t.host.wait(first, waitOptions())
    const { project: _p, workspace: _w, ...attribution } = attributionOf('run-1', 'agent')
    await t.host.followUp(first, { runId: 'run-1', stepId: 'agent', key: 'run-1:agent', attempt: 1, attribution })
    const agw = stored(t, sid(first))
    expect(agw).toMatchObject({ agent: 'tester', route: 'check', runId: 'run-1', step: 'agent' })
    expect(agw).not.toHaveProperty('project')
    expect(agw).not.toHaveProperty('workspace')
  })

  test('an unprompted session from before the deploy gets it on open', async () => {
    const t = setup()
    const handle = await t.host.open(spec('x'))
    const session = t.fake.state.sessions[sid(handle)] as { metadata?: Record<string, unknown> }
    session.metadata = { agw: { key: 'kept', agent: 'tester' } }
    await t.host.open(spec('x'))
    expect(stored(t, sid(handle))).toMatchObject({ key: 'kept', agent: 'tester', ...ATTRIBUTION })
  })
})

describe("the gateway's refusal, as a session reports it", () => {
  // Captured from the pinned 2.0.32 serving `x-agw-fallback: none`'s 402 (`test/live-gateway.test.ts`).
  const CAPTURED = {
    type: 'provider.quota',
    message: 'provider balance exhausted: no credit pool eligible',
    status: 402,
    response: {
      body: '{"type":"error","error":{"type":"balance_error","message":"provider balance exhausted: no credit pool eligible"}}',
    },
  }

  test("the turn error OpenCode keeps is the classifier's input", () => {
    expect(CAPTURED.message).toStartWith(BALANCE_MARKER)
    const state = sessionState(
      [
        { id: 'p', type: 'user', metadata: { agw: { kind: 'prompt' } } },
        { id: 'i', type: 'idle', outcome: 'failed', error: CAPTURED },
      ],
      { promptId: 'p', active: false, pending: false },
    )
    expect(state).toMatchObject({ kind: 'done', outcome: 'failed', error: CAPTURED.message })
    expect(isBalanceFailure({ text: (state as { error: string }).error })).toBe(true)
  })
})

describe('onlyReadOnlyTools', () => {
  const prompt = { id: 'p', type: 'user', metadata: { agw: { kind: 'prompt' } } }
  const turn = (...parts: Record<string, unknown>[]) =>
    [prompt, { id: 'a1', type: 'assistant', content: parts }] as never[]
  const call = (name: string | undefined, id: string | null = `call-${name}`) => ({
    type: 'tool',
    ...(id === null ? {} : { id }),
    ...(name === undefined ? {} : { name }),
  })

  test('the host’s read tools and no tool at all qualify', () => {
    expect(onlyReadOnlyTools(turn(), 'p')).toBe(true)
    expect(onlyReadOnlyTools(turn({ type: 'text', text: 'hi' }), 'p')).toBe(true)
    expect(onlyReadOnlyTools(turn(call('read'), call('glob'), call('grep'), call('skill')), 'p')).toBe(true)
  })

  test('any other tool counts as a change', () => {
    for (const name of ['shell', 'edit', 'write', 'webfetch', 'websearch', 'subagent', 'submit_result', 'mcp_x']) {
      expect(onlyReadOnlyTools(turn(call('read'), call(name)), 'p')).toBe(false)
    }
  })

  test('fails safe: a tool part without a name or an id counts as a change', () => {
    expect(onlyReadOnlyTools(turn(call(undefined, 'call-1')), 'p')).toBe(false)
    expect(onlyReadOnlyTools(turn(call('read', null)), 'p')).toBe(false)
    expect(onlyReadOnlyTools(turn(call('read', '')), 'p')).toBe(false)
    expect(onlyReadOnlyTools(turn(call('read'), call('', 'call-2')), 'p')).toBe(false)
  })

  test('fails safe: a prompt that is not in the messages decides nothing', () => {
    expect(onlyReadOnlyTools([{ id: 'a1', type: 'assistant', content: [] }] as never[], 'p')).toBe(false)
  })

  test('only the turn after the prompt counts', () => {
    const before = { id: 'a0', type: 'assistant', content: [call('shell')] }
    expect(onlyReadOnlyTools([before, ...turn(call('read'))] as never[], 'p')).toBe(true)
  })
})

describe('isCompactionFailure', () => {
  test('the summary failures of OpenCode 2.0.32 are compaction failures, the rest of a turn error is not', () => {
    for (const text of [
      'Compaction summary reached the output token limit',
      'Compaction summary was blocked by the provider',
      'Compaction summary did not match the required template',
      'Compaction produced no summary',
      'opencode session ses_1 turn failed: Compaction summary reached the output token limit',
    ]) {
      expect(isCompactionFailure(text)).toBe(true)
    }
    for (const text of [
      'Nothing to compact yet',
      'provider said no',
      'provider balance exhausted: no credit pool eligible',
      '',
    ]) {
      expect(isCompactionFailure(text)).toBe(false)
    }
  })
})

describe('re-attach applies the current policy', () => {
  const OLD = [{ action: 'shell', resource: '*', effect: 'deny' }]
  const stored = (t: ReturnType<typeof setup>, handle: Json) => t.fake.state.sessions[sid(handle)]

  test('a fresh session is created with the policy and never patched', async () => {
    const t = setup()
    const handle = await t.host.open(spec('x', { allowDirectories: ['/tmp/repo'] }))
    expect(stored(t, handle)?.permissions).toEqual(sessionPermissions(AGENT, { allowDirectories: ['/tmp/repo'] }))
    expect(stored(t, handle)?.permissionUpdates).toBeUndefined()
  })

  test('an unprompted session made before the deploy (old, allow-all policy) gets the current one on open', async () => {
    const t = setup()
    const first = await t.host.open(spec('x', { allowDirectories: ['/tmp/repo'] }))
    ;(stored(t, first) as { permissions: unknown[] }).permissions = OLD
    const again = await t.host.open(spec('x', { allowDirectories: ['/tmp/repo'] }))
    expect(sid(again)).toBe(sid(first))
    expect(stored(t, again)?.permissions).toEqual(sessionPermissions(AGENT, { allowDirectories: ['/tmp/repo'] }))
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
    expect(fallback?.permissions).toEqual(sessionPermissions(AGENT, { allowDirectories: ['/tmp/repo'] }))
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
    const turn = {
      runId: 'run-1',
      stepId: 'agent:reask',
      key: 'run-1:agent:reask',
      attempt: 1,
      attribution: attributionOf('run-1', 'agent:reask'),
    }

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
      expect(fallback?.permissions).toEqual(sessionPermissions(AGENT, { allowDirectories: ['/tmp/repo'] }))
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
    await t.host.open({
      ...spec('x', { route: 'check', output: 'json', allowDirectories: ['/tmp/repo'] }),
      schema: SCHEMA,
    })
  })
})

/** What `z.toJSONSchema(z.object({ ok: z.boolean(), inputs: z.number() }), { io: 'input' })` gives. */
const SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: { ok: { type: 'boolean' }, inputs: { type: 'number' } },
  required: ['ok', 'inputs'],
} satisfies Json

describe('structured output (submit_result)', () => {
  /** `schema: null` opens the step without one. */
  const jsonSpec = (prompt: string, schema: Json = SCHEMA) => ({
    ...spec(prompt, { output: 'json' }),
    ...(schema === null ? {} : { schema }),
  })
  const location = (handle: Json) => (handle as OpenCodeHandle).directory
  const plugin = (handle: Json) => join(location(handle), '.opencode', 'plugins', 'agw-result.js')
  const RESULT_RULE: PermissionRule = { action: 'submit_result', resource: '*', effect: 'allow' }

  test("the step's schema is the result tool's input: a plugin in the location, named in AGENTS.md, allowed", async () => {
    const t = setup()
    const handle = await t.host.open(jsonSpec('x'))
    const source = readFileSync(plugin(handle), 'utf8')
    const { $schema: _, ...offered } = SCHEMA
    expect(source).toContain(`const INPUT = ${JSON.stringify(offered)}\n`)
    expect(source).toContain('name: "submit_result"')
    expect(source).not.toContain('$schema')
    expect(readFileSync(join(location(handle), 'AGENTS.md'), 'utf8')).toContain('calling the `submit_result` tool')
    expect(t.fake.state.sessions[sid(handle)]?.permissions).toEqual(sessionPermissions(AGENT, { resultTool: true }))
    expect(sessionPermissions(AGENT, { resultTool: true })).toContainEqual(RESULT_RULE)
    expect((handle as OpenCodeHandle).result).toEqual({ digest: expect.stringMatching(/^[0-9a-f]{16}$/) })
  })

  test('a JSON handle without the marker (opened before the deploy) fails its wait, naming why', async () => {
    const t = setup()
    const { result: _, ...old } = (await t.host.open(jsonSpec('x'))) as OpenCodeHandle
    const message = await failure(t.host.wait(old, waitOptions()))
    expect(message).toContain('a JSON step opened before the submit_result tool was deployed')
    expect(message).toContain('agent "tester"')
    expect(await userMessages(t, old)).toHaveLength(0) // failed before anything was read or sent
  })

  test("a text step's location has no result tool and its session no rule for it", async () => {
    const t = setup()
    const text = await t.host.open(spec('x'))
    expect(existsSync(plugin(text))).toBe(false)
    expect(JSON.stringify(t.fake.state.sessions[sid(text)]?.permissions)).not.toContain('submit_result')
  })

  test('the output is the input of the completed submit_result call, not the text after it', async () => {
    const t = setup()
    const handle = await t.host.open(jsonSpec('x'))
    await t.host.prompt(handle, '[result] give me data')
    const result = await t.host.wait(handle, waitOptions())
    expect(result.output).toEqual({ ok: true, inputs: 1 })
    expect(one(result.usage)?.cost).toBeCloseTo(0.002, 6) // both messages of the turn
  })

  test('a follow-up turn answers through the same tool, read from its own turn only', async () => {
    const t = setup()
    const first = await t.host.open(jsonSpec('x'))
    await t.host.prompt(first, '[result] draft')
    expect((await t.host.wait(first, waitOptions())).output).toEqual({ ok: true, inputs: 1 })
    const attribution = attributionOf('run-1', 'reask')
    const next = await t.host.followUp(first, {
      runId: 'run-1',
      stepId: 'reask',
      key: 'run-1:reask',
      attempt: 1,
      attribution,
      schema: SCHEMA,
    })
    expect(t.fake.state.sessions[sid(first)]?.permissions).toContainEqual(RESULT_RULE)
    await t.host.prompt(next, '[result] again')
    expect((await t.host.wait(next, waitOptions())).output).toEqual({ ok: true, inputs: 2 })

    // A turn that ends without a call does not fall back to the earlier turn's result.
    const third = await t.host.followUp(first, {
      runId: 'run-1',
      stepId: 'reask',
      key: 'run-1:reask',
      attempt: 2,
      attribution,
      schema: SCHEMA,
    })
    await t.host.prompt(third, 'no tool this time')
    const err = await t.host.wait(third, waitOptions()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(WorkflowError)
    expect((err as WorkflowError).kind).toBe('invalid_output')
  })

  test.each([
    ['a text step (no output schema)', {}],
    ['another schema', { schema: { type: 'object', properties: { other: { type: 'string' } } } }],
    ['a schema that did not convert', { schemaError: 'Duplicate schema id' }],
  ])('a continue whose output is %s is refused on a JSON session before it prompts', async (_name, output) => {
    const t = setup()
    const first = await t.host.open(jsonSpec('x'))
    await t.host.prompt(first, '[result] draft')
    await t.host.wait(first, waitOptions())
    const turn = {
      runId: 'run-1',
      stepId: 'reask',
      key: 'run-1:reask',
      attempt: 1,
      attribution: attributionOf('run-1', 'reask'),
    }
    const message = await failure(t.host.followUp(first, { ...turn, ...(output as { schema?: Json }) }))
    expect(message).toContain('continue step "reask"')
    expect(message).toContain('answers through submit_result')
    expect(await userMessages(t, first)).toHaveLength(1)
  })

  test('a JSON step that ends without a completed call fails as invalid_output; its JSON text is never parsed', async () => {
    const t = setup()
    const fenced = await t.host.open(jsonSpec('x'))
    await t.host.prompt(fenced, '[json] give me data') // a fenced JSON answer in text, the old way
    const err = await t.host.wait(fenced, waitOptions()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(WorkflowError)
    expect((err as WorkflowError).kind).toBe('invalid_output')
    expect((err as Error).message).toContain('agent "tester"')
    expect((err as Error).message).toContain('without a completed submit_result call')
    expect((err as Error).message).toContain('Here it is')
  })

  test('a call that failed validation does not count', async () => {
    const t = setup()
    const handle = await t.host.open({ ...jsonSpec('x'), key: 'run-1:rejected' })
    await t.host.prompt(handle, '[result-rejected] give me data')
    expect(await failure(t.host.wait(handle, waitOptions()))).toContain('without a completed submit_result call')
  })

  test('a non-object root is wrapped under `result` and unwrapped on the way back', async () => {
    const t = setup()
    const array = { $schema: 'x', type: 'array', items: { $ref: '#/$defs/s' }, $defs: { s: { type: 'string' } } }
    const handle = await t.host.open(jsonSpec('x', array))
    expect((handle as OpenCodeHandle).result?.wrapped).toBe(true)
    const wrapped = {
      type: 'object',
      properties: { result: { type: 'array', items: { $ref: '#/$defs/s' } } },
      required: ['result'],
      additionalProperties: false,
      $defs: { s: { type: 'string' } },
    }
    expect(readFileSync(plugin(handle), 'utf8')).toContain(`const INPUT = ${JSON.stringify(wrapped)}\n`)
    await t.host.prompt(handle, '[result-wrapped] list')
    expect((await t.host.wait(handle, waitOptions())).output).toEqual(['a', 1])

    // A call without the `result` key cannot be unwrapped: invalid output, never `null`.
    const keyless = await t.host.open({ ...jsonSpec('x', array), key: 'run-1:keyless' })
    await t.host.prompt(keyless, '[result] list')
    const err = await t.host.wait(keyless, waitOptions()).catch((e: unknown) => e)
    expect((err as WorkflowError).kind).toBe('invalid_output')
    expect((err as Error).message).toContain('has no "result" key')
  })

  test.each([
    ['no schema', null, 'the step has no output schema'],
    ['a schema that is not an object', true, 'not a JSON Schema object'],
    ['a non-object root that refers to itself', { type: 'array', items: { $ref: '#' } }, '$ref "#" would not resolve'],
    [
      'a non-object root with a ref into its own tree',
      {
        type: 'array',
        items: { type: 'object', properties: { a: { type: 'string' }, b: { $ref: '#/items/properties/a' } } },
      },
      '$ref "#/items/properties/a" would not resolve',
    ],
  ])('%s is refused at open, naming the agent, before a session exists', async (_name, schema, why) => {
    const t = setup()
    const message = await failure(t.host.open(jsonSpec('x', schema)))
    expect(message).toContain('agent "tester"')
    expect(message).toContain(why)
    expect(Object.keys(t.fake.state.sessions)).toEqual([])
  })

  test("a schema the runtime could not convert is refused with the conversion's reason", async () => {
    const t = setup()
    const { schema: _, ...noSchema } = jsonSpec('x')
    const message = await failure(t.host.open({ ...noSchema, schemaError: 'Duplicate schema id "X" detected' }))
    expect(message).toContain('agent "tester"')
    expect(message).toContain('cannot be expressed as JSON Schema (Duplicate schema id "X" detected)')
  })

  test('a provider-balance fallback session gets the tool too', async () => {
    const t = setup()
    const handle = await t.host.open(jsonSpec('x'))
    await t.host.prompt(handle, '[balance] [result] review this')
    expect((await t.host.wait(handle, waitOptions())).output).toEqual({ ok: true, inputs: 1 })
    const fallback = Object.keys(t.fake.state.sessions).find((id) => id !== sid(handle)) as string
    expect(t.fake.state.sessions[fallback]?.permissions).toContainEqual(RESULT_RULE)
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
    expect(fallback?.permissions).toEqual(sessionPermissions(AGENT, { allowDirectories: ['/tmp/repo'] }))
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
      { allowDirectories: ['/work/repo'] },
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
      sessionPermissions(
        { ...AGENT, permissions: { rules: [allow('webfetch')] } },
        { allowDirectories: ['/tmp/repo'] },
      ),
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
    const t = setup()
    const handle = await t.host.open(spec('[hold] x'))
    await t.host.prompt(handle, '[hold] x')
    const reads = () => t.fake.urls.filter((r) => r.startsWith(`GET /api/session/${sid(handle)}/message`))
    const pagesOf = () => reads().filter((r) => r.includes('order=desc&limit=50'))
    // the turn stays open on the fake's latch until the wait has polled six times, however slow the host is
    const waiting = t.host.wait(handle, waitOptions())
    await until(() => pagesOf().length >= 6, 'six polls of the held turn')
    t.fake.release(sid(handle))
    await waiting
    const walks = reads().filter((r) => r.includes('order=asc'))
    // prompt's check, the first read and the final usage read walk the session; every other poll is one page.
    expect(walks).toHaveLength(3)
    expect(pagesOf().length).toBeGreaterThanOrEqual(6)
    // nothing but those first walk pages, their cursor continuations and the newest-first pages was ever read
    expect(reads().filter((r) => !/order=asc|cursor=|order=desc&limit=50/.test(r))).toEqual([])
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
    const reads = messageReads(t, handle)
    const waiting = t.host.wait(handle, waitOptions({ onProgress: () => progress++ }))
    await waitPolling(t, handle, reads)
    t.kill()
    // the wait sees refused connections and keeps polling
    await until(() => t.warnings.includes('opencode session read failed; retried next poll'), 'a failed read')
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
    await until(async () => (await t.client.messages(sid(handle))).some((m) => m.type === 'idle'), 'the turn ending')
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
    const reads = messageReads(t, handle)
    const waiting = t.host.wait(handle, waitOptions())
    await waitPolling(t, handle, reads)
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
    const reads = messageReads(t, handle)
    const waiting = t.host.wait(handle, waitOptions({ signal: controller.signal }))
    await waitPolling(t, handle, reads)
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
    expect(one(result.usage)?.toolCalls).toBe(1)
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
    const reads = messageReads(t, handle)
    const waiting = t.host.wait(handle, waitOptions())
    await waitPolling(t, handle, reads)
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
    expect(fallback?.model).toMatchObject({
      providerID: 'iu-responses',
      variant: fallbackRoute(CHECK)?.effort as string,
    })
    expect(fallback?.directory).toBe(primary?.directory)
    // The same permissions, the step's directories included.
    expect(fallback?.permissions).toEqual(primary?.permissions)
    expect(fallback?.messages.filter((m) => m.type === 'user')).toHaveLength(1)
    // The refused primary turn spent nothing here: the usage is the fallback's alone.
    expect(one(result.usage)?.model).toBe(fallback?.model.id)
    // A fallback session is the same route: it keeps the primary's id.
    expect(one(result.usage)?.route).toBe('check')
    expect(t.warnings).toContain('opencode turn failed on provider balance; falling back')
  })

  test('a primary that spent before the balance refusal keeps its spend: one report per session, each once', async () => {
    const t = setup({ turnMs: 300 })
    const handle = await t.host.open(spec('x'))
    await t.host.prompt(handle, '[balance] review this')
    // The fake's refused turn reports no tokens; give the primary's message the spend a real one carries.
    await until(() => sessions(t)[0]?.messages.some((m) => m.type === 'assistant') === true, 'the primary reply')
    const spent = sessions(t)[0]?.messages.find((m) => m.type === 'assistant')
    Object.assign(spent ?? {}, {
      tokens: { input: 40, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0.5,
    })
    const result = await t.host.wait(handle, waitOptions())
    const [primary, fallback, ...rest] = [result.usage ?? []].flat()
    expect(rest).toEqual([])
    // Not summed: each session keeps its own model, so the step's per-model split and a priced half survive.
    expect(primary?.model).toBe(sessions(t)[0]?.model.id)
    expect(primary?.tokens).toMatchObject({ input: 40, output: 0 })
    expect(primary?.cost).toBe(0.5)
    expect(fallback?.model).toBe(sessions(t)[1]?.model.id)
    expect(fallback?.tokens).toMatchObject({ input: 130, output: 6, reasoning: 1, cacheRead: 100, cacheWrite: 20 })
    expect(fallback?.cost).toBe(0.001)
    expect(primary?.route).toBe('check')
    expect(fallback?.route).toBe('check')
  })

  test('the fallback failing too keeps both sessions’ spend on the error', async () => {
    const t = setup({ turnMs: 300 })
    const handle = await t.host.open(spec('x'))
    await t.host.prompt(handle, '[balance-all] x')
    await until(() => sessions(t)[0]?.messages.some((m) => m.type === 'assistant') === true, 'the primary reply')
    const spent = sessions(t)[0]?.messages.find((m) => m.type === 'assistant')
    Object.assign(spent ?? {}, {
      tokens: { input: 40, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0.5,
    })
    const err = await t.host.wait(handle, waitOptions()).catch((e: unknown) => e)
    expect((err as WorkflowError).message).toContain('Insufficient Balance')
    expect(one((err as WorkflowError).usage)?.tokens).toMatchObject({ input: 40, output: 0 })
    expect(one((err as WorkflowError).usage)?.cost).toBe(0.5)
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

  test('a compaction failure after the turn ran starts the task over once in the fallback session, which answers', async () => {
    const t = setup()
    const handle = await t.host.open(spec('x'))
    await t.host.prompt(handle, '[tool:read][compaction] explore everything')
    const result = await t.host.wait(handle, waitOptions())
    expect(result.output).toBe('echo: [tool:read][compaction] explore everything')
    expect(sessions(t)).toHaveLength(2)
    expect(t.warnings).toContain('opencode turn failed on compaction; falling back')
    // The failed turn's spend stays on the step: the primary's usage, then the fallback's.
    const entries = [result.usage ?? []].flat()
    expect(entries).toHaveLength(2)
    expect(entries.map((u) => u.model)).toEqual([CHECK.model, fallbackRoute(CHECK)?.model])
  })

  test.each(['grep', 'glob', 'skill'])('a turn that only called %s restarts on the fallback', async (tool) => {
    const t = setup()
    const handle = await t.host.open(spec('x'))
    await t.host.prompt(handle, `[tool:${tool}][compaction] x`)
    expect((await t.host.wait(handle, waitOptions())).output).toBe(`echo: [tool:${tool}][compaction] x`)
    expect(sessions(t)).toHaveLength(2)
  })

  test('a turn with no tool call at all restarts on the fallback too', async () => {
    const t = setup()
    const handle = await t.host.open(spec('x'))
    await t.host.prompt(handle, '[compaction] x')
    expect((await t.host.wait(handle, waitOptions())).output).toBe('echo: [compaction] x')
    expect(sessions(t)).toHaveLength(2)
  })

  test.each(['bash', 'edit', 'write', 'shell'])(
    'a turn that called %s is not restarted: the step fails with the compaction error',
    async (tool) => {
      const t = setup()
      const handle = await t.host.open(spec('x'))
      await t.host.prompt(handle, `[tool:${tool}][compaction] x`)
      expect(await failure(t.host.wait(handle, waitOptions()))).toContain(
        'Compaction summary reached the output token limit',
      )
      expect(sessions(t)).toHaveLength(1)
      expect(t.warnings).toContain(
        'opencode compaction failed after a tool call that may have changed something; no fallback',
      )
    },
  )

  // The fake bills the tool call's reply (10 input, 5 output, 1 reasoning, 100 cache read, 20 cache write; cost 0.001):
  // the failed turn's spend. It rides on the error whether or not a fallback could run.
  const TOOL_REPLY = { input: 130, output: 6, cacheRead: 100, cacheWrite: 20, reasoning: 1 }

  test('a route without a fallback keeps the failed turn’s spend on the error', async () => {
    const t = setup()
    const handle = await t.host.open({ ...spec('x'), arm: { routes: { check: { fallback: null } } } })
    await t.host.prompt(handle, '[tool:read][compaction] x')
    const err = (await t.host.wait(handle, waitOptions()).catch((e: unknown) => e)) as WorkflowError
    expect(err.message).toContain('Compaction summary reached the output token limit')
    expect(sessions(t)).toHaveLength(1)
    expect(one(err.usage)?.tokens).toEqual(TOOL_REPLY)
    expect(one(err.usage)?.cost).toBe(0.001)
  })

  test('a turn that called a side-effecting tool keeps its spend on the error too', async () => {
    const t = setup()
    const handle = await t.host.open(spec('x'))
    await t.host.prompt(handle, '[tool:edit][compaction] x')
    const err = (await t.host.wait(handle, waitOptions()).catch((e: unknown) => e)) as WorkflowError
    expect(err.message).toContain('Compaction summary reached the output token limit')
    expect(sessions(t)).toHaveLength(1)
    expect(one(err.usage)?.tokens).toEqual(TOOL_REPLY)
    expect(one(err.usage)?.cost).toBe(0.001)
  })

  test('an error that mentions compaction in words no marker knows is warned about, once, and fails the step', async () => {
    const t = setup()
    const handle = await t.host.open(spec('x'))
    await t.host.prompt(handle, '[compaction-new] x')
    expect(await failure(t.host.wait(handle, waitOptions()))).toContain('Compaction could not be completed')
    expect(sessions(t)).toHaveLength(1)
    expect(t.warnings.filter((w) => w === 'unrecognised compaction failure')).toHaveLength(1)
  })

  test('a failure that does not mention compaction raises no such warning', async () => {
    const t = setup()
    const handle = await t.host.open(spec('x'))
    await t.host.prompt(handle, '[fail]')
    await failure(t.host.wait(handle, waitOptions()))
    expect(t.warnings).not.toContain('unrecognised compaction failure')
  })

  test('the fallback failing on compaction too fails the step with the compaction error: once, no third session', async () => {
    const t = setup()
    const handle = await t.host.open(spec('x'))
    await t.host.prompt(handle, '[tool:read][compaction-all] x')
    expect(await failure(t.host.wait(handle, waitOptions()))).toContain(
      'Compaction summary reached the output token limit',
    )
    expect(sessions(t)).toHaveLength(2)
  })

  test('a route without a fallback fails the step with the compaction error and says why', async () => {
    const t = setup()
    const handle = await t.host.open({ ...spec('x'), arm: { routes: { check: { fallback: null } } } })
    await t.host.prompt(handle, '[tool:read][compaction] x')
    expect(await failure(t.host.wait(handle, waitOptions()))).toContain(
      'Compaction summary reached the output token limit',
    )
    expect(sessions(t)).toHaveLength(1)
    expect(t.warnings).toContain('opencode compaction failed; the route has no fallback')
  })

  test('any other failure keeps today’s behaviour', async () => {
    const t = setup()
    const handle = await t.host.open(spec('x'))
    await t.host.prompt(handle, '[fail]')
    expect(await failure(t.host.wait(handle, waitOptions()))).toContain('provider said no')
    expect(sessions(t)).toHaveLength(1)
  })

  test("an armed step's fallback runs on the arm's fallback patch: the handle keeps it", async () => {
    const t = setup()
    const effort = fallbackRoute(CHECK)?.effort === 'high' ? 'xhigh' : 'high'
    const handle = await t.host.open({ ...spec('x'), arm: { routes: { check: { fallback: { effort } } } } })
    await t.host.prompt(handle, '[balance] x')
    await t.host.wait(handle, waitOptions())
    const [, fallback] = sessions(t)
    expect(fallback?.model).toMatchObject({ providerID: 'iu-responses', variant: effort })
  })

  test('an arm without a fallback for the route: the balance error fails the step', async () => {
    const t = setup()
    const handle = await t.host.open({ ...spec('x'), arm: { routes: { check: { fallback: null } } } })
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
  const turn = (key = 'run-1:agent:reask', attempt = 1) => ({
    runId: 'run-1',
    stepId: 'agent:reask',
    key,
    attempt,
    attribution: attributionOf('run-1', 'agent:reask'),
  })

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
    expect(one(result.usage)?.tokens).toEqual({ input: 130, output: 6, cacheRead: 100, cacheWrite: 20, reasoning: 1 })
    expect(one(result.usage)?.cost).toBe(0.001)
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
    // the fake opens the turn's assistant message when it starts: the kill below lands inside the 300 ms turn
    await until(
      async () => (await t.client.messages(sid(next))).some((m) => m.type === 'assistant'),
      'the turn to start',
    )
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

describe('a failing wait keeps what the session spent', () => {
  const turn = (key = 'run-1:agent:reask') => ({
    runId: 'run-1',
    stepId: 'agent:reask',
    key,
    attempt: 1,
    attribution: attributionOf('run-1', 'agent:reask'),
  })
  /** The message and error kind of a rejection, with the usage it carries. */
  async function rejected(promise: Promise<unknown>): Promise<WorkflowError> {
    const err = await promise.catch((e: unknown) => e)
    if (!(err instanceof WorkflowError)) throw new Error('expected a WorkflowError')
    return err
  }
  // The tool-call message of `[tool:read]` reports 10 + 100 + 20 input, 5 output, 1 reasoning, cost 0.001.
  const SPENT = { input: 130, output: 6, cacheRead: 100, cacheWrite: 20, reasoning: 1 }

  test('a failed turn re-reads the whole session: a message the polled view lacks still counts', async () => {
    const t = setup()
    const client = (t.host as unknown as { client: { recentMessages: (...args: never[]) => Promise<Message[]> } })
      .client
    const recent = client.recentMessages.bind(client)
    // The incremental page shows the assistant messages without their tokens; only a full walk has them.
    client.recentMessages = async (...args) =>
      (await recent(...args)).map((m) => (m.type === 'assistant' ? { ...m, tokens: undefined, cost: undefined } : m))
    const handle = await t.host.open(spec('x'))
    await t.host.prompt(handle, '[tool:read][fail] x')
    const err = await rejected(t.host.wait(handle, waitOptions()))
    expect(one(err.usage)?.tokens).toEqual(SPENT)
    expect(one(err.usage)?.cost).toBe(0.001)
  })

  test('a session that ends failed after a priced message: the error carries its tokens and cost', async () => {
    const t = setup()
    const handle = await t.host.open(spec('x'))
    await t.host.prompt(handle, '[tool:read][fail] x')
    const err = await rejected(t.host.wait(handle, waitOptions()))
    expect(err.kind).toBe('error')
    expect(err.message).toContain('provider said no')
    expect(one(err.usage)?.tokens).toEqual(SPENT)
    expect(one(err.usage)?.cost).toBe(0.001)
    expect(one(err.usage)?.route).toBe('check')
  })

  test('a failure before any assistant message spent nothing: no usage on the error', async () => {
    const t = setup()
    const handle = await t.host.open(spec('x'))
    await t.host.prompt(handle, '[fail]')
    expect((await rejected(t.host.wait(handle, waitOptions()))).usage).toBeUndefined()
  })

  test('an output that fails validation keeps the usage of the answer', async () => {
    const t = setup()
    const handle = await t.host.open({ ...spec('x', { output: 'json' }), schema: SCHEMA })
    await t.host.prompt(handle, '[json] give me data')
    const err = await rejected(t.host.wait(handle, waitOptions()))
    expect(err.kind).toBe('invalid_output')
    expect(one(err.usage)?.tokens).toEqual({ input: 130, output: 6, cacheRead: 100, cacheWrite: 20, reasoning: 1 })
    expect(one(err.usage)?.cost).toBe(0.001)
  })

  test('a failed follow-up turn keeps its own spend, not the first turn’s', async () => {
    const t = setup()
    const first = await t.host.open(spec('draft'))
    await t.host.prompt(first, 'draft it')
    await t.host.wait(first, waitOptions())
    const next = await t.host.followUp(first, turn())
    await t.host.prompt(next, '[tool:read][fail] fix it')
    const err = await rejected(t.host.wait(next, waitOptions()))
    expect(err.message).toContain('turn failed')
    expect(one(err.usage)?.tokens).toEqual(SPENT)
    expect(one(err.usage)?.cost).toBe(0.001)
  })

  test('an abort mid-turn (idle timeout, refused tool) carries what the session had spent', async () => {
    const t = setup({ turnMs: 400 })
    const handle = await t.host.open(spec('x'))
    await t.host.prompt(handle, '[tool:read][slow:1500] x')
    const controller = new AbortController()
    const reason = new WorkflowError('timeout', 'step idle')
    // The first reply is a tool call that completes after 400 ms, with its tokens; abort once it is in.
    const waiting = t.host.wait(handle, waitOptions({ signal: controller.signal }))
    await until(
      () => sessions(t)[0]?.messages.some((m) => m.type === 'assistant' && m.tokens !== undefined) === true,
      'the first reply',
    )
    await Bun.sleep(100) // one poll sees it
    controller.abort(reason)
    const err = await rejected(waiting)
    expect(err).toBe(reason)
    expect(one(err.usage)?.tokens).toEqual(SPENT)
  })

  test('a session that is gone fails as before and carries the spend already read', async () => {
    const t = setup({ turnMs: 400 })
    const handle = await t.host.open(spec('x'))
    await t.host.prompt(handle, '[tool:read][slow:2000] x')
    const waiting = t.host.wait(handle, waitOptions())
    await until(
      () => sessions(t)[0]?.messages.some((m) => m.type === 'assistant' && m.tokens !== undefined) === true,
      'the first reply',
    )
    await Bun.sleep(100)
    delete t.fake.state.sessions[sid(handle)]
    const err = await rejected(waiting)
    expect(err.message).toContain('is gone')
    expect(one(err.usage)?.tokens).toEqual(SPENT)
    expect(one(err.usage)?.cost).toBe(0.001)
  })

  test('a session that is gone before anything was read carries no usage', async () => {
    const t = setup({ turnMs: 400 })
    const handle = await t.host.open(spec('x'))
    await t.host.prompt(handle, 'x')
    delete t.fake.state.sessions[sid(handle)]
    const err = await rejected(t.host.wait(handle, waitOptions()))
    expect(err.message).toContain('is gone')
    expect(err.usage).toBeUndefined()
  })

  test('a run cancel (one shared Cancelled) carries no usage, on the first session or the fallback', async () => {
    const t = setup({ turnMs: 300 })
    const handle = await t.host.open(spec('x'))
    await t.host.prompt(handle, '[tool:read][slow:2000] x')
    const controller = new AbortController()
    const cancelled = new Cancelled('run-1')
    const waiting = t.host.wait(handle, waitOptions({ signal: controller.signal }))
    await until(
      () => sessions(t)[0]?.messages.some((m) => m.type === 'assistant' && m.tokens !== undefined) === true,
      'the first reply',
    )
    await Bun.sleep(100)
    controller.abort(cancelled)
    expect(await rejected(waiting)).toBe(cancelled)
    expect(cancelled.usage).toBeUndefined()
  })

  const sessions = (t: ReturnType<typeof setup>) => Object.values(t.fake.state.sessions)
})

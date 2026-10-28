import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentWaitOptions } from '@agent-workflows/runtime'
import {
  type AgentDefinition,
  createClient,
  type Message,
  type OpenCodeHandle,
  OpenCodeHost,
  OpenCodeHttpError,
} from '../src/index.ts'
import {
  canonicalInput,
  finalText,
  NUDGE_AT,
  nudgeId,
  nudgeThreshold,
  repeatCounts,
  sessionCounters,
  type ToolPart,
} from '../src/session.ts'
import { type FakeServer, startFake } from './fake-opencode.ts'

const AGENT: AgentDefinition = { name: 'tester', agentsMd: '# tester\n', route: 'check' }
const cleanups: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn()
})

const part = (name: string, input: unknown, status = 'completed', id = `${name}-${Math.random()}`): ToolPart =>
  ({ type: 'tool', id, name, state: { status, input } }) as ToolPart

describe('what an identical tool call is', () => {
  test('canonical JSON: key order and nesting order do not matter, values and tool names do', () => {
    expect(canonicalInput({ b: 1, a: { d: [1, { y: 1, x: 2 }], c: null } })).toBe(
      canonicalInput({ a: { c: null, d: [1, { x: 2, y: 1 }] }, b: 1 }),
    )
    const counts = repeatCounts([
      part('read', { path: 'a', limit: 5 }),
      part('read', { limit: 5, path: 'a' }),
      part('read', { path: 'b', limit: 5 }), // another input
      part('grep', { path: 'a', limit: 5 }), // another tool
    ])
    expect([...counts.values()]).toEqual([2, 1, 1])
  })

  test('a part without a known input is not counted; a part is counted once whatever the reads', () => {
    const pending = part('read', undefined, 'pending')
    const repeated = part('read', { p: 1 }, 'completed', 'same-id')
    expect([...repeatCounts([pending, repeated, repeated, repeated]).values()]).toEqual([1])
  })
})

describe('nudge thresholds', () => {
  test('exactly at the 3rd, 5th and 8th identical call, never between or after', () => {
    expect(NUDGE_AT).toEqual([3, 5, 8])
    const seen: number[] = []
    let last: number | null = null
    for (let count = 1; count <= 20; count++) {
      const at = nudgeThreshold(count)
      if (at !== last) seen.push(count)
      last = at
    }
    expect(seen).toEqual([3, 5, 8]) // the counts where the threshold changes
    expect([1, 2].map(nudgeThreshold)).toEqual([null, null])
    expect([3, 4].map(nudgeThreshold)).toEqual([3, 3])
    expect([5, 6, 7].map(nudgeThreshold)).toEqual([5, 5, 5])
    expect([8, 9, 50].map(nudgeThreshold)).toEqual([8, 8, 8])
  })
})

describe('the answer of a step never comes from a nudge turn', () => {
  const prompt = 'msg_prompt'
  const reply = (id: string, text: string, finish = 'stop'): Message => ({
    id,
    type: 'assistant',
    finish,
    content: [{ type: 'text', text }],
  })
  const base: Message[] = [{ id: prompt, type: 'user', metadata: { agw: { kind: 'prompt' } } }]
  const nudge: Message = { id: 'n', type: 'synthetic', metadata: { agw: { kind: 'nudge' } } }

  test('in-turn (measured): the note sits between the turn own messages, the answer after it is the answer', () => {
    const messages = [
      ...base,
      reply('a1', 'working', 'tool-calls'),
      nudge,
      reply('a2', '{"ok":true}'),
      { id: 'i', type: 'idle' },
    ]
    expect(finalText(messages, prompt)).toBe('{"ok":true}')
  })

  test('queued as a turn of its own after the idle: its reply is ignored', () => {
    const messages = [
      ...base,
      reply('a1', '{"ok":true}'),
      { id: 'i1', type: 'idle' },
      nudge,
      reply('a2', 'Understood, I will change approach.'),
      { id: 'i2', type: 'idle' },
    ]
    expect(finalText(messages, prompt)).toBe('{"ok":true}')
  })

  test('queued behind a turn that finished (stop), with no idle between: still a turn of its own', () => {
    const messages = [...base, reply('a1', '{"ok":true}'), nudge, reply('a2', 'Understood.'), { id: 'i', type: 'idle' }]
    expect(finalText(messages, prompt)).toBe('{"ok":true}')
  })

  test('a steer after a finished turn starts a new one: a nudge in it is in-turn, the answer after it counts', () => {
    const messages = [
      ...base,
      reply('a1', 'first answer'),
      { id: 's', type: 'user', metadata: { agw: { kind: 'steer' } } },
      reply('a2', 'working', 'tool-calls'),
      nudge,
      reply('a3', 'second answer'),
    ]
    expect(finalText(messages, prompt)).toBe('second answer')
  })

  test('a message without a finish followed by an idle ended its turn: a nudge after it is its own turn', () => {
    const noFinish: Message = { id: 'a1', type: 'assistant', content: [{ type: 'text', text: 'the answer' }] }
    const messages = [...base, noFinish, { id: 'i', type: 'idle' }, nudge, reply('a2', 'Understood.')]
    expect(finalText(messages, prompt)).toBe('the answer')
  })

  test('a text-only message without a finish may be a preamble still streaming: a nudge right after it is in-turn', () => {
    const streaming: Message = {
      id: 'a1',
      type: 'assistant',
      content: [{ type: 'text', text: 'Let me look into it.' }],
    }
    const messages = [...base, streaming, nudge, reply('a2', '{"ok":true}')]
    expect(finalText(messages, prompt)).toBe('{"ok":true}')
  })

  test('a message without a finish that called tools was mid-loop: the nudge is in-turn, the reply after it counts', () => {
    const noFinish: Message = { id: 'a1', type: 'assistant', content: [part('read', { p: 1 })] }
    const messages = [...base, noFinish, nudge, reply('a2', 'the answer')]
    expect(finalText(messages, prompt)).toBe('the answer')
  })

  test('a final stop message without text before the nudge does not blank the answer', () => {
    const empty: Message = { id: 'a2', type: 'assistant', finish: 'stop', content: [] }
    const messages = [...base, reply('a1', 'the answer'), empty, nudge, reply('a3', 'Understood.')]
    expect(finalText(messages, prompt)).toBe('the answer')
  })

  test('a resume note after an idle is not a nudge', () => {
    const messages = [
      ...base,
      reply('a1', 'first'),
      { id: 'i1', type: 'idle' },
      { id: 'r', type: 'synthetic', metadata: { agw: { kind: 'resume' } } },
      reply('a2', 'second'),
    ]
    expect(finalText(messages, prompt)).toBe('second')
  })
})

describe('nudges that were due and are not in the session', () => {
  const prompt = 'msg_prompt'
  const calls = (n: number): Message => ({
    id: 'a1',
    type: 'assistant',
    finish: 'stop',
    content: Array.from({ length: n }, () => part('read', { p: 1 })),
  })
  const base: Message[] = [{ id: prompt, type: 'user', metadata: { agw: { kind: 'prompt' } } }]
  const key = `read\0${canonicalInput({ p: 1 })}`

  const note = (at: number): Message => ({
    id: nudgeId('ses', key, at),
    type: 'synthetic',
    metadata: { agw: { kind: 'nudge' } },
  })
  /** The calls, then one more call of another tool: the turn went on, so the host had a poll to send the note. */
  const later: Message = { id: 'a2', type: 'assistant', content: [part('grep', { q: 'x' })] }

  test('a threshold with no later tool call is not missed: the host may never have polled after it', () => {
    expect(sessionCounters([...base, calls(3)], prompt, 'ses').nudgesMissed).toBe(0)
    expect(sessionCounters([...base, calls(2), later], prompt, 'ses').nudgesMissed).toBe(0) // not due yet
  })

  test('a threshold followed by a later call and with no note is missed; with its note, not', () => {
    expect(sessionCounters([...base, calls(3), later], prompt, 'ses').nudgesMissed).toBe(1)
    expect(sessionCounters([...base, calls(3), note(3), later], prompt, 'ses')).toMatchObject({
      nudges: 1,
      nudgesMissed: 0,
    })
  })

  test('every threshold reached is checked; a note for a higher one satisfies the lower ones (a jump sends one)', () => {
    // 9 calls and a later one: 3, 5 and 8 were all reached and passed.
    expect(sessionCounters([...base, calls(9), later], prompt, 'ses').nudgesMissed).toBe(3)
    expect(sessionCounters([...base, calls(9), note(3), later], prompt, 'ses').nudgesMissed).toBe(2) // 5 and 8
    expect(sessionCounters([...base, calls(9), note(5), later], prompt, 'ses').nudgesMissed).toBe(1) // 8
    expect(sessionCounters([...base, calls(9), note(8), later], prompt, 'ses').nudgesMissed).toBe(0) // 8 covers 3 and 5
  })
})

describe('session counters on messages', () => {
  const prompt = 'msg_prompt'
  const messages = (...assistant: Message[]): Message[] => [
    { id: 'old', type: 'assistant', content: [part('read', { p: 'before the prompt' }, 'error')] },
    { id: prompt, type: 'user', metadata: { agw: { kind: 'prompt' } } },
    ...assistant,
  ]

  test('tool errors, the highest repeat and the nudges the host sent', () => {
    const list = messages(
      {
        id: 'a1',
        type: 'assistant',
        content: [
          part('read', { p: 1 }, 'error'),
          part('read', { p: 1 }, 'completed'),
          part('read', { p: 1 }, 'completed'),
          part('grep', { q: 'x' }, 'error'),
          part('grep', { q: 'y' }, 'completed'),
        ],
      },
      { id: 'n1', type: 'synthetic', metadata: { agw: { kind: 'nudge' } } },
      { id: 'r1', type: 'synthetic', metadata: { agw: { kind: 'resume' } } },
    )
    expect(sessionCounters(list, prompt, 'ses')).toMatchObject({ toolErrors: 2, repeatToolCalls: 3, nudges: 1 })
  })

  test('a session without tools counts zero, and the same messages always count the same', () => {
    const list = messages({ id: 'a1', type: 'assistant', content: [{ type: 'text', text: 'hi' }] })
    expect(sessionCounters(list, prompt, 'ses')).toEqual({
      toolErrors: 0,
      repeatToolCalls: 0,
      nudges: 0,
      nudgesMissed: 0,
    })
    expect(sessionCounters(list, prompt, 'ses')).toEqual(sessionCounters(list, prompt, 'ses'))
  })
})

function setup() {
  const logs: { message: string; meta?: Record<string, unknown> }[] = []
  const dir = mkdtempSync(join(tmpdir(), 'och-friction-'))
  const statePath = join(dir, 'fake.json')
  const fake: FakeServer = startFake({ password: 'pw', statePath })
  const server = {
    endpoint: () => ({ baseUrl: `http://127.0.0.1:${fake.port}`, password: 'pw' }),
    ready: async () => {},
  }
  const makeHost = () =>
    new OpenCodeHost({
      logger: {
        warn: (message, meta) => logs.push({ message, meta }),
        error: (message, meta) => logs.push({ message, meta }),
      },
      server,
      agents: [AGENT],
      stateDir: dir,
      pollIntervalMs: 20,
      cutoffGraceMs: 150,
      env: {},
      locations: { evictAfterMs: 0, tickMs: 60_000, retentionMs: 0 },
    })
  const host = makeHost()
  const client = createClient(() => server.endpoint())
  cleanups.push(() => {
    host.close()
    fake.stop()
    rmSync(dir, { recursive: true, force: true })
  })
  const waitOptions = (over: Partial<AgentWaitOptions> = {}): AgentWaitOptions => ({
    signal: new AbortController().signal,
    onProgress: () => {},
    onTool: async () => {},
    ...over,
  })
  return { host, makeHost, fake, client, waitOptions, logs }
}

/** A held turn: the test adds tool parts and the host polls between them. */
async function held(t: ReturnType<typeof setup>, prompt = '[hold] work') {
  const handle = await t.host.open({
    runId: 'run-1',
    stepId: 'agent',
    key: 'run-1:agent',
    agent: 'tester',
    prompt,
  })
  await t.host.prompt(handle, prompt)
  const sessionId = (handle as OpenCodeHandle).sessionId
  return { handle, sessionId }
}

const STEP = { runId: 'run-1', stepId: 'agent' }
const settle = () => Bun.sleep(150)
/** Nudge notes in the session: admitted ones wait in the inbox while the turn is held, then become messages. */
const nudges = async (t: ReturnType<typeof setup>, sessionId: string) => {
  const session = t.fake.state.sessions[sessionId]
  const isNudge = (m: { metadata?: Record<string, unknown> }) =>
    (m.metadata?.agw as { kind?: string } | undefined)?.kind === 'nudge'
  return [...(session?.messages ?? []), ...(session?.inbox ?? [])].filter(isNudge) as { text: string }[]
}

describe('the repeat-tool nudge in a live wait', () => {
  test('one note each at the 3rd, 5th and 8th identical call; nothing else, and the turn is never cut', async () => {
    const t = setup()
    const { handle, sessionId } = await held(t)
    const waiting = t.host.wait(handle, t.waitOptions())
    const sent: number[] = []
    for (let call = 1; call <= 9; call++) {
      t.fake.addTool(sessionId, { name: 'read', input: { path: 'a.ts', limit: 20 } })
      await settle()
      sent.push((await nudges(t, sessionId)).length)
    }
    // Calls 1..9: the count of notes after each. A note appears at 3, 5 and 8 only.
    expect(sent).toEqual([0, 0, 1, 1, 2, 2, 2, 3, 3])
    const notes = await nudges(t, sessionId)
    expect(notes.map((m) => m.text)).toEqual([
      expect.stringContaining('identical input 3 times'),
      expect.stringContaining('identical input 5 times'),
      expect.stringContaining('identical input 8 times'),
    ])
    t.fake.release(sessionId)
    const result = await waiting
    expect(result.output).toBe('held answer')
    expect(await t.host.stepFriction(STEP)).toEqual({
      sessions: [{ session: sessionId, toolErrors: 0, repeatToolCalls: 9, nudges: 3, nudgesMissed: 0 }],
      incomplete: false,
    })
  })

  test('different inputs or tools never nudge; key order of an input does not hide a repeat', async () => {
    const t = setup()
    const { handle, sessionId } = await held(t)
    const waiting = t.host.wait(handle, t.waitOptions())
    for (let call = 0; call < 6; call++) t.fake.addTool(sessionId, { name: 'read', input: { path: `f${call}.ts` } })
    for (let call = 0; call < 6; call++) t.fake.addTool(sessionId, { name: `tool${call}`, input: { path: 'same' } })
    await settle()
    expect(await nudges(t, sessionId)).toHaveLength(0)
    t.fake.addTool(sessionId, { name: 'grep', input: { a: 1, b: 2 } })
    t.fake.addTool(sessionId, { name: 'grep', input: { b: 2, a: 1 } })
    await settle()
    expect(await nudges(t, sessionId)).toHaveLength(0)
    t.fake.addTool(sessionId, { name: 'grep', input: { b: 2, a: 1 } })
    await settle()
    expect(await nudges(t, sessionId)).toHaveLength(1)
    t.fake.release(sessionId)
    await waiting
  })

  test('a jump across two thresholds sends one note, for the higher one', async () => {
    const t = setup()
    const { handle, sessionId } = await held(t)
    const waiting = t.host.wait(handle, t.waitOptions())
    for (let call = 0; call < 5; call++) t.fake.addTool(sessionId, { name: 'read', input: { path: 'a' } })
    await settle()
    const notes = await nudges(t, sessionId)
    expect(notes).toHaveLength(1)
    expect(notes[0]?.text).toContain('identical input 5 times')
    t.fake.release(sessionId)
    await waiting
  })

  test('a re-attached wait (new host process, same session) does not repeat a note already in the session', async () => {
    const t = setup()
    const { handle, sessionId } = await held(t)
    const first = new AbortController()
    const waiting = t.host.wait(handle, t.waitOptions({ signal: first.signal })).catch(() => 'aborted')
    for (let call = 0; call < 3; call++) t.fake.addTool(sessionId, { name: 'read', input: { path: 'a' } })
    await settle()
    expect(await nudges(t, sessionId)).toHaveLength(1)
    first.abort()
    await waiting

    const second = t.makeHost()
    cleanups.push(() => second.close())
    const again = second.wait(handle, t.waitOptions())
    await settle()
    expect(await nudges(t, sessionId)).toHaveLength(1)
    t.fake.addTool(sessionId, { name: 'read', input: { path: 'a' } })
    t.fake.addTool(sessionId, { name: 'read', input: { path: 'a' } })
    await settle()
    expect(await nudges(t, sessionId)).toHaveLength(2) // the 5th call, once
    t.fake.release(sessionId)
    await again
    expect((await second.stepFriction(STEP)).sessions).toMatchObject([{ repeatToolCalls: 5, nudges: 2 }])
  })

  test('a nudge the server refuses never aborts the turn, and is not retried every poll', async () => {
    const t = setup()
    const { handle, sessionId } = await held(t)
    let posts = 0
    const inner = (t.host as unknown as { client: { synthetic: () => Promise<void> } }).client
    inner.synthetic = async () => {
      posts++
      throw new OpenCodeHttpError(400, 'POST /api/session/{id}/synthetic')
    }
    const waiting = t.host.wait(handle, t.waitOptions())
    for (let call = 0; call < 3; call++) t.fake.addTool(sessionId, { name: 'read', input: { path: 'a' } })
    await settle()
    expect(posts).toBe(1)
    t.fake.release(sessionId)
    expect((await waiting).output).toContain('held answer')
  })

  test('measured model: the note lands in the running turn, and the answer is the one after it', async () => {
    const t = setup()
    const { handle, sessionId } = await held(t)
    const waiting = t.host.wait(handle, t.waitOptions())
    for (let call = 0; call < 3; call++) t.fake.addTool(sessionId, { name: 'read', input: { path: 'a' } })
    await settle()
    t.fake.release(sessionId)
    expect((await waiting).output).toBe('held answer')
    const types = (await t.client.messages(sessionId)).map(
      (m) => `${m.type}${m.metadata?.agw?.kind ? `:${m.metadata.agw.kind}` : ''}`,
    )
    expect(types).toEqual(['user:prompt', 'assistant', 'synthetic:nudge', 'assistant', 'idle'])
  })

  test('if the server queues the note as a turn of its own, that turn never becomes the answer of the step', async () => {
    const t = setup()
    t.fake.queueSynthetic(true)
    const { handle, sessionId } = await held(t)
    const waiting = t.host.wait(handle, t.waitOptions())
    for (let call = 0; call < 3; call++) t.fake.addTool(sessionId, { name: 'read', input: { path: 'a' } })
    await settle()
    t.fake.release(sessionId)
    const result = await waiting
    expect(result.output).toBe('held answer') // not the reply of the nudge turn
    const types = (await t.client.messages(sessionId)).map((m) => m.type)
    expect(types).toEqual(['user', 'assistant', 'synthetic', 'assistant', 'idle']) // the nudge did run as a turn of its own
  })

  test('every session of a step counts: a retry opens the next generation, and a failing fallback probe drops nothing', async () => {
    const t = setup()
    const first = await held(t)
    const waiting = t.host.wait(first.handle, t.waitOptions())
    t.fake.addTool(first.sessionId, { name: 'read', input: { path: 'x' }, status: 'error', error: 'no' })
    await settle()
    t.fake.release(first.sessionId)
    await waiting
    // The retry: the same step key opens generation 2.
    const second = await held(t)
    expect(second.sessionId).not.toBe(first.sessionId)
    const again = t.host.wait(second.handle, t.waitOptions())
    for (let call = 0; call < 3; call++) t.fake.addTool(second.sessionId, { name: 'read', input: { path: 'a' } })
    await settle()
    t.fake.release(second.sessionId)
    await again
    expect(await t.host.stepFriction(STEP)).toEqual({
      sessions: [
        { session: first.sessionId, toolErrors: 1, repeatToolCalls: 1, nudges: 0, nudgesMissed: 0 },
        { session: second.sessionId, toolErrors: 0, repeatToolCalls: 3, nudges: 1, nudgesMissed: 0 },
      ],
      incomplete: false,
    })

    // A fallback probe that fails (any session lookup of an id that is not a primary) leaves the primaries counted.
    const client = (t.host as unknown as { client: { getSession: (id: string) => Promise<unknown> } }).client
    const real = client.getSession.bind(client)
    const primaries = new Set([first.sessionId, second.sessionId])
    client.getSession = async (id: string) => {
      if (!primaries.has(id)) throw new Error('fallback probe failed')
      return real(id)
    }
    const partial = await t.host.stepFriction(STEP)
    expect(partial.sessions.map((x) => x.session)).toEqual([first.sessionId, second.sessionId])
    expect(partial.incomplete).toBe(true) // the fallback probes failed: the answer says it may be short

    // A primary probe that fails ends the walk (is there a next generation? unknown) and says so.
    client.getSession = async (id: string) => {
      if (id === second.sessionId) throw new Error('primary probe failed')
      return real(id)
    }
    const truncated = await t.host.stepFriction(STEP)
    expect(truncated.sessions.map((x) => x.session)).toEqual([first.sessionId])
    expect(truncated.incomplete).toBe(true)
  })

  test('a refused nudge is logged with its status and message, and shows as missed afterwards', async () => {
    const t = setup()
    const { handle, sessionId } = await held(t)
    const inner = (t.host as unknown as { client: { synthetic: () => Promise<void> } }).client
    inner.synthetic = async () => {
      throw new OpenCodeHttpError(400, 'POST /api/session/{id}/synthetic')
    }
    const waiting = t.host.wait(handle, t.waitOptions())
    for (let call = 0; call < 3; call++) t.fake.addTool(sessionId, { name: 'read', input: { path: 'a' } })
    await settle()
    t.fake.addTool(sessionId, { name: 'grep', input: { q: 'later' } }) // the turn went on past the threshold
    await settle()
    t.fake.release(sessionId)
    await waiting
    const log = t.logs.find((l) => l.message.startsWith('opencode nudge not sent'))
    expect(log?.meta).toMatchObject({
      status: 400,
      transient: false,
      gaveUp: true,
      attempt: 1,
      tool: 'read',
      count: 3,
      error: expect.stringContaining('HTTP 400'),
    })
    expect((await t.host.stepFriction(STEP)).sessions[0]).toMatchObject({ nudges: 0, nudgesMissed: 1 })
  })

  test('a transient failure to post the note is retried a few times, then given up', async () => {
    const t = setup()
    const { handle, sessionId } = await held(t)
    let posts = 0
    const inner = (t.host as unknown as { client: { synthetic: () => Promise<void> } }).client
    inner.synthetic = async () => {
      posts++
      throw new OpenCodeHttpError(503, 'POST /api/session/{id}/synthetic')
    }
    const waiting = t.host.wait(handle, t.waitOptions())
    for (let call = 0; call < 3; call++) t.fake.addTool(sessionId, { name: 'read', input: { path: 'a' } })
    await Bun.sleep(400) // many polls
    expect(posts).toBe(3)
    t.fake.addTool(sessionId, { name: 'grep', input: { q: 'later' } }) // the turn went on past the threshold
    await settle()
    t.fake.release(sessionId)
    await waiting
    const gaveUp = t.logs.filter((l) => l.message.startsWith('opencode nudge not sent') && l.meta?.gaveUp === true)
    expect(gaveUp).toHaveLength(1)
    expect(gaveUp[0]?.meta).toMatchObject({ status: 503, transient: true, attempt: 3 })
    expect((await t.host.stepFriction(STEP)).sessions[0]?.nudgesMissed).toBe(1)
  })

  test('tool errors are counted from the session, the same on every read', async () => {
    const t = setup()
    const { handle, sessionId } = await held(t)
    const waiting = t.host.wait(handle, t.waitOptions())
    t.fake.addTool(sessionId, { name: 'read', input: { path: 'x' }, status: 'error', error: 'no such file' })
    t.fake.addTool(sessionId, { name: 'read', input: { path: 'y' }, status: 'error', error: 'no such file' })
    t.fake.addTool(sessionId, { name: 'read', input: { path: 'z' } })
    await settle()
    t.fake.release(sessionId)
    await waiting
    const once = await t.host.stepFriction(STEP)
    expect(once).toEqual({
      sessions: [{ session: sessionId, toolErrors: 2, repeatToolCalls: 1, nudges: 0, nudgesMissed: 0 }],
      incomplete: false,
    })
    expect(await t.host.stepFriction(STEP)).toEqual(once)
  })
})

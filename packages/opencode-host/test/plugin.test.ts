import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { join } from 'node:path'
import { gatewayHeaders } from '../../capabilities/src/transports/headers.ts'
import { ATTRIBUTION_PLUGIN } from '../src/config.ts'

type Session = { id: string; parentID?: string; metadata?: Record<string, unknown> }
type Hook = (event: { sessionID: string; headers: Record<string, string> }) => Promise<void>
type Plugin = { id: string; setup: (ctx: unknown) => Promise<void> }

const plugin = async (): Promise<Plugin> =>
  ((await import(join(ATTRIBUTION_PLUGIN, 'server.js'))) as { default: Plugin }).default

const ATTRIBUTION = {
  runId: 'run-1',
  rootId: 'root-1',
  workflow: 'review',
  step: 'agent',
  purpose: 'user',
  project: 'agent-workflows',
  workspace: 'private',
  origin: 'claude-code',
}

/** The plugin against a store of sessions: the hook it registers, and every `get` it made. */
async function load(sessions: Session[]) {
  const store = new Map(sessions.map((s) => [s.id, s]))
  const gets: unknown[] = []
  const hooks = new Map<string, Hook>()
  await (
    await plugin()
  ).setup({
    session: {
      get: async (input: { sessionID: string }) => {
        gets.push(input)
        const session = store.get(input.sessionID)
        if (!session) throw new Error('Session not found')
        return session
      },
      hook: async (name: string, fn: Hook) => {
        hooks.set(name, fn)
      },
    },
  })
  const fire = async (sessionID: string) => {
    const event = { sessionID, headers: { 'x-opencode-session-id': sessionID } as Record<string, string> }
    await (hooks.get('model.request') as Hook)(event)
    const { 'x-opencode-session-id': _, ...added } = event.headers
    return added
  }
  return { fire, gets, store, hooks }
}

describe('the attribution plugin', () => {
  const spies: { mockRestore: () => void }[] = []
  const errors = () => {
    const spy = spyOn(console, 'error').mockImplementation(() => {})
    spies.push(spy)
    return spy
  }
  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore()
  })

  test('sets on model.request only, and asks for the session as { sessionID }', async () => {
    const { fire, gets, hooks } = await load([{ id: 's', metadata: { agw: ATTRIBUTION } }])
    expect([...hooks.keys()]).toEqual(['model.request'])
    await fire('s')
    expect(gets).toEqual([{ sessionID: 's' }])
  })

  test('the headers from metadata.agw are the ones gatewayHeaders writes', async () => {
    const { fire } = await load([{ id: 's', metadata: { agw: { ...ATTRIBUTION, key: 'k', route: 'check' } } }])
    expect(await fire('s')).toEqual(gatewayHeaders(ATTRIBUTION))
  })

  test('origin and routeFallback are set under the names gatewayHeaders writes', async () => {
    const agw = { ...ATTRIBUTION, origin: 'claude-code', routeFallback: 'unknown' }
    const { fire } = await load([{ id: 's', metadata: { agw } }])
    const headers = await fire('s')
    expect(headers).toEqual(gatewayHeaders(agw))
    expect(headers['x-agw-origin']).toBe('claude-code')
    expect(headers['x-agw-route-fallback']).toBe('unknown')
    const { origin: _, ...bare } = ATTRIBUTION
    expect(await (await load([{ id: 's', metadata: { agw: bare } }])).fire('s')).not.toHaveProperty('x-agw-origin')
  })

  test('a traceparent is never set: it could not land', async () => {
    const agw = { ...ATTRIBUTION, traceparent: '00-11111111111111111111111111111111-2222222222222222-01' }
    const { fire } = await load([{ id: 's', metadata: { agw } }])
    expect(await fire('s')).toEqual(gatewayHeaders(ATTRIBUTION))
  })

  test('the same value filter as gatewayHeaders', async () => {
    const bad = [' edge', 'edge ', '   ', '', 'ümlaut', 'tab\there', 'x'.repeat(201)]
    const good = ['x'.repeat(200), 'in side', 'a/b:c']
    for (const project of [...bad, ...good]) {
      const attribution = { ...ATTRIBUTION, project }
      const { fire } = await load([{ id: 's', metadata: { agw: attribution } }])
      expect(await fire('s')).toEqual(gatewayHeaders(attribution))
    }
  })

  test('a value that is not a string is left out; a partial attribution sends what it has', async () => {
    const { fire } = await load([{ id: 's', metadata: { agw: { runId: 'run-1', step: 7, rootId: null } } }])
    expect(await fire('s')).toEqual({ 'x-agw-run-id': 'run-1' })
  })

  test('a child session walks parentID to the root, and the walk is cached', async () => {
    const { fire, gets } = await load([
      { id: 'root', metadata: { agw: ATTRIBUTION } },
      { id: 'mid', parentID: 'root' },
      { id: 'leaf', parentID: 'mid' },
    ])
    expect(await fire('leaf')).toEqual(gatewayHeaders(ATTRIBUTION))
    expect(gets).toHaveLength(3)
    gets.length = 0
    expect(await fire('leaf')).toEqual(gatewayHeaders(ATTRIBUTION))
    expect(gets).toEqual([{ sessionID: 'root' }])
  })

  test('a follow-up that rewrites the metadata is read on the next request', async () => {
    const { fire, store } = await load([{ id: 's', metadata: { agw: ATTRIBUTION } }])
    await fire('s')
    ;(store.get('s') as Session).metadata = { agw: { ...ATTRIBUTION, step: 'reask' } }
    expect((await fire('s'))['x-agw-step']).toBe('reask')
  })

  test('a failed read logs loudly and never fails the request', async () => {
    const spy = errors()
    const { fire } = await load([])
    expect(await fire('gone')).toEqual({})
    expect(spy).toHaveBeenCalledWith('agw-attribution: session gone sent unattributed: Session not found')
  })

  test('a root without metadata.agw, or without a runId in it, is said out loud too', async () => {
    const message = 'agw-attribution: session s sent unattributed: root session has no metadata.agw.runId'
    for (const session of [{ id: 's' }, { id: 's', metadata: { agw: { key: 'k', step: 'agent' } } }]) {
      const spy = errors()
      const { fire } = await load([session])
      expect(await fire('s')).toEqual({})
      expect(spy).toHaveBeenCalledWith(message)
    }
  })

  test('a parent cycle ends: the walk is bounded and logged', async () => {
    const spy = errors()
    const { fire, gets } = await load([
      { id: 'a', parentID: 'b' },
      { id: 'b', parentID: 'a' },
    ])
    expect(await fire('a')).toEqual({})
    expect(gets.length).toBeLessThanOrEqual(34)
    expect(spy).toHaveBeenCalledWith('agw-attribution: session a sent unattributed: no root within 32 parents')
  })
})

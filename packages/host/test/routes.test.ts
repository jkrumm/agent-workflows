import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { OVERRIDES_ENV, resolveRoute, routeIds } from '@agent-workflows/routes'
import { createHost } from '../src/app.ts'
import { type Body, SECRET, startTestHost, type TestHost } from './support.ts'

const OVERRIDE = { 'cheap.classify': { model: 'override-model', effort: 'low' } }
const env = (value: unknown) => ({ [OVERRIDES_ENV]: typeof value === 'string' ? value : JSON.stringify(value) })

let t: TestHost
let overridden: TestHost
let malformed: TestHost
beforeAll(async () => {
  t = await startTestHost({ prefix: 'routes' })
  overridden = await startTestHost({ prefix: 'routesov', routesEnv: env(OVERRIDE) })
  malformed = await startTestHost({ prefix: 'routesbad', routesEnv: env('{not json') })
})
afterAll(async () => {
  await Promise.all([t.close(), overridden.close(), malformed.close()])
})

describe('GET /routes', () => {
  test('lists every route id with its resolved entry, writes no run', async () => {
    const count = async () =>
      (await t.pool.query(`select count(*)::int as n from "${t.schema}".runs`)).rows[0].n as number
    const before = await count()
    const { status, body } = await t.json(await t.call('/routes'))
    expect(status).toBe(200)
    expect(Object.keys(body.routes).sort()).toEqual([...routeIds()].sort())
    for (const id of routeIds()) {
      const { id: _id, ...entry } = resolveRoute(id, {})
      expect(body.routes[id]).toEqual(JSON.parse(JSON.stringify(entry)))
      expect(body.table).toContain(id)
    }
    expect(await count()).toBe(before)
  })

  test('resolves with the injected env, not the process environment', async () => {
    const { body } = await overridden.json(await overridden.call('/routes'))
    expect(body.routes['cheap.classify']).toMatchObject({ model: 'override-model', effort: 'low' })
    expect(body.routes['cheap.classify'].rate).toBeUndefined() // a new model drops the stale rate
    expect(body.table).toContain('override-model')
    const plain = await t.json(await t.call('/routes'))
    expect(plain.body.routes['cheap.classify'].model).not.toBe('override-model')
  })

  test('a malformed override is a typed error with its message, never the override text', async () => {
    const response = await malformed.call('/routes')
    expect(response.status).toBe(500)
    const body = (await response.json()) as Body
    expect(body.code).toBe('ROUTE_OVERRIDE_INVALID')
    expect(body.message).toBe(`${OVERRIDES_ENV}: not valid JSON`)
    expect(JSON.stringify(body)).not.toContain('{not json')
  })

  test('the plain table has a header, one line per route, and a price for price-based routes; no URL or key', async () => {
    const { body } = await t.json(await t.call('/routes'))
    const lines = body.table.split('\n')
    expect(lines).toHaveLength(routeIds().length + 1)
    expect(lines[0]).toMatch(/^route\s+wire\s+model\s+effort\s+in\/M\s+out\/M\s+price\s+fallback$/)
    const line = (id: string) => lines.find((l: string) => l.startsWith(`${id} `)) as string
    expect(line('image.flare')).toMatch(/M: \d/) // image-tokens price
    expect(line('image.cutout.recraft')).toMatch(/\d\/call/) // per-call price
    expect(line('audio.tts.elevenlabs-flash')).toMatch(/\d\/1000 character/) // per-unit price over a count
    expect(JSON.stringify(body)).not.toMatch(/https?:|api[_-]?key|secret/i)
  })

  test('needs the bearer and is an x-cli command', async () => {
    expect((await t.call('/routes', { auth: null })).status).toBe(401)
    const doc = (await (await t.call('/openapi.json')).json()) as Body
    expect(doc.paths['/routes'].get['x-cli']).toMatchObject({
      command: ['routes'],
      mutating: false,
      defaultFormat: 'json',
      plainField: 'table',
    })
  })
})

describe('one process declares routes', () => {
  const commandsOf = async (host: { openapi: () => Promise<Record<string, unknown>> }) =>
    Object.values(((await host.openapi()).paths as Body) ?? {}).flatMap((methods: Body) =>
      Object.values(methods).map((operation) => (operation as Body)['x-cli']?.command?.join(' ')),
    )
  /** The audio process's shape: no capabilities served, and no `routesEnv`. */
  const second = () =>
    createHost({
      runtime: t.runtime,
      registry: { capabilities: [], router: {}, requestContext: t.registry.requestContext },
      workflows: [],
      capabilityWorkflows: new Map(),
      secret: SECRET,
      version: 'x',
    })

  test('a host given no routesEnv (the audio process) has no routes path and no command', async () => {
    const other = second()
    expect(Object.keys((await other.openapi()).paths as object)).not.toContain('/routes')
    expect(await commandsOf(other)).not.toContain('routes')
  })

  test('across the two processes `routes` is declared exactly once', async () => {
    const all = [...(await commandsOf(t.host)), ...(await commandsOf(second()))]
    expect(all.filter((command) => command === 'routes')).toHaveLength(1)
  })
})

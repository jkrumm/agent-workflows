import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { type RouteEntry, resolveRoute, routeIds } from '@agent-workflows/routes'
import { createHost } from '../src/app.ts'
import { routesTable } from '../src/operations.ts'
import { type Body, SECRET, startTestHost, type TestHost } from './support.ts'

let t: TestHost
beforeAll(async () => {
  t = await startTestHost({ prefix: 'routes' })
})
afterAll(async () => {
  await t.close()
})

/** The audio process's shape: no capabilities served, and no `serveRoutes`. */
const hostOptions = () => ({
  runtime: t.runtime,
  registry: { served: [], router: {}, requestContext: t.registry.requestContext },
  workflows: [],
  capabilityWorkflows: new Map(),
  secret: SECRET,
  version: 'x',
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
      const { id: _id, ...entry } = resolveRoute(id)
      expect(body.routes[id]).toEqual(JSON.parse(JSON.stringify(entry)))
      expect(body.table).toContain(id)
    }
    expect(await count()).toBe(before)
  })

  test('the plain table has a header, one line per route, and a price for price-based routes; no URL or key', async () => {
    const { body } = await t.json(await t.call('/routes'))
    const lines = body.table.split('\n')
    expect(lines.filter((l: string) => !l.startsWith('* '))).toHaveLength(routeIds().length + 1)
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

describe('routesTable', () => {
  const entry = (price: RouteEntry['price']): RouteEntry => ({ wire: 'iu-openai', model: 'm', price })

  test('prices print in fixed decimals, never exponent notation', () => {
    const table = routesTable({
      tiny: entry({ kind: 'unit', unit: 'call', usd: 1e-7 }),
      small: entry({ kind: 'unit', unit: 'character', usd: 0.000036, per: 1000 }),
      tokens: entry({ kind: 'image-tokens', textInPerM: 5, imageInPerM: 0.5, outputPerM: 30 }),
    })
    expect(table).not.toMatch(/\de[-+]?\d/i)
    expect(table).toContain('0/call')
    expect(table).toContain('0.000036/1000 character')
    expect(table).toContain('M: 5 text, 0.5 img in, 30 out')
  })

  test('a tiered price carries * and the table ends with its legend; without one there is none', () => {
    const tiered = entry({ kind: 'unit', unit: 'image', usd: 0.04, tiers: [{ match: { quality: 'high' }, usd: 0.1 }] })
    const withTier = routesTable({ a: tiered }).split('\n')
    expect(withTier[1]).toContain('0.04/image*')
    expect(withTier.at(-1)).toStartWith('* ')
    expect(routesTable({ a: entry({ kind: 'unit', unit: 'call', usd: 0.01 }) })).not.toContain('* ')
  })
})

describe('one process declares routes', () => {
  const commandsOf = async (host: { openapi: () => Promise<Record<string, unknown>> }) =>
    Object.values(((await host.openapi()).paths as Body) ?? {}).flatMap((methods: Body) =>
      Object.values(methods).map((operation) => (operation as Body)['x-cli']?.command?.join(' ')),
    )
  const second = () => createHost(hostOptions())

  test('a host not serving routes (the audio process) has no routes path and no command', async () => {
    const other = second()
    expect(Object.keys((await other.openapi()).paths as object)).not.toContain('/routes')
    expect(await commandsOf(other)).not.toContain('routes')
  })

  test('across the two processes `routes` is declared exactly once', async () => {
    const all = [...(await commandsOf(t.host)), ...(await commandsOf(second()))]
    expect(all.filter((command) => command === 'routes')).toHaveLength(1)
  })
})

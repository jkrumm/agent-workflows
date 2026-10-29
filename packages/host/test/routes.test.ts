import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { OVERRIDES_ENV, resolveRoute, routeIds } from '@agent-workflows/routes'
import { type Body, startTestHost, type TestHost } from './support.ts'

let t: TestHost
beforeAll(async () => {
  t = await startTestHost({ prefix: 'routes' })
})
afterAll(async () => {
  await t.close()
})
afterEach(() => {
  delete process.env[OVERRIDES_ENV]
})

describe('GET /routes', () => {
  test('lists every route id with its resolved entry, writes no run', async () => {
    const before = await t.pool.query(`select count(*)::int as n from "${t.schema}".runs`)
    const { status, body } = await t.json(await t.call('/routes'))
    expect(status).toBe(200)
    expect(Object.keys(body.routes).sort()).toEqual([...routeIds()].sort())
    for (const id of routeIds()) {
      const { id: _id, ...entry } = resolveRoute(id)
      expect(body.routes[id]).toEqual(JSON.parse(JSON.stringify(entry)))
    }
    for (const id of routeIds()) expect(body.table).toContain(id)
    const after = await t.pool.query(`select count(*)::int as n from "${t.schema}".runs`)
    expect(after.rows[0].n).toBe(before.rows[0].n)
  })

  test('shows AGW_ROUTES overrides', async () => {
    process.env[OVERRIDES_ENV] = JSON.stringify({ 'cheap.classify': { model: 'override-model', effort: 'low' } })
    const { body } = await t.json(await t.call('/routes'))
    expect(body.routes['cheap.classify']).toMatchObject({ model: 'override-model', effort: 'low' })
    expect(body.routes['cheap.classify'].rate).toBeUndefined() // a new model drops the stale rate
    expect(body.table).toContain('override-model')
  })

  test('the plain table has a header and one line per route; no URL or key', async () => {
    const { body } = await t.json(await t.call('/routes'))
    const lines = body.table.split('\n')
    expect(lines).toHaveLength(routeIds().length + 1)
    expect(lines[0]).toMatch(/^route\s+wire\s+model\s+effort\s+in\/M\s+out\/M\s+fallback$/)
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

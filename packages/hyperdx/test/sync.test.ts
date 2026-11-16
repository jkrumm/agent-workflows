import { describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type AlertDef, apply, exportDefinitions, type Hdx, loadDefinitions, tileId } from '../src/index.ts'

const DEFINITIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'definitions')

type Obj = Record<string, unknown>

/** The message of the error `promise` rejects with; fails when it resolves. */
async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('expected a rejection')
}

/** An in-memory HyperDX: the REST v2 collections `apply` and `exportDefinitions` touch, with server-assigned ids. */
function fakeHdx() {
  const store: Record<string, Obj[]> = {
    sources: [
      { id: 's-traces', name: 'Traces' },
      { id: 's-logs', name: 'Logs' },
    ],
    connections: [{ id: 'c-1', name: 'Local ClickHouse' }],
    webhooks: [{ id: 'w-1', name: 'Factory door' }],
    dashboards: [],
    alerts: [],
  }
  let next = 0
  const writes: string[] = []
  const hdx: Hdx = {
    get: async (path) => ({ data: structuredClone(store[path.slice(1)] ?? []) }),
    send: async (method, path, body) => {
      if (path === '/dashboards/validate') return { valid: true, errors: [] }
      writes.push(`${method} ${path}`)
      const [, collection, id] = path.split('/')
      const rows = store[collection ?? ''] ?? []
      const row = { ...(body as Obj), id: id ?? `new-${(next += 1)}` }
      if (id === undefined) rows.push(row)
      else rows[rows.findIndex((r) => r.id === id)] = row
      return { data: row }
    },
  }
  return { hdx, store, writes }
}

describe('definitions', () => {
  test('every alert points at a tile of the dashboard, one name per tile and alert, a threshold that fits its type', async () => {
    const { dashboard, alerts } = await loadDefinitions(DEFINITIONS)
    const tiles = dashboard.tiles.map((t) => t.name)
    expect(new Set(tiles).size).toBe(tiles.length)
    expect(new Set(alerts.map((a) => a.name)).size).toBe(alerts.length)
    for (const alert of alerts) {
      expect(tiles).toContain(alert.tile)
      expect(alert.dashboard).toBe(dashboard.name)
      expect(alert.tags).toContain('agw')
      expect(alert.channels).toEqual([{ type: 'webhook', webhook: 'Factory door' }])
      expect(typeof alert.threshold).toBe('number')
      expect(['1m', '5m', '15m', '30m', '1h', '6h', '12h', '1d']).toContain(String(alert.interval))
    }
  })

  test('a public repo: no host, address or credential in a definition', async () => {
    const files = [
      join(DEFINITIONS, 'dashboard.json'),
      ...(await readdir(join(DEFINITIONS, 'alerts'))).map((f) => join(DEFINITIONS, 'alerts', f)),
    ]
    for (const file of files) {
      const text = await readFile(file, 'utf8')
      expect(text).not.toMatch(/https?:\/\/|\b\d{1,3}(\.\d{1,3}){3}\b|jkrumm|op:\/\/|bearer |api[_-]?key/i)
    }
  })
})

describe('apply', () => {
  test('a dry run validates and writes nothing', async () => {
    const { hdx, writes } = fakeHdx()
    const lines = await apply(hdx, await loadDefinitions(DEFINITIONS), { dryRun: true })
    expect(writes).toEqual([])
    expect(lines[0]).toBe('would create dashboard agw')
    expect(lines).toHaveLength(1 + 7)
  })

  test('creates the dashboard and alerts, resolving sources, connections, tiles and webhooks to ids', async () => {
    const { hdx, store } = fakeHdx()
    await apply(hdx, await loadDefinitions(DEFINITIONS), { dryRun: false })
    const dash = store.dashboards?.[0] as Obj & { tiles: Obj[] }
    expect(dash.tiles.map((t) => (t.config as Obj).sourceId)).toContain('s-logs')
    expect(JSON.stringify(dash)).not.toContain('"source":"')
    const sql = dash.tiles.find((t) => (t.config as Obj).configType === 'sql')
    if (sql === undefined) throw new Error('no sql tile')
    expect((sql.config as Obj).connectionId).toBe('c-1')
    expect(store.alerts).toHaveLength(7)
    for (const alert of store.alerts ?? []) {
      expect(alert.dashboardId).toBe(dash.id)
      expect(dash.tiles.map((t) => t.id)).toContain(alert.tileId)
      expect(alert.channels).toEqual([{ type: 'webhook', webhookId: 'w-1' }])
    }
  })

  test('a second run updates in place: no new objects, tile ids and the alerts that name them unchanged', async () => {
    const { hdx, store, writes } = fakeHdx()
    const defs = await loadDefinitions(DEFINITIONS)
    await apply(hdx, defs, { dryRun: false })
    const before = structuredClone(store)
    writes.length = 0
    const lines = await apply(hdx, defs, { dryRun: false })
    expect(lines.every((l) => l.startsWith('updated '))).toBe(true)
    expect(writes.every((w) => w.startsWith('PUT '))).toBe(true)
    expect(store.dashboards).toHaveLength(1)
    expect(store.alerts).toHaveLength(7)
    expect(store).toEqual(before)
  })

  test('a live tile keeps its id; a new tile gets the one derived from its name', async () => {
    const { hdx, store } = fakeHdx()
    const defs = await loadDefinitions(DEFINITIONS)
    const first = defs.dashboard.tiles[0]
    store.dashboards?.push({
      id: 'd-1',
      name: 'agw',
      tiles: [{ id: 'live-id', name: first?.name }],
    })
    await apply(hdx, defs, { dryRun: false })
    const live = store.dashboards?.[0] as Obj & { tiles: Obj[] }
    const tiles = live.tiles
    expect(tiles[0]?.id).toBe('live-id')
    const second = defs.dashboard.tiles[1]
    if (second === undefined) throw new Error('no second tile')
    expect(tiles[1]?.id).toBe(tileId('agw', String(second.name)))
  })

  test('an alert naming a tile the dashboard lacks, or a webhook that does not exist, stops with the name', async () => {
    const defs = await loadDefinitions(DEFINITIONS)
    const alert = defs.alerts[0]
    if (alert === undefined) throw new Error('no alerts')
    const noTile = fakeHdx()
    expect(
      await failure(apply(noTile.hdx, { ...defs, alerts: [{ ...alert, tile: 'no such tile' }] }, { dryRun: false })),
    ).toContain('no such tile')
    const noHook = fakeHdx()
    noHook.store.webhooks = []
    expect(await failure(apply(noHook.hdx, defs, { dryRun: false }))).toContain('Factory door')
  })

  test('an invalid dashboard stops before any write', async () => {
    const { hdx, writes } = fakeHdx()
    const invalid: Hdx = {
      get: (path) => hdx.get(path),
      send: async (method, path, body) =>
        path === '/dashboards/validate'
          ? { valid: false, errors: [{ path: 'tiles.0' }] }
          : hdx.send(method, path, body),
    }
    expect(await failure(apply(invalid, await loadDefinitions(DEFINITIONS), { dryRun: false }))).toContain('invalid')
    expect(writes).toEqual([])
  })
})

describe('exportDefinitions', () => {
  test('writes back what apply read: same definitions after a round trip through the live objects', async () => {
    const { hdx } = fakeHdx()
    const defs = await loadDefinitions(DEFINITIONS)
    await apply(hdx, defs, { dryRun: false })
    const dir = await mkdtemp(join(tmpdir(), 'hdx-export-'))
    const files = await exportDefinitions(hdx, dir, 'agw', 'agw')
    expect(files).toHaveLength(1 + 7)
    const back = await loadDefinitions(dir)
    expect(back.dashboard.tiles.map((t) => t.name)).toEqual(defs.dashboard.tiles.map((t) => t.name))
    expect(back.dashboard.tiles.map((t) => (t.config as Obj).source)).toEqual(
      defs.dashboard.tiles.map((t) => (t.config as Obj).source),
    )
    const key = (a: AlertDef) => [a.name, a.tile, a.threshold, a.interval].join('|')
    expect(new Set(back.alerts.map(key))).toEqual(new Set(defs.alerts.map(key)))
  })
})

import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** The HyperDX REST v2 surface this package needs: read a path, write one. Both return the parsed JSON body. */
export type Hdx = {
  get(path: string): Promise<unknown>
  send(method: 'POST' | 'PUT', path: string, body: unknown): Promise<unknown>
}

type Obj = Record<string, unknown>

export type DashboardDef = Obj & { name: string; tiles: Obj[] }
export type AlertDef = Obj & { name: string; dashboard: string; tile: string; channels: Obj[] }
export type Definitions = { dashboard: DashboardDef; alerts: AlertDef[] }

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function data(response: unknown): Obj[] {
  if (!isObj(response) || !Array.isArray(response.data)) throw new Error('unexpected HyperDX response: no data array')
  return response.data.filter(isObj)
}

function str(v: unknown, what: string): string {
  if (typeof v !== 'string' || v === '') throw new Error(`${what} is not a non-empty string`)
  return v
}

/** A tile's id is derived from its name, so an apply never changes the id an alert points at. */
export function tileId(dashboard: string, tile: string): string {
  return createHash('sha256').update(`${dashboard}\n${tile}`).digest('hex').slice(0, 24)
}

export async function loadDefinitions(dir: string): Promise<Definitions> {
  const dashboard: unknown = JSON.parse(await readFile(join(dir, 'dashboard.json'), 'utf8'))
  if (!isObj(dashboard) || typeof dashboard.name !== 'string' || !Array.isArray(dashboard.tiles)) {
    throw new Error('dashboard.json: expected {name, tiles[]}')
  }
  const files = (await readdir(join(dir, 'alerts'))).filter((f) => f.endsWith('.json')).sort()
  const alerts: AlertDef[] = []
  for (const file of files) {
    const alert: unknown = JSON.parse(await readFile(join(dir, 'alerts', file), 'utf8'))
    if (!isObj(alert) || typeof alert.name !== 'string') throw new Error(`alerts/${file}: expected {name, ...}`)
    alerts.push(alert as AlertDef)
  }
  return { dashboard: dashboard as DashboardDef, alerts }
}

type Names = { sources: Map<string, string>; connections: Map<string, string> }

function lookup(map: Map<string, string>, name: string, what: string): string {
  const id = map.get(name)
  if (id === undefined) throw new Error(`unknown ${what} "${name}" (known: ${[...map.keys()].join(', ')})`)
  return id
}

/** Replaces the by-name `source` / `connection` of a tile config with the live ids; the inverse of `nameRefs`. */
function idRefs(value: unknown, names: Names): unknown {
  if (Array.isArray(value)) return value.map((v) => idRefs(v, names))
  if (!isObj(value)) return value
  const out: Obj = {}
  for (const [key, v] of Object.entries(value)) {
    if (key === 'source' && typeof v === 'string') {
      out[value.mode === 'id' ? 'id' : 'sourceId'] = lookup(names.sources, v, 'source')
    } else if (key === 'connection' && typeof v === 'string') {
      out.connectionId = lookup(names.connections, v, 'connection')
    } else out[key] = idRefs(v, names)
  }
  return out
}

function nameRefs(value: unknown, sources: Map<string, string>, connections: Map<string, string>): unknown {
  if (Array.isArray(value)) return value.map((v) => nameRefs(v, sources, connections))
  if (!isObj(value)) return value
  const out: Obj = {}
  for (const [key, v] of Object.entries(value)) {
    if (key === 'sourceId' && typeof v === 'string') out.source = lookup(sources, v, 'source id')
    else if (key === 'connectionId' && typeof v === 'string') out.connection = lookup(connections, v, 'connection id')
    else if (key === 'id' && typeof v === 'string' && value.mode === 'id' && sources.has(v)) {
      out.source = lookup(sources, v, 'source id')
    } else out[key] = nameRefs(v, sources, connections)
  }
  return out
}

/** The request body for one dashboard: names resolved to ids, tile ids kept from `live` by tile name, else derived. */
function dashboardBody(def: DashboardDef, names: Names, live: Obj | undefined): Obj {
  const liveTiles = new Map<string, string>()
  for (const t of Array.isArray(live?.tiles) ? live.tiles : []) {
    if (isObj(t) && typeof t.id === 'string' && typeof t.name === 'string') liveTiles.set(t.name, t.id)
  }
  const seen = new Set<string>()
  const tiles = def.tiles.map((tile) => {
    const name = str(tile.name, 'a tile name')
    if (seen.has(name)) throw new Error(`dashboard "${def.name}": two tiles are named "${name}"`)
    seen.add(name)
    return { ...(idRefs(tile, names) as Obj), id: liveTiles.get(name) ?? tileId(def.name, name) }
  })
  return { ...def, tiles }
}

/** The request body for one alert: the tile, dashboard and webhooks looked up by name. */
function alertBody(def: AlertDef, dashboards: Obj[], webhooks: Map<string, string>): Obj {
  const { dashboard, tile, channels, ...rest } = def
  const dash = dashboards.find((d) => d.name === dashboard)
  if (dash === undefined) throw new Error(`alert "${def.name}": no dashboard "${dashboard}"`)
  const live = (Array.isArray(dash.tiles) ? dash.tiles : []).find((t) => isObj(t) && t.name === tile)
  if (!isObj(live)) throw new Error(`alert "${def.name}": dashboard "${dashboard}" has no tile "${tile}"`)
  const resolved = channels.map((c) => {
    const { webhook, ...channel } = c
    return { ...channel, webhookId: lookup(webhooks, str(webhook, 'a channel webhook'), 'webhook') }
  })
  return {
    ...rest,
    source: 'tile',
    dashboardId: str(dash.id, 'the dashboard id'),
    tileId: str(live.id, 'the tile id'),
    channels: resolved,
    channel: resolved[0],
  }
}

async function names(hdx: Hdx): Promise<Names> {
  const sources = new Map(
    data(await hdx.get('/sources')).map((s) => [str(s.name, 'source name'), str(s.id, 'source id')]),
  )
  const connections = new Map(
    data(await hdx.get('/connections')).map((c) => [str(c.name, 'connection name'), str(c.id, 'connection id')]),
  )
  return { sources, connections }
}

async function webhookIds(hdx: Hdx): Promise<Map<string, string>> {
  return new Map(data(await hdx.get('/webhooks')).map((w) => [str(w.name, 'webhook name'), str(w.id, 'webhook id')]))
}

export type ApplyOptions = { dryRun: boolean }

/**
 * Upserts the dashboard, then every alert, by name. Idempotent: a second run updates in place and changes nothing that
 * matters. A dashboard that fails `/dashboards/validate` stops the run before any write. Returns one line per object.
 */
export async function apply(hdx: Hdx, defs: Definitions, options: ApplyOptions): Promise<string[]> {
  const lines: string[] = []
  const ids = await names(hdx)
  const liveDashboards = data(await hdx.get('/dashboards'))
  const liveDashboard = liveDashboards.find((d) => d.name === defs.dashboard.name)
  const body = dashboardBody(defs.dashboard, ids, liveDashboard)

  const check = await hdx.send('POST', '/dashboards/validate', body)
  if (isObj(check) && check.valid !== true) {
    throw new Error(`dashboard "${defs.dashboard.name}" is invalid: ${JSON.stringify(check.errors)}`)
  }
  if (options.dryRun) {
    lines.push(`would ${liveDashboard === undefined ? 'create' : 'update'} dashboard ${defs.dashboard.name}`)
  } else if (liveDashboard === undefined) {
    await hdx.send('POST', '/dashboards', body)
    lines.push(`created dashboard ${defs.dashboard.name}`)
  } else {
    await hdx.send('PUT', `/dashboards/${str(liveDashboard.id, 'the dashboard id')}`, body)
    lines.push(`updated dashboard ${defs.dashboard.name}`)
  }

  const webhooks = await webhookIds(hdx)
  const liveAlerts = data(await hdx.get('/alerts'))
  // A dry run resolves nothing against the live dashboard (a tile added to the definitions is not there yet): it checks
  // each alert's tile against the definition's tiles and its webhooks against the live ones.
  const dashboards = options.dryRun ? [] : data(await hdx.get('/dashboards'))
  const tileNames = new Set(defs.dashboard.tiles.map((t) => t.name))
  for (const alert of defs.alerts) {
    const existing = liveAlerts.find((a) => a.name === alert.name)
    if (options.dryRun) {
      if (!tileNames.has(alert.tile))
        throw new Error(`alert "${alert.name}": no tile "${alert.tile}" in the definition`)
      for (const channel of alert.channels) lookup(webhooks, str(channel.webhook, 'a channel webhook'), 'webhook')
      lines.push(`would ${existing === undefined ? 'create' : 'update'} alert ${alert.name}`)
      continue
    }
    const request = alertBody(alert, dashboards, webhooks)
    if (existing === undefined) {
      await hdx.send('POST', '/alerts', request)
      lines.push(`created alert ${alert.name}`)
    } else {
      await hdx.send('PUT', `/alerts/${str(existing.id, 'the alert id')}`, request)
      lines.push(`updated alert ${alert.name}`)
    }
  }
  return lines
}

/** The file an alert is kept in: its name, slugified. `exportDefinitions` writes it, the definitions test holds the files to it. */
export function alertFileName(name: string): string {
  return `${name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')}.json`
}

/** Server-owned alert fields: never part of a definition. */
const ALERT_SERVER_KEYS = new Set([
  'id',
  'state',
  'teamId',
  'silenced',
  'executionErrors',
  'createdAt',
  'updatedAt',
  'history',
  'channel',
  'dashboardId',
  'tileId',
  'savedSearchId',
])

const sorted = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sorted)
  if (!isObj(value)) return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((k) => [k, sorted(value[k])]),
  )
}

/**
 * Writes the live dashboard and its tagged alerts back into `dir`, in the shape `apply` reads: ids replaced by names,
 * tile ids dropped (they are derived from the name), keys sorted. The way to capture a change made in the HyperDX UI.
 */
export async function exportDefinitions(hdx: Hdx, dir: string, dashboardName: string, tag: string): Promise<string[]> {
  const sources = new Map(
    data(await hdx.get('/sources')).map((s) => [str(s.id, 'source id'), str(s.name, 'source name')]),
  )
  const connections = new Map(
    data(await hdx.get('/connections')).map((c) => [str(c.id, 'connection id'), str(c.name, 'connection name')]),
  )
  const webhooks = new Map(
    data(await hdx.get('/webhooks')).map((w) => [str(w.id, 'webhook id'), str(w.name, 'webhook name')]),
  )
  const dashboards = data(await hdx.get('/dashboards'))
  const dash = dashboards.find((d) => d.name === dashboardName)
  if (dash === undefined) throw new Error(`no dashboard "${dashboardName}" to export`)

  const tileNames = new Map<string, string>()
  const tiles = (Array.isArray(dash.tiles) ? dash.tiles : []).filter(isObj).map((t) => {
    tileNames.set(str(t.id, 'a tile id'), str(t.name, 'a tile name'))
    const { id: _id, ...tile } = t
    return nameRefs(tile, sources, connections)
  })
  const { id: _i, createdAt: _c, updatedAt: _u, team: _t, teamId: _ti, ...dashboard } = dash
  await mkdir(join(dir, 'alerts'), { recursive: true })
  await writeFile(join(dir, 'dashboard.json'), `${JSON.stringify(sorted({ ...dashboard, tiles }), null, 2)}\n`)

  const out: string[] = ['dashboard.json']
  for (const file of await readdir(join(dir, 'alerts'))) {
    if (file.endsWith('.json')) await rm(join(dir, 'alerts', file))
  }
  for (const alert of data(await hdx.get('/alerts'))) {
    if (alert.dashboardId !== dash.id || !(Array.isArray(alert.tags) && alert.tags.includes(tag))) continue
    const def: Obj = {}
    for (const [key, v] of Object.entries(alert)) if (!ALERT_SERVER_KEYS.has(key)) def[key] = v
    def.dashboard = dashboardName
    def.tile = tileNames.get(str(alert.tileId, 'an alert tile id')) ?? ''
    def.channels = (Array.isArray(alert.channels) ? alert.channels : []).filter(isObj).map((c) => {
      const { webhookId, ...channel } = c
      return { ...channel, webhook: webhooks.get(str(webhookId, 'a webhook id')) ?? '' }
    })
    const file = alertFileName(str(alert.name, 'an alert name'))
    await writeFile(join(dir, 'alerts', file), `${JSON.stringify(sorted(def), null, 2)}\n`)
    out.push(`alerts/${file}`)
  }
  return out
}

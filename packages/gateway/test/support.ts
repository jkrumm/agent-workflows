import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Ledger, type PickRow, type RecordRow } from '../src/ledger.ts'
import { Outbox, pgUsageSink } from '../src/outbox.ts'
import type { Logger } from '../src/log.ts'
import { createPools, type Pools, type RegistryPool } from '../src/pools/index.ts'
import { createProxy, type GatewayProxy } from '../src/proxy.ts'
import { Reconciler } from '../src/reconcile.ts'
import { type GatewayServer, startGateway } from '../src/server.ts'
import { createTelemetry, type Telemetry } from '../src/telemetry.ts'

export const API_SECRET = 'a'.repeat(32)
export const DOOR_TOKEN = 'b'.repeat(32)
export const HERMES_TOKEN = 'c'.repeat(32)
export const IU_KEY = 'fake-iu-key'
export const POOL_KEY = 'fake-pool-key'

export const silentLogger = (): Logger & { lines: { level: string; message: string; fields?: unknown }[] } => {
  const lines: { level: string; message: string; fields?: unknown }[] = []
  const at = (level: string) => (message: string, fields?: Record<string, unknown>) =>
    void lines.push({ level, message, fields })
  return { lines, info: at('info'), warn: at('warn'), error: at('error') }
}

export function tempDir(): { path: string; remove(): void } {
  const path = mkdtempSync(join(tmpdir(), 'gateway-test-'))
  return { path, remove: () => rmSync(path, { recursive: true, force: true }) }
}

export interface Seen {
  method: string
  path: string
  headers: Headers
  body: Uint8Array
}

export type Reply = (seen: Seen) => Response | Promise<Response>

/** A fake upstream: records what arrives, answers with the current reply. */
export function fakeUpstream(initial: Reply = () => Response.json({ ok: true })) {
  const seen: Seen[] = []
  let reply = initial
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const one: Seen = {
        method: request.method,
        path: `${url.pathname}${url.search}`,
        headers: request.headers,
        body: new Uint8Array(await request.arrayBuffer()),
      }
      seen.push(one)
      return reply(one)
    },
  })
  return {
    seen,
    url: `http://127.0.0.1:${server.port}`,
    reply(next: Reply) {
      reply = next
    },
    stop() {
      void server.stop(true)
    },
  }
}

export type Upstream = ReturnType<typeof fakeUpstream>

export const pool = (id: string, over: Partial<RegistryPool> = {}): RegistryPool => ({
  id,
  creditUsd: 100,
  cycleDay: 15,
  headroomUsd: 1,
  enabled: true,
  apiKeyRef: `op://test/${id}`,
  ...over,
})

export interface Harness {
  url: string
  ledger: Ledger
  pools: Pools
  proxy: GatewayProxy
  server: GatewayServer
  logger: ReturnType<typeof silentLogger>
  call(path: string, init?: RequestInit & { token?: string }): Promise<Response>
  rows(): ReturnType<Ledger['pending']>
  close(): Promise<void>
}

/** A gateway on port 0 against fake upstreams and a temp ledger. */
export function harness(input: {
  anthropic: Upstream
  iu: Upstream
  registry?: RegistryPool[]
  telemetry?: Telemetry
  /** A real flush loop against this database. */
  usage?: { connectionString: string; debounceMs: number }
  hangGuardMs?: number
  ledgerPath?: string
  drainMs?: number
}): Harness {
  const dir = tempDir()
  const logger = silentLogger()
  const ledger = new Ledger(input.ledgerPath ?? join(dir.path, 'ledger.sqlite'))
  const registry = input.registry ?? []
  const keys = new Map(registry.map((p) => [p.id, POOL_KEY]))
  const pools = createPools({ registry, keys, meter: ledger })
  const telemetry = input.telemetry ?? createTelemetry({ env: {}, logger })
  const outbox =
    input.usage === undefined
      ? null
      : new Outbox({
          ledger,
          sink: pgUsageSink({ connectionString: input.usage.connectionString, logger }),
          logger,
          debounceMs: input.usage.debounceMs,
        })
  outbox?.start()
  const proxy = createProxy({
    pools,
    poolKeys: keys,
    ledger,
    outbox,
    telemetry,
    logger,
    doorTokens: new Map([
      ['oc', DOOR_TOKEN],
      ['hermes', HERMES_TOKEN],
    ]),
    apiSecret: API_SECRET,
    iu: {
      apiKey: IU_KEY,
      anthropicBase: `${input.iu.url}/prefix/anthropic`,
      root: `${input.iu.url}/prefix`,
      origin: input.iu.url,
    },
    anthropicBase: input.anthropic.url,
    machine: 'test-machine',
    ...(input.hangGuardMs === undefined ? {} : { hangGuardMs: input.hangGuardMs }),
  })
  const reconciler = new Reconciler({
    registry: [],
    adminKeys: new Map(),
    pools,
    ledger,
    logger,
    baseUrl: input.anthropic.url,
  })
  const server = startGateway({
    port: 0,
    proxy,
    pools,
    ledger,
    outbox,
    reconciler,
    telemetry,
    logger,
    version: 'test',
    build: 'test-build',
    ...(input.drainMs === undefined ? {} : { drainMs: input.drainMs }),
  })
  const url = `http://127.0.0.1:${server.port}`
  let closed = false
  return {
    url,
    ledger,
    pools,
    proxy,
    server,
    logger,
    call(path, init = {}) {
      const { token = DOOR_TOKEN, ...rest } = init
      const headers = new Headers(rest.headers)
      if (!headers.has('authorization') && !headers.has('x-api-key')) headers.set('x-api-key', token)
      return fetch(`${url}${path}`, { ...rest, headers })
    },
    rows: () => ledger.pending(1000),
    async close() {
      if (closed) return
      closed = true
      await server.shutdown()
      dir.remove()
    },
  }
}

export const jsonBody = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

export const sse = (events: unknown[]): string =>
  events.map((event) => `event: x\ndata: ${JSON.stringify(event)}\n\n`).join('')

export const sseResponse = (text: string, headers: Record<string, string> = {}): Response =>
  new Response(text, { headers: { 'content-type': 'text/event-stream', ...headers } })

export const recordRow = (id: string, over: Partial<RecordRow> = {}): RecordRow => ({
  source: 'gateway',
  source_id: id,
  grain: 'message',
  ts: '2026-11-01T10:00:00.000Z',
  model_raw: 'priced-model',
  model: 'priced-model',
  billing: 'api_credit',
  account: 'iu',
  api_key: null,
  machine: 'test-machine',
  outcome: 'ok',
  lane: 'other',
  lane_detail: { caller: 'oc', pool: 'iu' },
  run_id: null,
  input_tokens: 10,
  output_tokens: 20,
  cache_read_tokens: 0,
  cache_write_5m_tokens: 0,
  cache_write_1h_tokens: 0,
  reasoning_tokens: 0,
  duration_ms: 5,
  cost_reported_usd: 1,
  raw: {},
  ...over,
})

export const pickRow = (id: string, picked = 'iu', over: Partial<PickRow> = {}): PickRow => ({
  ts: '2026-11-01T10:00:00.000Z',
  caller: 'oc',
  session: 's',
  picked,
  reason: 'soonest-expiry',
  machine: 'test-machine',
  request_id: id,
  ...over,
})

export const BALANCE_REFUSAL = {
  type: 'error',
  error: {
    type: 'invalid_request_error',
    message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade.',
  },
}

export const refusalResponse = (): Response => Response.json(BALANCE_REFUSAL, { status: 400 })

const MAIN = resolve(import.meta.dir, '..', 'src', 'main.ts')

/** The real entry as its own process. */
export function spawnGateway(env: Record<string, string>): Bun.Subprocess<'ignore', 'pipe', 'pipe'> {
  return Bun.spawn(['bun', MAIN], {
    env: { PATH: process.env.PATH ?? '', ...env },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
}

/** Reads the process's log until it listens; its port. */
export async function listening(proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>): Promise<number> {
  const decoder = new TextDecoder()
  let text = ''
  for await (const chunk of proc.stderr) {
    text += decoder.decode(chunk)
    const match = /"message":"listening","port":(\d+)/.exec(text)
    if (match?.[1] !== undefined) return Number(match[1])
  }
  throw new Error(`gateway did not start: ${text}`)
}

/** What a process start needs: a door file, an accounts file, the env naming them. */
export function processEnv(dir: string, iuBaseUrl: string): Record<string, string> {
  const door = join(dir, 'door-tokens')
  writeFileSync(door, `oc=${DOOR_TOKEN}\n`, { mode: 0o600 })
  const accounts = join(dir, 'accounts.json')
  writeJson(accounts, { accounts: { me: {} } })
  return {
    HOME: dir,
    AGW_GATEWAY_PORT: '0',
    AGW_GATEWAY_STATE_DIR: join(dir, 'state'),
    AGW_GATEWAY_ACCOUNTS_FILE: accounts,
    AGW_DOOR_CALLERS_FILE: door,
    AGW_API_SECRET: API_SECRET,
    IU_API_KEY: IU_KEY,
    IU_BASE_URL: iuBaseUrl,
  }
}

export const writeJson = (path: string, value: unknown): void => writeFileSync(path, JSON.stringify(value))

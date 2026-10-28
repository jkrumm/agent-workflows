import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentWaitOptions } from '@agent-workflows/runtime'
import {
  buildServerConfig,
  createClient,
  isServeOnPort,
  OpenCodeHost,
  OpenCodeServer,
  resolveOpencodeBinary,
  type ServerOptions,
  serverEnv,
} from '../src/index.ts'

// The supervisor against a real child process: `fake-opencode-bin.ts` stands in for `opencode serve`.
const BIN = ['bun', join(import.meta.dir, 'fake-opencode-bin.ts')]
const ENV = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  TMPDIR: process.env.TMPDIR,
  IU_API_KEY: 'test-key',
  IU_BASE_URL: 'https://iu.example.com/anthropic',
  OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:9',
  GITHUB_TOKEN: 'must-not-leak',
  AGW_TEST_PG_URL: 'must-not-leak',
}

const servers: OpenCodeServer[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close({ stop: true })
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
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

function server(stateDir: string, over: Partial<ServerOptions> = {}) {
  const warnings: string[] = []
  const s = new OpenCodeServer({
    stateDir,
    command: BIN,
    env: ENV,
    config: { test: true },
    livenessIntervalMs: 100,
    livenessTimeoutMs: 500,
    failuresBeforeRestart: 2,
    termGraceMs: 300,
    bootTimeoutMs: 10_000,
    logger: { warn: (m) => warnings.push(m), error: (m) => warnings.push(m) },
    ...over,
  })
  servers.push(s)
  return { s, warnings }
}

const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), 'och-srv-'))
  dirs.push(d)
  return d
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function until(check: () => boolean | Promise<boolean>, ms = 10_000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await check()) return
    await Bun.sleep(50)
  }
  throw new Error('condition not reached')
}

describe('OpenCodeServer', () => {
  test('spawns with the env allow-list only, its own HOME, the file-watcher off, state 0600', async () => {
    const dir = scratch()
    const { s } = server(dir)
    await s.start()
    const names = JSON.parse(readFileSync(join(dir, 'opencode/data/fake-env.json'), 'utf8')) as string[]
    const values = JSON.parse(readFileSync(join(dir, 'opencode/data/fake-env-values.json'), 'utf8'))
    expect(values).toEqual({ OPENCODE_DISABLE_FILEWATCHER: '1', HOME: join(dir, 'opencode/home') })
    expect(names).toContain('OTEL_EXPORTER_OTLP_ENDPOINT')
    expect(names).toContain('IU_KEY')
    expect(names).not.toContain('GITHUB_TOKEN')
    expect(names).not.toContain('AGW_TEST_PG_URL')
    expect(names).not.toContain('IU_API_KEY')
    const allowed = new Set([
      ...['PATH', 'HOME', 'TMPDIR', 'LANG', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME'],
      ...['OPENCODE_DB', 'OPENCODE_DISABLE_FILEWATCHER', 'OPENCODE_DISABLE_CLAUDE_CODE'],
      ...['OPENCODE_DISABLE_MODELS_FETCH', 'OPENCODE_DISABLE_AUTOUPDATE', 'OPENCODE_SERVER_PASSWORD'],
      ...[
        'OPENCODE_CONFIG_CONTENT',
        'IU_KEY',
        'IU_ANTHROPIC_BASE',
        'IU_OPENAI_BASE',
        'IU_KEY_ID',
        'OTEL_EXPORTER_OTLP_ENDPOINT',
      ],
    ])
    // Bun's own runtime adds a few to the child's view of process.env.
    expect(names.filter((n) => !allowed.has(n) && !n.startsWith('BUN_') && n !== '_')).toEqual([])
    expect(statSync(join(dir, 'opencode/server.json')).mode & 0o777).toBe(0o600)
  })

  test('a wedged server is SIGTERMed, then SIGKILLed, and restarted on the same port', async () => {
    const dir = scratch()
    const { s, warnings } = server(dir)
    await s.start()
    const { baseUrl } = s.endpoint()
    const before = s.pid as number
    await fetch(`${baseUrl}/__fake/hang`)
    await until(() => s.restartCount === 1)
    expect(alive(before)).toBe(false)
    expect(s.pid).not.toBe(before)
    expect(s.endpoint().baseUrl).toBe(baseUrl)
    expect(warnings).toContain('opencode server ignored SIGTERM, sending SIGKILL')
    expect((await createClient(() => s.endpoint()).info()).version).toBe('2.0.32')
  })

  test('a crashed server is restarted', async () => {
    const { s } = server(scratch())
    await s.start()
    const before = s.pid as number
    process.kill(before, 'SIGKILL')
    await until(() => s.restartCount === 1)
    await s.ready()
    expect(s.pid).not.toBe(before)
  })

  test('a new host process adopts the running server instead of spawning one', async () => {
    const dir = scratch()
    const first = server(dir).s
    await first.start()
    const pid = first.pid
    await first.close() // a deploy: supervision stops, the server keeps running
    servers.splice(servers.indexOf(first), 1)
    expect(alive(pid as number)).toBe(true)
    const second = server(dir).s
    await second.start()
    expect(second.pid).toBe(pid)
  })

  test('a server of another version is refused', async () => {
    const { s } = server(scratch(), { expectedVersion: '9.9.9', bootTimeoutMs: 1_000 })
    expect(await failure(s.start())).toContain('did not answer')
  })

  test('an adopted server whose env or config drifted is restarted, logged', async () => {
    const dir = scratch()
    const first = server(dir).s
    await first.start()
    const pid = first.pid as number
    await first.close()
    servers.splice(servers.indexOf(first), 1)
    const { s, warnings } = server(dir, { config: { test: 'changed by a deploy' } })
    await s.start()
    expect(s.pid).not.toBe(pid)
    expect(alive(pid)).toBe(false)
    expect(warnings).toContain('opencode server env or config changed since it started; restarting it')
    const state = JSON.parse(readFileSync(join(dir, 'opencode/server.json'), 'utf8'))
    expect(Object.keys(state).sort()).toEqual(['fingerprint', 'password', 'pid', 'port'])
    expect(state.pid).toBe(s.pid)
  })

  test('a server whose pid is not the recorded child is neither adopted nor signalled', async () => {
    const dir = scratch()
    const first = server(dir).s
    await first.start()
    const pid = first.pid as number
    await first.close()
    servers.splice(servers.indexOf(first), 1)
    const path = join(dir, 'opencode/server.json')
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), pid: 1 }))
    const { s } = server(dir)
    expect(await failure(s.start())).toContain('is not ours to adopt or signal')
    expect(alive(pid)).toBe(true) // untouched
    process.kill(pid, 'SIGKILL')
  })

  test('a child of ours that is alive but never answers is terminated on adopt, then replaced', async () => {
    const dir = scratch()
    const first = server(dir).s
    await first.start()
    const pid = first.pid as number
    await first.close()
    servers.splice(servers.indexOf(first), 1)
    await fetch(`${first.endpoint().baseUrl}/__fake/hang`) // alive, holds the port, answers nothing, ignores SIGTERM
    const { s, warnings } = server(dir)
    await s.start()
    expect(warnings).toContain('opencode server from server.json is alive but not answering; terminating it')
    expect(alive(pid)).toBe(false)
    expect(s.pid).not.toBe(pid)
    expect(JSON.parse(readFileSync(join(dir, 'opencode/server.json'), 'utf8')).pid).toBe(s.pid)
  })

  test('a corrupt server.json fails start with its path, once', async () => {
    const dir = scratch()
    mkdirSync(join(dir, 'opencode'), { recursive: true })
    writeFileSync(join(dir, 'opencode/server.json'), '{ not json')
    const { s } = server(dir)
    expect(await failure(s.start())).toContain(`${join(dir, 'opencode/server.json')} is corrupt`)
    expect(s.pid).toBeNull()
  })

  test('a wait in flight re-attaches across a liveness kill and finishes without a second prompt', async () => {
    const dir = scratch()
    const { s } = server(dir)
    await s.start()
    const host = new OpenCodeHost({
      server: s,
      agents: [{ name: 'tester', agentsMd: '# t\n', route: 'check' }],
      stateDir: dir,
      pollIntervalMs: 30,
      cutoffGraceMs: 150,
      env: {},
      logger: { warn: () => {}, error: () => {} },
    })
    try {
      const handle = await host.open({ runId: 'r', stepId: 's', key: 'r:s', agent: 'tester', prompt: 'p' })
      await host.prompt(handle, '[slow:1500] long work')
      const options: AgentWaitOptions = {
        signal: new AbortController().signal,
        onProgress: () => {},
        onTool: async () => {},
      }
      const waiting = host.wait(handle, options)
      await Bun.sleep(200)
      await fetch(`${s.endpoint().baseUrl}/__fake/hang`)
      const result = await waiting
      expect(s.restartCount).toBe(1)
      expect(result.output).toBe('resumed: echo: [slow:1500] long work')
      const messages = await createClient(() => s.endpoint()).messages((handle as { sessionId: string }).sessionId)
      expect(messages.filter((m) => m.type === 'user')).toHaveLength(1)
    } finally {
      host.close()
    }
  }, 20_000)
})

describe('serverEnv', () => {
  const iu = { IU_API_KEY: 'k', IU_BASE_URL: 'https://example.com/anthropic' }
  const envOf = (extra: Record<string, string>) =>
    serverEnv({ root: '/r', password: 'p', config: {}, env: { PATH: '/bin', ...iu, ...extra } })

  test('IU_KEY_ID is the parsed label, always set; never the key', () => {
    expect(envOf({ IU_KEY_ID: 'athena-team' }).IU_KEY_ID).toBe('athena-team')
    expect(envOf({ IU_KEY_ID: 'personal' }).IU_KEY_ID).toBe('personal')
    expect(envOf({}).IU_KEY_ID).toBe('personal')
    expect(envOf({ IU_KEY_ID: 'junk' }).IU_KEY_ID).toBe('personal')
  })
})

describe('isServeOnPort', () => {
  test('matches the port token exactly and needs a serve argument', () => {
    expect(isServeOnPort('/x/opencode serve --hostname 127.0.0.1 --port 4096', 4096)).toBe(true)
    expect(isServeOnPort('/x/opencode serve --port=4096', 4096)).toBe(true)
    expect(isServeOnPort('/x/opencode serve --hostname 127.0.0.1 --port 40960', 4096)).toBe(false)
    expect(isServeOnPort('/x/opencode serve --port=40960', 4096)).toBe(false)
    expect(isServeOnPort('/x/opencode run --port 4096', 4096)).toBe(false)
    expect(isServeOnPort('/x/opencode-serve --port 4096', 4096)).toBe(false)
  })
})

describe('resolveOpencodeBinary', () => {
  test('follows a shim on PATH to the real binary; AGW_OPENCODE_BIN wins', () => {
    const dir = scratch()
    const home = join(dir, 'home')
    const real = join(home, 'pinned', 'opencode.exe')
    mkdirSync(join(home, 'pinned'), { recursive: true })
    writeFileSync(real, '\x7fELF')
    chmodSync(real, 0o755)
    mkdirSync(join(dir, 'bin'))
    const shim = join(dir, 'bin', 'opencode')
    writeFileSync(shim, '#!/usr/bin/env bash\nset -e\nbin="$HOME/pinned/opencode.exe"\nexec "$bin" "$@"\n')
    chmodSync(shim, 0o755)
    expect(resolveOpencodeBinary({ PATH: join(dir, 'bin'), HOME: home })).toBe(realpathSync(real))
    expect(resolveOpencodeBinary({ PATH: '', AGW_OPENCODE_BIN: real })).toBe(realpathSync(real))
    expect(() => resolveOpencodeBinary({ PATH: join(dir, 'nothing') })).toThrow('opencode not found')
  })
})

describe('buildServerConfig', () => {
  test('every opencode route has a model row on an IU provider, priced from the table, no literal key', () => {
    const config = buildServerConfig({}) as {
      providers: Record<string, { settings: { apiKey: string }; models: Record<string, { cost?: unknown }> }>
      permissions: { action: string; effect: string }[]
    }
    const rows = Object.values(config.providers).flatMap((p) => Object.values(p.models))
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) expect(row.cost).toBeDefined()
    for (const p of Object.values(config.providers)) expect(p.settings.apiKey).toBe('{env:IU_KEY}')
    expect(config.permissions.map((r) => `${r.action}:${r.effect}`)).toEqual([
      'question:deny',
      'external_directory:deny',
    ])
  })
})

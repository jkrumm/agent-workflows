import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { CLAUDE_MODELS, claudeRate, effortsOf, opencodeModels, resolveRoute } from '@agent-workflows/routes'
import type { AgentWaitOptions } from '@agent-workflows/runtime'
import {
  buildServerConfig,
  createClient,
  gatewayFromEnv,
  installPlugin,
  isServeOnPort,
  OpenCodeHost,
  OpenCodeServer,
  resolveOpencodeBinary,
  type ServerOptions,
  serverEnv,
} from '../src/index.ts'
import {
  ATTRIBUTION_PLUGIN,
  fallbackModelRef,
  modelRef,
  opencodeRoutes,
  PROVIDER_ANTHROPIC,
  PROVIDER_CHAT,
  PROVIDER_RESPONSES,
} from '../src/config.ts'
import { attributionOf } from './attribution.ts'

// The supervisor against a real child process: the testing package's `fake-opencode-bin.ts` stands in for `opencode serve`.
const BIN = ['bun', Bun.fileURLToPath(import.meta.resolve('@agent-workflows/testing/opencode-bin'))]
const ENV = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  TMPDIR: process.env.TMPDIR,
  AGW_GATEWAY_URL: 'http://127.0.0.1:7794',
  AGW_GATEWAY_TOOL_TOKEN: 'door-token',
  OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:9',
  GITHUB_TOKEN: 'must-not-leak',
  AGW_TEST_PG_URL: 'must-not-leak',
  AGW_API_SECRET: 'must-not-leak',
  IU_API_KEY: 'must-not-leak',
  IU_BASE_URL: 'https://iu.example.com/anthropic',
  IU_KEY_ID: 'personal',
  ANTHROPIC_API_KEY: 'must-not-leak',
}

/** Nothing of these reaches the server or a tool shell: the door token is its only credential. */
const FORBIDDEN = [
  'GITHUB_TOKEN',
  'AGW_TEST_PG_URL',
  'AGW_API_SECRET',
  'IU_API_KEY',
  'IU_BASE_URL',
  'IU_KEY',
  'IU_KEY_ID',
  'IU_ANTHROPIC_BASE',
  'IU_OPENAI_BASE',
  'ANTHROPIC_API_KEY',
]

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
    expect(values).toEqual({
      OPENCODE_DISABLE_FILEWATCHER: '1',
      HOME: join(dir, 'opencode/home'),
    })
    expect(names).toContain('OTEL_EXPORTER_OTLP_ENDPOINT')
    expect(names).toContain('AGW_GATEWAY_URL')
    expect(names).toContain('AGW_GATEWAY_TOOL_TOKEN')
    for (const name of FORBIDDEN) expect(names).not.toContain(name)
    const allowed = new Set([
      ...['PATH', 'HOME', 'TMPDIR', 'LANG', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME'],
      ...['OPENCODE_DB', 'OPENCODE_DISABLE_FILEWATCHER', 'OPENCODE_DISABLE_CLAUDE_CODE'],
      ...['OPENCODE_DISABLE_MODELS_FETCH', 'OPENCODE_DISABLE_AUTOUPDATE', 'OPENCODE_SERVER_PASSWORD'],
      ...['OPENCODE_CONFIG_CONTENT', 'AGW_GATEWAY_URL', 'AGW_GATEWAY_TOOL_TOKEN', 'OTEL_EXPORTER_OTLP_ENDPOINT'],
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

  describe('a server that cannot be started again', () => {
    /** The fake binary until `down` exists, then a process that exits at once (a binary gone, a port taken). */
    function breakable() {
      const dir = scratch()
      const down = join(dir, 'down')
      const script = join(dir, 'opencode.sh')
      writeFileSync(script, `#!/bin/sh\n[ -e "${down}" ] && exit 1\nexec ${BIN.join(' ')} "$@"\n`)
      return { dir, command: ['sh', script], down }
    }
    const failedStarts = (warnings: string[]) => warnings.filter((w) => w === 'opencode server failed to start').length

    test('ready rejects after the configured failed boots in a row instead of blocking, and recovers on restart', async () => {
      const b = breakable()
      const { s, warnings } = server(b.dir, { command: b.command, bootFailuresBeforeFail: 2 })
      await s.start()
      writeFileSync(b.down, '')
      process.kill(s.pid as number, 'SIGKILL')
      await until(() => warnings.includes('opencode server restart')) // the gate is closed from here
      expect(await failure(s.ready())).toContain('failed to start 2 times in a row')
      rmSync(b.down)
      await s.restart('operator')
      await s.ready()
      expect(s.restartCount).toBeGreaterThanOrEqual(1)
    })

    test('an aborted ready rejects during the respawn loop; the loop goes on', async () => {
      const b = breakable()
      const { s, warnings } = server(b.dir, { command: b.command, bootFailuresBeforeFail: 100 })
      await s.start()
      writeFileSync(b.down, '')
      process.kill(s.pid as number, 'SIGKILL')
      await until(() => failedStarts(warnings) >= 1)
      const ctl = new AbortController()
      const waiting = s.ready(ctl.signal)
      ctl.abort(new Error('cancelled'))
      expect(await failure(waiting)).toBe('cancelled')
      expect(await failure(s.ready(ctl.signal))).toBe('cancelled') // already aborted
      rmSync(b.down)
      await s.ready() // the loop was not stopped by the abort: the next boot succeeds
    })

    test('close during the backoff ends the loop at once and does not reopen the gate', async () => {
      const b = breakable()
      const { s, warnings } = server(b.dir, { command: b.command, bootFailuresBeforeFail: 100 })
      await s.start()
      writeFileSync(b.down, '')
      process.kill(s.pid as number, 'SIGKILL')
      await until(() => failedStarts(warnings) >= 1) // now in the 1 s backoff
      rmSync(b.down) // a boot after the backoff would succeed
      const started = Date.now()
      await s.close()
      expect(Date.now() - started).toBeLessThan(800)
      expect(await failure(s.ready())).toContain('closed')
      expect(s.restartCount).toBe(0)
      expect(failedStarts(warnings)).toBe(1)
    })
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
    const { s } = server(scratch(), {
      expectedVersion: '9.9.9',
      bootTimeoutMs: 1_000,
    })
    expect(await failure(s.start())).toContain('did not answer')
  })

  test('an adopted server whose env or config drifted is restarted, logged', async () => {
    const dir = scratch()
    const first = server(dir).s
    await first.start()
    const pid = first.pid as number
    await first.close()
    servers.splice(servers.indexOf(first), 1)
    const { s, warnings } = server(dir, {
      config: { test: 'changed by a deploy' },
    })
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
    // `ready` runs at the top of every poll of a wait: two calls mean the wait is in flight and has read the session once
    let polls = 0
    const host = new OpenCodeHost({
      server: {
        endpoint: () => s.endpoint(),
        ready: (signal) => {
          polls++
          return s.ready(signal)
        },
      },
      agents: [{ name: 'tester', agentsMd: '# t\n', route: 'check' }],
      stateDir: dir,
      pollIntervalMs: 30,
      cutoffGraceMs: 150,
      logger: { warn: () => {}, error: () => {} },
    })
    try {
      const handle = await host.open({
        runId: 'r',
        stepId: 's',
        attribution: attributionOf('r', 's'),
        key: 'r:s',
        agent: 'tester',
        prompt: 'p',
      })
      await host.prompt(handle, '[slow:1500] long work')
      const options: AgentWaitOptions = {
        signal: new AbortController().signal,
        onProgress: () => {},
        onTool: async () => {},
      }
      const waiting = host.wait(handle, options)
      await until(() => polls >= 2)
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
  const GATEWAY = { AGW_GATEWAY_URL: 'http://127.0.0.1:7794', AGW_GATEWAY_TOOL_TOKEN: ' door-token ' }
  const envOf = (env: Record<string, string>) => serverEnv({ root: '/r', password: 'p', config: {}, env })

  test('the gateway address and door token pass, trimmed; no provider key or API secret, whatever is set', () => {
    const out = envOf({
      PATH: '/bin',
      ...GATEWAY,
      AGW_API_SECRET: 'sekret-api',
      IU_API_KEY: 'sekret-iu',
      IU_BASE_URL: 'https://iu.example.com/anthropic',
      IU_KEY_ID: 'personal',
      ANTHROPIC_API_KEY: 'sekret-anthropic',
    })
    expect(out.AGW_GATEWAY_URL).toBe('http://127.0.0.1:7794')
    expect(out.AGW_GATEWAY_TOOL_TOKEN).toBe('door-token')
    for (const name of FORBIDDEN) expect(name in out).toBe(false)
    expect(JSON.stringify(out)).not.toContain('sekret')
  })

  test('both gateway variables are required; the message names the variable, never a value', () => {
    expect(() => envOf({ AGW_GATEWAY_TOOL_TOKEN: 'sekret' })).toThrow('AGW_GATEWAY_URL is not set')
    expect(() => envOf({ AGW_GATEWAY_URL: 'http://127.0.0.1:7794' })).toThrow('AGW_GATEWAY_TOOL_TOKEN is not set')
    expect(() => envOf({ ...GATEWAY, AGW_GATEWAY_TOOL_TOKEN: '  ' })).toThrow('AGW_GATEWAY_TOOL_TOKEN is not set')
  })
})

describe('gatewayFromEnv', () => {
  const of = (url: string) => gatewayFromEnv({ AGW_GATEWAY_URL: url, AGW_GATEWAY_TOOL_TOKEN: 't' })

  test('the origin, without a trailing slash', () => {
    expect(of('http://127.0.0.1:7794/')).toEqual({ url: 'http://127.0.0.1:7794', token: 't' })
  })

  test('anything but an http(s) origin is refused, and the value stays out of the message', () => {
    for (const url of ['not a url', 'ftp://sekret.example.com', 'http://sekret.example.com/anthropic']) {
      let message = ''
      try {
        of(url)
      } catch (err) {
        message = (err as Error).message
      }
      expect(message).toStartWith('AGW_GATEWAY_URL')
      expect(message).not.toContain('sekret')
    }
    expect(() => of('http://user:sekret@example.com')).toThrow('must be an http(s) origin')
    expect(() => of('http://:sekret@example.com')).toThrow('must be an http(s) origin')
  })
})

describe('installPlugin', () => {
  test('a copy under the root, named by its content: the same path on every start, whatever the release', () => {
    const root = scratch()
    const dir = installPlugin(root)
    expect(dir.startsWith(join(root, 'plugins/agw-attribution-'))).toBe(true)
    expect(readFileSync(join(dir, 'server.js'), 'utf8')).toBe(
      readFileSync(join(ATTRIBUTION_PLUGIN, 'server.js'), 'utf8'),
    )
    expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).type).toBe('module')
    // The second call's rename finds the directory there, as a concurrent start's would: no throw, no leftover.
    expect(installPlugin(root)).toBe(dir)
    expect(readdirSync(join(root, 'plugins'))).toHaveLength(1)
  })

  test('with no way to make the copy, the start fails', () => {
    const root = scratch()
    writeFileSync(join(root, 'plugins'), 'a file where the directory goes')
    expect(() => installPlugin(root)).toThrow()
  })

  test('the plugin directory is the two tracked files, with no build step', () => {
    expect(readdirSync(ATTRIBUTION_PLUGIN).sort()).toEqual(['package.json', 'server.js'])
  })

  test('a server loads the installed copy, not the release path', async () => {
    const dir = scratch()
    const { s } = server(dir, { config: undefined })
    await s.start()
    const config = JSON.parse(readFileSync(join(dir, 'opencode/data/fake-config.json'), 'utf8')) as {
      plugins: string[]
    }
    expect(config.plugins).toEqual([installPlugin(join(dir, 'opencode'))])
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
  test('every opencode route has a model row on a gateway provider, priced from the table, the door token by reference', () => {
    const config = buildServerConfig() as {
      providers: Record<
        string,
        {
          settings: { apiKey: string; baseURL: string }
          models: Record<string, { cost?: unknown }>
        }
      >
      permissions: { action: string; effect: string }[]
    }
    const rows = Object.values(config.providers).flatMap((p) => Object.values(p.models))
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) expect(row.cost).toBeDefined()
    for (const [id, p] of Object.entries(config.providers)) {
      expect(p.settings.apiKey).toBe('{env:AGW_GATEWAY_TOOL_TOKEN}')
      expect(p.settings.baseURL).toBe(
        id === PROVIDER_ANTHROPIC ? '{env:AGW_GATEWAY_URL}/anthropic/v1' : '{env:AGW_GATEWAY_URL}/openai/v1',
      )
    }
    expect(config.permissions.map((r) => `${r.action}:${r.effect}`)).toEqual([
      '*:deny',
      'read:allow',
      'glob:allow',
      'grep:allow',
      'skill:allow',
      'question:deny',
      'external_directory:deny',
    ])
  })
})

describe('buildServerConfig: routes that share a model', () => {
  type Row = { limit?: { output?: number; context?: number }; cost?: { input: number } }
  const rowOf = (config: Record<string, unknown>, model: string) =>
    (config.providers as Record<string, { models: Record<string, Row> }>)[PROVIDER_ANTHROPIC]?.models[model]
  const base = resolveRoute('check')
  const route = (id: string, over: Partial<ReturnType<typeof resolveRoute>>) =>
    ({ ...base, id, ...over }) as ReturnType<typeof resolveRoute>

  test('the row takes the strictest output limit of the routes naming the model, whichever comes first', () => {
    const wide = route('brain.agent', { maxOutputTokens: 32_000 })
    const narrow = route('research.agent', { maxOutputTokens: 16_000 })
    for (const routes of [
      [wide, narrow],
      [narrow, wide],
    ]) {
      const config = buildServerConfig({ routes })
      expect(rowOf(config, base.model)?.limit?.output).toBe(16_000)
      // the bounded copies are made from that row
      expect(rowOf(config, `${base.model}~ctx100000`)?.limit?.output).toBe(16_000)
    }
  })

  test('a route with no limit does not widen the row of a limited one, and a model no route limits has none', () => {
    const open = route('check', {})
    delete open.maxOutputTokens
    const limited = route('otel.agent', { maxOutputTokens: 16_000 })
    expect(rowOf(buildServerConfig({ routes: [open, limited] }), base.model)?.limit?.output).toBe(16_000)
    expect(rowOf(buildServerConfig({ routes: [open] }), base.model)?.limit).toBeUndefined()
  })

  test('different rates for one model fail the build, naming the model and the routes', () => {
    const rate = base.rate as NonNullable<typeof base.rate>
    const dearer = route('research.agent', { rate: { ...rate, outputPerM: rate.outputPerM * 2 } })
    expect(() => buildServerConfig({ routes: [route('check', {}), dearer] })).toThrow(
      new RegExp(`model "${base.model}" has different rates on routes check, research.agent`),
    )
    // the same rate on every route is one row, priced from it
    expect(
      rowOf(buildServerConfig({ routes: [route('check', {}), route('otel.agent', {})] }), base.model)?.cost?.input,
    ).toBe(rate.inputPerM)
  })

  test('the table itself builds: every shared model has one consistent rate', () => {
    expect(() => buildServerConfig()).not.toThrow()
  })
})

describe('buildServerConfig: the gateway', () => {
  const secrets = {
    AGW_API_SECRET: 'sekret-api',
    IU_API_KEY: 'sekret-iu',
    IU_BASE_URL: 'https://sekret.example.com/anthropic',
    ANTHROPIC_API_KEY: 'sekret-anthropic',
    AGW_GATEWAY_TOOL_TOKEN: 'sekret-door',
    AGW_GATEWAY_URL: 'http://sekret.example.com',
  }

  test('the config holds no credential and no address, and names no IU variable, whatever the environment holds', () => {
    const before = Object.fromEntries(Object.keys(secrets).map((key) => [key, process.env[key]]))
    Object.assign(process.env, secrets)
    try {
      const text = JSON.stringify(buildServerConfig())
      expect(text).not.toContain('sekret')
      expect(text).not.toMatch(/IU_|ANTHROPIC_API_KEY|AGW_API_SECRET|api\.anthropic\.com/)
      expect(text.match(/\{env:[A-Z_]+\}/g)?.every((v) => /AGW_GATEWAY_(URL|TOOL_TOKEN)/.test(v))).toBe(true)
    } finally {
      for (const [key, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  test('only the Anthropic leg sends x-agw-fallback: none, as a static header', () => {
    const { providers } = buildServerConfig() as { providers: Record<string, { headers?: unknown }> }
    expect(providers[PROVIDER_ANTHROPIC]?.headers).toEqual({ 'x-agw-fallback': 'none' })
    expect(providers[PROVIDER_CHAT]?.headers).toBeUndefined()
    expect(providers[PROVIDER_RESPONSES]?.headers).toBeUndefined()
  })

  test("the plugin is one absolute directory, the package's by default", () => {
    expect((buildServerConfig() as { plugins: string[] }).plugins).toEqual([ATTRIBUTION_PLUGIN])
    expect(isAbsolute(ATTRIBUTION_PLUGIN)).toBe(true)
    expect((buildServerConfig({ plugin: '/state/p' }) as { plugins: string[] }).plugins).toEqual(['/state/p'])
  })
})

describe('buildServerConfig: the HARD agent route', () => {
  test('the retro agent row is Sonnet on the native Anthropic provider, and the route’s fallback is Terra on Responses with its cost rows', () => {
    const config = buildServerConfig() as {
      providers: Record<string, { models: Record<string, { cost?: unknown }> }>
    }
    expect(modelRef('retro.analyze', {}).model).toMatchObject({
      providerID: PROVIDER_ANTHROPIC,
      id: 'claude-sonnet-5-5',
    })
    expect(config.providers[PROVIDER_ANTHROPIC]?.models['claude-sonnet-5-5']).toBeDefined()
    const fallback = fallbackModelRef('retro.analyze', {})
    expect(fallback?.model).toMatchObject({
      providerID: PROVIDER_RESPONSES,
      id: 'gpt-6.1-terra',
    })
    expect(config.providers[PROVIDER_RESPONSES]?.models[fallback?.model.id ?? '']?.cost).toMatchObject({
      input: 1,
      output: 5,
    })
  })
})

describe('buildServerConfig: the provider follows the model family, whatever other routes share the id', () => {
  // The Claude seats run on the native Anthropic provider; this patch pins a Claude model onto `brain.agent` with no effort and no fallback.
  const claudePatch = { 'brain.agent': { model: 'claude-haiku-5-5', effort: null, fallback: null } }
  const providerOf = (model: string) =>
    model.startsWith('gpt-') ? PROVIDER_RESPONSES : model.startsWith('claude-') ? PROVIDER_ANTHROPIC : PROVIDER_CHAT

  test('every opencode-wire route and fallback sits on the provider of its family: Claude native, gpt Responses, the rest chat', () => {
    const config = buildServerConfig() as {
      providers: Record<string, { models: Record<string, unknown> }>
    }
    const routes = opencodeRoutes()
    expect(routes.length).toBeGreaterThan(0)
    for (const route of routes) {
      const home = Object.entries(config.providers)
        .filter(([, p]) => route.model in p.models)
        .map(([id]) => id)
      expect(home).toEqual([providerOf(route.model)])
    }
    const claude = routes.filter((r) => r.model.startsWith('claude-'))
    expect(claude.length).toBeGreaterThan(0)
    for (const route of claude) expect(config.providers[PROVIDER_ANTHROPIC]?.models[route.model]).toBeDefined()
  })

  test('the agent routes run Claude on the native Anthropic provider and fall back to Terra on Responses', () => {
    expect(resolveRoute('cheap.classify', {})).toMatchObject({
      wire: 'anthropic',
      model: 'claude-haiku-5-5',
    })
    for (const id of ['retro.analyze'] as const) {
      expect(modelRef(id, {}).model).toMatchObject({ providerID: PROVIDER_ANTHROPIC, id: 'claude-sonnet-5-5' })
      expect(fallbackModelRef(id, {})?.model).toMatchObject({ providerID: PROVIDER_RESPONSES, id: 'gpt-6.1-terra' })
    }
    for (const id of ['check', 'brain.agent', 'diagram.agent', 'otel.agent', 'research.agent'] as const) {
      expect(modelRef(id, {}).model).toMatchObject({ providerID: PROVIDER_ANTHROPIC, id: 'claude-haiku-5-5' })
      expect(fallbackModelRef(id, {})?.model).toMatchObject({ providerID: PROVIDER_RESPONSES, id: 'gpt-6.1-terra' })
    }
    // a route bounded at 100k runs Haiku through its bounded row; its fallback is unbounded
    const bounded = { 'research.agent': { contextLimit: 100_000 } }
    expect(modelRef('research.agent', bounded).model).toMatchObject({
      providerID: PROVIDER_ANTHROPIC,
      id: 'claude-haiku-5-5~ctx100000',
    })
    expect(fallbackModelRef('research.agent', bounded)?.model).toMatchObject({
      providerID: PROVIDER_RESPONSES,
      id: 'gpt-6.1-terra',
    })
    expect(modelRef('brain.agent', claudePatch).model).toMatchObject({
      providerID: PROVIDER_ANTHROPIC,
      id: 'claude-haiku-5-5',
    })
    const config = buildServerConfig() as {
      providers: Record<string, { models: Record<string, { compatibility?: unknown }> }>
    }
    expect(config.providers[PROVIDER_ANTHROPIC]?.models['claude-haiku-5-5']?.compatibility).toEqual({
      supportsThinkingBlockBinding: false,
    })
    const provider = (config.providers[PROVIDER_ANTHROPIC] ?? {}) as {
      package?: string
      name?: string
      settings?: unknown
    }
    expect(PROVIDER_ANTHROPIC).toBe('anthropic')
    expect(provider).toMatchObject({
      package: 'aisdk:@ai-sdk/anthropic',
      name: 'Anthropic through the gateway',
      settings: { baseURL: '{env:AGW_GATEWAY_URL}/anthropic/v1', apiKey: '{env:AGW_GATEWAY_TOOL_TOKEN}' },
    })
    // a single-call model never lands in the agent providers: Luna is only a single-call fallback and the TTS prep
    expect(config.providers[PROVIDER_RESPONSES]?.models['gpt-6-luna']).toBeUndefined()
  })

  test('every Claude model is served on the Anthropic provider, priced with its table rate, Opus included', () => {
    const config = buildServerConfig() as {
      providers: Record<string, { models: Record<string, { cost?: { input: number; output: number } }> }>
    }
    const rows = config.providers[PROVIDER_ANTHROPIC]?.models ?? {}
    for (const model of CLAUDE_MODELS) {
      expect(rows[model]?.cost).toMatchObject({
        input: claudeRate(model)?.inputPerM,
        output: claudeRate(model)?.outputPerM,
      })
    }
    expect(Object.keys(rows)).toContain('claude-opus-5-5')
    expect(
      modelRef('research.agent', { 'research.agent': { model: 'claude-opus-5-5', effort: 'medium' } }).model,
    ).toEqual({
      providerID: PROVIDER_ANTHROPIC,
      id: 'claude-opus-5-5',
      variant: 'medium',
    })
  })

  test('the served models of the config are exactly opencodeModels()', () => {
    const config = buildServerConfig() as { providers: Record<string, { models: Record<string, unknown> }> }
    // The bounded `<model>~ctx<limit>` rows of the Claude models are aliases of these (`context-limit.test.ts`).
    const served = Object.values(config.providers).flatMap((p) =>
      Object.keys(p.models).filter((m) => !m.includes('~ctx')),
    )
    expect(new Set(served)).toEqual(new Set(opencodeModels()))
    expect(served.length).toBe(opencodeModels().size)
  })
})

describe('buildServerConfig: every effort variant of every served model', () => {
  type Rows = Record<string, { models: Record<string, { variants?: { id: string; settings: unknown }[] }> }>
  const providers = () => (buildServerConfig() as { providers: Rows }).providers

  test('each model row carries exactly the efforts its provider takes (a Sonnet no none, DeepSeek its four levels)', () => {
    for (const route of opencodeRoutes()) {
      const row = Object.values(providers()).find((p) => route.model in p.models)?.models[route.model]
      expect(row?.variants?.map((v) => v.id)).toEqual([...effortsOf(route.model)])
    }
  })

  test('Claude variants use the Anthropic options, not reasoningEffort: none disables thinking, the rest are adaptive', () => {
    const haiku = providers()[PROVIDER_ANTHROPIC]?.models['claude-haiku-5-5']?.variants
    expect(haiku?.find((v) => v.id === 'none')).toEqual({ id: 'none', settings: { thinking: { type: 'disabled' } } })
    expect(haiku?.find((v) => v.id === 'high')).toEqual({
      id: 'high',
      settings: { effort: 'high', thinking: { type: 'adaptive' } },
    })
  })

  test('the other providers take reasoningEffort', () => {
    const terra = providers()[PROVIDER_RESPONSES]?.models['gpt-6.1-terra']?.variants
    expect(terra?.find((v) => v.id === 'xhigh')).toEqual({ id: 'xhigh', settings: { reasoningEffort: 'xhigh' } })
  })

  test("an arm's effort or model move resolves to a variant the running config registers", () => {
    const rows = providers()
    for (const model of opencodeModels()) {
      for (const effort of effortsOf(model)) {
        const { model: ref } = modelRef('check', { check: { model, effort } })
        const row = rows[ref.providerID]?.models[ref.id]
        expect(row?.variants?.some((v) => v.id === ref.variant)).toBe(true)
      }
    }
  })
})

describe('buildServerConfig: fallbacks', () => {
  test('the Responses provider has one Terra row: the agent fallbacks share it', () => {
    const responses = (buildServerConfig() as { providers: Record<string, { package: string; models: object }> })
      .providers['iu-responses']
    expect(responses?.package).toBe('aisdk:@ai-sdk/openai')
    expect(Object.keys(responses?.models ?? {})).toEqual(['gpt-6.1-terra'])
  })
})

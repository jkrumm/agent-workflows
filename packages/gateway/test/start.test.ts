import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { ConfigError, loadConfig } from '../src/config.ts'
import { Ledger } from '../src/ledger.ts'
import { resolveKeys, secretsRunReader } from '../src/secrets.ts'
import { decodeBody, UsageTee } from '../src/tee.ts'
import {
  DOOR_TOKEN,
  fakeUpstream,
  jsonBody,
  listening,
  pool,
  processEnv,
  silentLogger,
  spawnGateway,
  tempDir,
  writeJson,
} from './support.ts'

let dir: ReturnType<typeof tempDir>
let doorFile: string
let accountsFile: string
let baseEnv: () => Record<string, string>

beforeEach(() => {
  dir = tempDir()
  const env = processEnv(dir.path, 'http://127.0.0.1:1/anthropic')
  doorFile = env.AGW_DOOR_CALLERS_FILE as string
  accountsFile = env.AGW_GATEWAY_ACCOUNTS_FILE as string
  baseEnv = () => {
    const { AGW_GATEWAY_PORT: _port, ...rest } = env
    return rest
  }
})

afterEach(() => dir.remove())

const MAIN = resolve(import.meta.dir, '..', 'src', 'main.ts')

const FAKE_SECRETS_RUN = `#!/bin/sh
case "$2" in
  op://good) echo "sk-real" ;;
  op://placeholder) echo "REPLACE_ME" ;;
  *) echo "sensitive noise" >&2; exit 3 ;;
esac
`

const problemsOf = (env: Record<string, string | undefined>): string[] => {
  try {
    loadConfig(env)
  } catch (error) {
    if (error instanceof ConfigError) return error.problems
    throw error
  }
  return []
}

describe('config', () => {
  test('defaults and derived IU bases', () => {
    const config = loadConfig({ ...baseEnv(), IU_BASE_URL: 'https://iu.example/gw/anthropic/' })
    expect(config.port).toBe(7793)
    expect(config.ledgerPath).toBe(join(dir.path, 'state', 'ledger.sqlite'))
    expect(config.iu).toEqual({
      apiKey: 'fake-iu-key',
      anthropicBase: 'https://iu.example/gw/anthropic',
      root: 'https://iu.example/gw',
      origin: 'https://iu.example',
    })
    expect(config.build).toBe('dev')
    expect(config.usagePgUrl).toBeNull()
  })

  test('every problem is named at once and no value is echoed', () => {
    const problems = problemsOf({
      AGW_GATEWAY_PORT: 'many',
      AGW_API_SECRET: 'short-secret-value',
      IU_API_KEY: '',
      IU_BASE_URL: 'https://iu.example/openai',
      IU_KEY_ID: 'athena-team',
      AGW_GATEWAY_ACCOUNTS_FILE: join(dir.path, 'absent.json'),
      AGW_DOOR_CALLERS_FILE: join(dir.path, 'absent-door'),
    })
    const text = problems.join('\n')
    for (const name of [
      'AGW_GATEWAY_PORT',
      'AGW_GATEWAY_STATE_DIR',
      'AGW_API_SECRET',
      'IU_API_KEY',
      'IU_KEY_ID',
      'AGW_GATEWAY_ACCOUNTS_FILE',
      'door tokens',
    ]) {
      expect(text).toContain(name)
    }
    expect(text).not.toContain('short-secret-value')
    expect(text).not.toContain('athena-team')
  })

  test('IU_KEY_ID unset or personal is accepted', () => {
    expect(problemsOf(baseEnv())).toEqual([])
    expect(problemsOf({ ...baseEnv(), IU_KEY_ID: 'personal' })).toEqual([])
  })

  test('a door-token file of the wrong mode is refused, like the audio door', () => {
    chmodSync(doorFile, 0o644)
    expect(problemsOf(baseEnv()).join()).toContain('mode 0600')
  })

  test('a malformed registry is named', () => {
    writeJson(accountsFile, { accounts: { iu: { platform: { creditUsd: -1 } } } })
    expect(problemsOf(baseEnv()).join()).toContain('registry: account "iu"')
  })
})

describe('keys', () => {
  const read = (values: Record<string, string>) => (ref: string) => {
    const value = values[ref]
    return Promise.resolve(value === undefined ? { reason: 'nope' } : { value })
  }

  test('a failed ref disables that pool, logged without a value; a disabled pool is not read', async () => {
    const logger = silentLogger()
    const reads: string[] = []
    const { keys, adminKeys } = await resolveKeys({
      registry: [
        pool('iu', { apiKeyRef: 'op://a', adminKeyRef: 'op://aa' }),
        pool('me', { apiKeyRef: 'op://b', adminKeyRef: 'op://bb' }),
        pool('me2', { enabled: false, apiKeyRef: 'op://c' }),
      ],
      read: (ref) => {
        reads.push(ref)
        return read({ 'op://a': 'secret-api', 'op://aa': 'secret-admin' })(ref)
      },
      logger,
    })
    expect(keys.get('iu')).toBe('secret-api')
    expect(keys.get('me')).toBeUndefined()
    expect(adminKeys).toEqual(new Map([['iu', 'secret-admin']]))
    expect(reads).not.toContain('op://c')
    expect(logger.lines).toHaveLength(2)
    expect(JSON.stringify(logger.lines)).not.toContain('secret-')
  })

  test('secrets-run: a value, a REPLACE placeholder, a failure, a missing binary', async () => {
    const fake = join(dir.path, 'fake-secrets-run')
    writeFileSync(fake, FAKE_SECRETS_RUN, { mode: 0o755 })
    const read = secretsRunReader(fake)
    expect(await read('op://good')).toEqual({ value: 'sk-real' })
    expect(await read('op://placeholder')).toEqual({ reason: 'the ref holds a REPLACE placeholder' })
    expect(await read('op://other')).toEqual({ reason: `${fake} exited 3` })
    const absent = join(dir.path, 'absent')
    expect(await secretsRunReader(absent)('op://good')).toEqual({ reason: `${absent} is not on PATH` })
  })
})

describe('tee', () => {
  test('a gzip stream cut mid-way still yields the usage it held', () => {
    const text = `data: ${JSON.stringify({ type: 'message_start', message: { model: 'm', usage: { input_tokens: 5 } } })}\n\n`
    const padded = `${text}data: ${JSON.stringify({ type: 'ping', pad: crypto.randomUUID().repeat(200) })}\n\n`
    const whole = gzipSync(padded)
    const tee = new UsageTee({ contentType: 'text/event-stream', contentEncoding: 'gzip' })
    tee.push(whole.subarray(0, Math.floor(whole.length * 0.8)))
    const result = tee.finish()
    expect(result.tokens?.input).toBe(5)
    expect(result.model).toBe('m')
  })

  test('an undecodable copy is no usage, never an error', () => {
    const tee = new UsageTee({ contentType: 'application/json', contentEncoding: 'gzip' })
    tee.push(new TextEncoder().encode('not gzip'))
    expect(tee.finish()).toEqual({ usage: null, tokens: null, model: null, streamError: false })
  })

  test('an unknown encoding throws from decodeBody; identity returns the bytes', () => {
    const bytes = new Uint8Array([1])
    expect(decodeBody(bytes, 'identity')).toBe(bytes)
    expect(() => decodeBody(bytes, 'snappy')).toThrow('unsupported')
  })
})

describe('process', () => {
  const started: Bun.Subprocess[] = []

  afterEach(() => {
    for (const proc of started) proc.kill('SIGKILL')
    started.length = 0
  })

  const spawn = (env: Record<string, string>) => {
    const proc = spawnGateway(env)
    started.push(proc)
    return proc
  }

  test('IU_KEY_ID=athena-team refuses to start: exit 78, the reason named', async () => {
    const proc = spawn({ ...baseEnv(), IU_KEY_ID: 'athena-team' })
    expect(await proc.exited).toBe(78)
    expect(await new Response(proc.stderr).text()).toContain('personal')
  })

  test('a missing required env is exit 78', async () => {
    const { AGW_GATEWAY_ACCOUNTS_FILE: _dropped, ...env } = baseEnv()
    const proc = spawn(env)
    expect(await proc.exited).toBe(78)
    expect(await new Response(proc.stderr).text()).toContain('AGW_GATEWAY_ACCOUNTS_FILE')
  })

  test('/health with no USAGE_PG_URL says the flush is off; SIGTERM exits clean', async () => {
    const proc = spawn({ ...baseEnv(), AGW_GATEWAY_PORT: '0', AGW_VERSION: '1.2.3', AGW_GATEWAY_BUILD: 'b42' })
    const port = await listening(proc)
    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json()
    expect(health).toMatchObject({
      status: 'ok',
      version: '1.2.3',
      build: 'b42',
      pools: [],
      ledger: { unsynced: 0, quarantined: 0, oldestUnsyncedAt: null, flush: 'off' },
    })
    proc.kill('SIGTERM')
    expect(await proc.exited).toBe(0)
  })

  test('a pool whose key is a REPLACE placeholder is disabled, the gateway still starts', async () => {
    const bin = join(dir.path, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'secrets-run'), FAKE_SECRETS_RUN, { mode: 0o755 })
    writeJson(accountsFile, {
      accounts: {
        good: { platform: { creditUsd: 100, cycleDay: 21, headroomUsd: 2, enabled: true, apiKeyRef: 'op://good' } },
        me2: {
          platform: { creditUsd: 100, cycleDay: null, headroomUsd: 2, enabled: true, apiKeyRef: 'op://placeholder' },
        },
      },
    })
    const proc = spawn({ ...baseEnv(), AGW_GATEWAY_PORT: '0', PATH: `${bin}:${process.env.PATH}` })
    const port = await listening(proc)
    const health = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as { pools: unknown[] }
    expect(health.pools).toMatchObject([
      { id: 'good', keyResolved: true, eligible: true, reconcileError: 'admin-key-missing' },
      { id: 'me2', keyResolved: false, eligible: false },
    ])
    expect(JSON.stringify(health)).not.toContain('sk-real')
  })

  test('the single-file bundle boots from a directory with no source tree', async () => {
    const out = join(dir.path, 'release')
    const build = await Bun.build({ entrypoints: [MAIN], target: 'bun', outdir: out, naming: 'gateway.js' })
    expect(build.success).toBe(true)
    const inputs = await Bun.file(join(out, 'gateway.js')).text()
    expect(inputs).not.toContain('discoverRoutes')
    const proc = Bun.spawn(['bun', 'gateway.js'], {
      cwd: out,
      env: { PATH: process.env.PATH ?? '', ...baseEnv(), AGW_GATEWAY_PORT: '0', AGW_GATEWAY_BUILD: 'bundled' },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    started.push(proc)
    const port = await listening(proc)
    expect(await (await fetch(`http://127.0.0.1:${port}/health`)).json()).toMatchObject({
      status: 'ok',
      build: 'bundled',
    })
  })

  test('a kill between the ledger write and the flush keeps the row on disk', async () => {
    const iu = fakeUpstream(() => Response.json({ model: 'm', usage: { input_tokens: 3, output_tokens: 4 } }))
    const proc = spawn({ ...baseEnv(), AGW_GATEWAY_PORT: '0', IU_BASE_URL: `${iu.url}/anthropic` })
    const port = await listening(proc)
    const init = jsonBody({ model: 'm', messages: [] })
    const response = await fetch(`http://127.0.0.1:${port}/anthropic/v1/messages`, {
      ...init,
      headers: { ...init.headers, 'x-api-key': DOOR_TOKEN },
    })
    await response.text()
    const requestId = response.headers.get('x-agw-request-id')
    proc.kill('SIGKILL')
    await proc.exited
    iu.stop()

    const ledger = new Ledger(join(dir.path, 'state', 'ledger.sqlite'))
    const { records } = ledger.pending(10)
    expect(records.map(({ row }) => row.source_id)).toEqual([requestId ?? ''])
    expect(records[0]?.row).toMatchObject({ input_tokens: 3, output_tokens: 4 })
    ledger.close()
  })
})

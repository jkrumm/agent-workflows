// Black-box conformance for the generated `agw` (ADR-004, contract v1): spawn `bin/agw.ts`, assert
// stdout, the one stderr error line and the exit code. Against the in-test fake host always; against
// a live host too when AGW_CONFORMANCE_URL is set (read-only and pending cases only).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EXIT } from '../src/exit.ts'
import { type FakeHost, startFakeHost } from './fake-host.ts'

const BIN = join(import.meta.dir, '..', 'bin', 'agw.ts')

interface Result {
  code: number
  stdout: string
  stderr: string
  /** The parsed stderr error line, when there is one. */
  error?: { kind: string; code: string | null; message: string; hint: string; details: Record<string, unknown> }
  json: () => Record<string, unknown>
}

interface Sandbox {
  dir: string
  env: Record<string, string>
  cacheFile: string
  envFile: string
}

const sandboxes: string[] = []
function sandbox(extra: Record<string, string> = {}): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), 'agw-conformance-'))
  sandboxes.push(dir)
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: dir,
    XDG_CACHE_HOME: join(dir, 'cache'),
    XDG_CONFIG_HOME: join(dir, 'config'),
    ...extra,
  }
  return { dir, env, cacheFile: join(dir, 'cache', 'agw', 'openapi.json'), envFile: join(dir, 'config', 'agw', 'env') }
}

async function agw(
  box: Sandbox,
  args: string[],
  options: { stdin?: string; env?: Record<string, string> } = {},
): Promise<Result> {
  const proc = Bun.spawn(['bun', BIN, ...args], {
    env: { ...box.env, ...options.env },
    stdin: options.stdin === undefined ? 'ignore' : new Blob([options.stdin]),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  const lines = stderr.trim().split('\n').filter(Boolean)
  const last = lines.at(-1)
  let error: Result['error']
  if (last) {
    expect(lines).toHaveLength(1)
    error = (JSON.parse(last) as { error: Result['error'] }).error
    expect(Object.keys(error ?? {})).toEqual(['kind', 'code', 'message', 'hint', 'details'])
  }
  return { code, stdout, stderr, error, json: () => JSON.parse(stdout) as Record<string, unknown> }
}

/** The exact resume command from a pending hint, as argv. */
function resumeArgs(hint: string): string[] {
  const words = hint.split(' ')
  expect(words[0]).toBe('agw')
  return words.slice(1)
}

afterAll(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true })
})

describe('agw against the fake host', () => {
  let host: FakeHost
  const box = () => sandbox({ AGW_URL: host.url, AGW_API_SECRET: host.secret })

  beforeAll(async () => {
    host = await startFakeHost()
  })
  afterAll(async () => {
    await host.stop()
  })

  test('0 ok: a capability call fetches the spec once, then sends the contract sha', async () => {
    const b = box()
    const r = await agw(b, ['llm', 'title', 'Release notes for the new CLI'])
    expect(r.code).toBe(EXIT.ok)
    expect(r.json().title).toContain('new CLI')
    const cached = JSON.parse(readFileSync(b.cacheFile, 'utf8')) as { info: Record<string, string> }
    expect(cached.info['x-contract-sha']).toBe(host.sha())
    const call = host.requests.findLast((q) => q.path === '/llm/title')
    expect(call?.headers['x-agw-contract']).toBe(host.sha())
    expect(call?.headers.authorization).toBe(`Bearer ${host.secret}`)
  })

  test('--format plain prints plainField; machine output is JSON by default', async () => {
    const b = box()
    const plain = await agw(b, ['llm', 'title', 'Plain output please', '--format', 'plain'])
    expect(plain.code).toBe(0)
    expect(plain.stdout.trim()).toBe('Plain output please')
    const json = await agw(b, ['fixture', 'echo', 'hi'])
    expect(json.json()).toMatchObject({ status: 'done', output: { echo: 'hi' } })
    const wf = await agw(b, ['fixture', 'echo', 'hi', '--format=plain'])
    expect(wf.stdout).toBe('hi\n')
  })

  test('stdin fills the x-cli.stdin property when it is not given', async () => {
    const b = box()
    const r = await agw(b, ['fixture', 'echo', '--format', 'plain'], { stdin: 'from stdin' })
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('from stdin\n')
    const arg = await agw(b, ['fixture', 'echo', 'from argv', '--format', 'plain'], { stdin: 'ignored' })
    expect(arg.stdout).toBe('from argv\n')
  })

  test('flag types: integer, boolean, enum, and JSON through a $ref', async () => {
    const b = box()
    const r = await agw(b, [
      'fixture',
      'echo',
      'ab',
      '--times',
      '2',
      '--loud',
      '--mode',
      'fancy',
      '--tags',
      '{"a":"b"}',
    ])
    expect(r.code).toBe(0)
    expect(r.json().output).toEqual({ echo: 'ABAB', mode: 'fancy', tags: { a: 'b' } })
    const body = host.requests.findLast((q) => q.path === '/workflows/fixture/echo')?.body
    expect(body).toEqual({ message: 'ab', times: 2, loud: true, mode: 'fancy', tags: { a: 'b' } })
    for (const bad of [['--times', '1.5'], ['--mode', 'loud'], ['--tags', '{nope'], ['--loud=maybe']]) {
      const e = await agw(b, ['fixture', 'echo', 'x', ...bad])
      expect(e.code).toBe(EXIT.usage)
      expect(e.error?.kind).toBe('usage')
    }
  })

  test('1 general: a 500, and a failed run with its state on stdout', async () => {
    const b = box()
    const boom = await agw(b, ['fixture', 'boom'])
    expect(boom.code).toBe(EXIT.general)
    expect(boom.error).toMatchObject({ kind: 'general', code: 'INTERNAL_SERVER_ERROR' })
    const failed = await agw(b, ['fixture', 'fail'])
    expect(failed.code).toBe(EXIT.general)
    expect(failed.json()).toMatchObject({ status: 'failed', error: { message: 'the fixture always fails' } })
    expect(failed.error?.message).toContain('failed')
  })

  test('2 usage: unknown flag lists the valid ones; a 400 from the host', async () => {
    const b = box()
    const r = await agw(b, ['llm', 'title', 'x', '--bogus'])
    expect(r.code).toBe(EXIT.usage)
    expect(r.error?.message).toBe('unknown flag --bogus')
    expect(r.error?.hint).toContain('--max-words')
    expect(r.error?.hint).toContain('--format')
    const missing = await agw(b, ['llm', 'title'])
    expect(missing.code).toBe(EXIT.usage)
    expect(missing.error?.message).toContain('<text>')
    const invalid = await agw(b, ['llm', 'title', ''])
    expect(invalid.code).toBe(EXIT.usage)
    expect(invalid.error?.code).toBe('BAD_REQUEST')
  })

  test('2 usage: unknown command refreshes once, then lists what exists', async () => {
    const b = box()
    await agw(b, ['schema', '--refresh'])
    const before = host.requests.filter((q) => q.path === '/openapi.json').length
    const r = await agw(b, ['llm', 'nope'])
    expect(r.code).toBe(EXIT.usage)
    expect(r.error?.message).toBe("unknown command 'llm nope'")
    expect(r.error?.hint).toBe('agw llm classify|summarize|title')
    expect(host.requests.filter((q) => q.path === '/openapi.json').length).toBe(before + 1)
  })

  test('unknown command: a workflow added since the cache was written runs without a manual refresh', async () => {
    const b = box()
    await agw(b, ['schema', '--refresh'])
    host.addWorkflow({
      id: 'fixture.fresh',
      summary: 'New since the cache',
      input: { type: 'object', properties: {} },
      outcome: () => ({ output: { fresh: true } }),
    })
    try {
      const r = await agw(b, ['fixture', 'fresh'])
      expect(r.code).toBe(0)
      expect(r.json()).toMatchObject({ status: 'done', output: { fresh: true } })
    } finally {
      host.removeWorkflow('fixture.fresh')
    }
  })

  test('--help per command comes from the schema', async () => {
    const r = await agw(box(), ['fixture', 'echo', '--help'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('usage: agw fixture echo [message]')
    expect(r.stdout).toContain('--times')
    expect(r.stdout).toContain('read from stdin when omitted')
  })

  test('3 auth: no secret names the env file; a wrong secret is a 401', async () => {
    const none = sandbox({ AGW_URL: host.url })
    const r = await agw(none, ['llm', 'title', 'x'])
    expect(r.code).toBe(EXIT.auth)
    expect(r.error?.hint).toContain(none.envFile)
    const wrong = sandbox({ AGW_URL: host.url, AGW_API_SECRET: 'wrong-secret-wrong-secret-wrong-secret' })
    const w = await agw(wrong, ['llm', 'title', 'x'])
    expect(w.code).toBe(EXIT.auth)
    expect(w.error?.code).toBe('UNAUTHORIZED')
  })

  test('env file: used when the environment has no secret, refused unless mode 0600', async () => {
    const b = sandbox()
    mkdirSync(join(b.dir, 'config', 'agw'), { recursive: true })
    writeFileSync(b.envFile, `# written by make deploy\nAGW_URL=${host.url}\nAGW_API_SECRET="${host.secret}"\n`)
    chmodSync(b.envFile, 0o644)
    const refused = await agw(b, ['llm', 'title', 'x'])
    expect(refused.code).toBe(EXIT.auth)
    expect(refused.error?.message).toContain('0644')
    expect(refused.error?.hint).toBe(`chmod 600 ${b.envFile}`)
    chmodSync(b.envFile, 0o600)
    const ok = await agw(b, ['llm', 'title', 'From the env file', '--format', 'plain'])
    expect(ok.code).toBe(0)
    expect(ok.stdout.trim()).toBe('From the env file')
  })

  test('4 not_found: an unknown run', async () => {
    const r = await agw(box(), ['run', 'status', 'no-such-run'])
    expect(r.code).toBe(EXIT.not_found)
    expect(r.error).toMatchObject({ kind: 'not_found', code: 'NOT_FOUND' })
  })

  test('5 conflict, and idempotency-key replay returns the same run', async () => {
    const b = box()
    const key = crypto.randomUUID()
    const first = await agw(b, ['fixture', 'echo', 'once', '--idempotency-key', key])
    const again = await agw(b, ['fixture', 'echo', 'once', '--idempotency-key', key])
    expect(first.code).toBe(0)
    expect(again.json().runId).toBe(first.json().runId)
    expect(host.requests.findLast((q) => q.path === '/workflows/fixture/echo')?.headers['idempotency-key']).toBe(key)
    const conflict = await agw(b, ['fixture', 'echo', 'twice', '--idempotency-key', key])
    expect(conflict.code).toBe(EXIT.conflict)
    expect(conflict.error?.code).toBe('CONFLICT')
  })

  test('6 confirmation_required: a mutating op in a non-TTY without --commit sends nothing', async () => {
    const b = box()
    await agw(b, ['schema', '--refresh'])
    const before = host.requests.length
    const r = await agw(b, ['fixture', 'deploy', '--target', 'mini'])
    expect(r.code).toBe(EXIT.confirmation_required)
    expect(r.error?.hint).toContain('--commit')
    expect(host.requests.length).toBe(before)
    const cancel = await agw(b, ['run', 'cancel', 'some-run'])
    expect(cancel.code).toBe(EXIT.confirmation_required)
    expect(host.requests.length).toBe(before)
    const ok = await agw(b, ['fixture', 'deploy', '--target', 'mini', '--commit'])
    expect(ok.code).toBe(0)
    expect(ok.json()).toMatchObject({ status: 'done', output: { deployed: 'mini' } })
  })

  test('7 network: the host is unreachable', async () => {
    const b = sandbox({ AGW_URL: 'http://127.0.0.1:1', AGW_API_SECRET: host.secret })
    const r = await agw(b, ['llm', 'title', 'x'])
    expect(r.code).toBe(EXIT.network)
    expect(r.error?.kind).toBe('network')
  })

  test('8 rate_limited: 429 carries Retry-After', async () => {
    const r = await agw(box(), ['fixture', 'limited'])
    expect(r.code).toBe(EXIT.rate_limited)
    expect(r.error?.details.retryAfterS).toBe(7)
  })

  test('9 contract_mismatch: a stale sha refreshes and retries once', async () => {
    const b = box()
    await agw(b, ['schema', '--refresh'])
    const stale = host.sha()
    host.bumpVersion()
    const r = await agw(b, ['fixture', 'echo', 'after a bump'])
    expect(r.code).toBe(0)
    expect(r.json()).toMatchObject({ status: 'done' })
    const calls = host.requests.filter((q) => q.path === '/workflows/fixture/echo').slice(-2)
    expect(calls.map((q) => q.headers['x-agw-contract'])).toEqual([stale, host.sha()])
  })

  test('9 contract_mismatch: a command the new contract removed exits 9', async () => {
    const b = box()
    host.addWorkflow({ id: 'fixture.doomed', summary: 'Removed soon', input: { type: 'object', properties: {} } })
    await agw(b, ['schema', '--refresh'])
    host.removeWorkflow('fixture.doomed')
    const r = await agw(b, ['fixture', 'doomed'])
    expect(r.code).toBe(EXIT.contract_mismatch)
    expect(r.error?.code).toBe('CONTRACT_MISMATCH')
    expect(r.error?.details.server).toBe(host.sha())
  })

  test('10 pending: a short budget exits with the exact resume command, which finishes the run', async () => {
    const b = box()
    const r = await agw(b, ['fixture', 'echo', 'slow', '--duration-s', '2.5'], { env: { AGW_WAIT_BUDGET_S: '1' } })
    expect(r.code).toBe(EXIT.pending)
    const state = r.json()
    expect(state.status).toBe('running')
    expect(r.error?.hint).toBe(`agw run wait ${String(state.runId)}`)
    const started = host.requests.findLast((q) => q.path === '/workflows/fixture/echo')
    expect(started?.headers.prefer).toBe('wait=1')
    const done = await agw(b, resumeArgs(r.error?.hint ?? ''))
    expect(done.code).toBe(0)
    expect(done.json()).toMatchObject({ runId: state.runId, status: 'done', output: { echo: 'slow' } })
  })

  test('the wait loop: Prefer is capped at 240 s and run wait loops until the run ends', async () => {
    const b = box()
    const r = await agw(b, ['fixture', 'echo', 'quick'], { env: { AGW_WAIT_BUDGET_S: '1000' } })
    expect(r.code).toBe(0)
    expect(host.requests.findLast((q) => q.path === '/workflows/fixture/echo')?.headers.prefer).toBe('wait=240')
    const purpose = await agw(b, ['run', 'status', String(r.json().runId)], { env: { AGW_PURPOSE: 'eval' } })
    expect(purpose.code).toBe(0)
    expect(host.requests.at(-1)?.headers['x-agw-purpose']).toBe('eval')
  })

  test('schema works offline with the host down', async () => {
    const b = box()
    expect((await agw(b, ['schema', '--refresh'])).code).toBe(0)
    const down = { AGW_URL: 'http://127.0.0.1:1' }
    const list = await agw(b, ['schema'], { env: down })
    expect(list.code).toBe(0)
    const commands = (list.json().commands as { command: string }[]).map((c) => c.command)
    expect(commands).toEqual(expect.arrayContaining(['llm title', 'decide', 'fixture echo', 'run wait', 'run cancel']))
    expect(list.json().contractSha).toBe(host.sha())
    const one = await agw(b, ['schema', 'fixture', 'echo'], { env: down })
    expect(one.code).toBe(0)
    const described = one.json() as {
      input: { properties: Record<string, Record<string, unknown>> }
      'x-cli': Record<string, unknown>
    }
    expect(described.input.properties.tags).toMatchObject({ type: 'object', 'x-flag': '--tags' })
    expect(described['x-cli']).toMatchObject({ kind: 'workflow', resume: { command: ['run', 'wait'] } })
    const unknown = await agw(b, ['schema', 'nope'], { env: down })
    expect(unknown.code).toBe(EXIT.usage)
  })

  test('schema --exit-codes needs neither a cache nor a host', async () => {
    const r = await agw(sandbox(), ['schema', '--exit-codes'])
    expect(r.code).toBe(0)
    const table = r.json().exitCodes as { code: number; kind: string }[]
    expect(table.map((row) => [row.kind, row.code])).toEqual(Object.entries(EXIT))
  })
})

const LIVE = process.env.AGW_CONFORMANCE_URL
const liveDescribe = LIVE ? describe : describe.skip

liveDescribe(
  `agw against the live host (${LIVE ? 'AGW_CONFORMANCE_URL' : 'skipped: AGW_CONFORMANCE_URL is unset'})`,
  () => {
    // Credentials resolve as for a real caller: AGW_API_SECRET from the environment, else the real env file.
    const liveBox = () => {
      const b = sandbox({ AGW_URL: LIVE ?? '' })
      b.env.HOME = process.env.HOME ?? b.dir
      b.env.XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME ?? join(b.env.HOME, '.config')
      if (process.env.AGW_API_SECRET) b.env.AGW_API_SECRET = process.env.AGW_API_SECRET
      return b
    }

    test('read-only: schema, unknown flag and command, not_found, auth, confirmation, offline', async () => {
      const b = liveBox()
      const list = await agw(b, ['schema', '--refresh'])
      expect(list.code).toBe(0)
      const commands = list.json().commands as { command: string; mutating: boolean }[]
      expect(commands.map((c) => c.command)).toEqual(expect.arrayContaining(['run status', 'run wait', 'run cancel']))
      expect((await agw(b, ['run', 'status', 'x', '--bogus'])).code).toBe(EXIT.usage)
      expect((await agw(b, ['no-such-command'])).code).toBe(EXIT.usage)
      expect((await agw(b, ['run', 'status', crypto.randomUUID()])).code).toBe(EXIT.not_found)
      expect((await agw(b, ['run', 'cancel', crypto.randomUUID()])).code).toBe(EXIT.confirmation_required)
      const wrong = await agw(b, ['run', 'status', crypto.randomUUID()], { env: { AGW_API_SECRET: 'x'.repeat(40) } })
      expect(wrong.code).toBe(EXIT.auth)
      expect((await agw(b, ['schema'], { env: { AGW_URL: 'http://127.0.0.1:1' } })).code).toBe(0)
    })

    test('read-only: a stale cached sha is refreshed and the call retried', async () => {
      const b = liveBox()
      await agw(b, ['schema', '--refresh'])
      const cached = JSON.parse(readFileSync(b.cacheFile, 'utf8')) as { info: Record<string, string> }
      cached.info['x-contract-sha'] = '0'.repeat(64)
      writeFileSync(b.cacheFile, JSON.stringify(cached))
      const r = await agw(b, ['run', 'status', crypto.randomUUID()])
      expect(r.code).toBe(EXIT.not_found)
    })

    // AGW_CONFORMANCE_PENDING: a JSON argv array for a workflow that takes longer than a few seconds.
    const pending = process.env.AGW_CONFORMANCE_PENDING
    ;(pending ? test : test.skip)(
      `pending: budget 0 exits 10 and the resume finishes (${pending ? 'AGW_CONFORMANCE_PENDING' : 'skipped: AGW_CONFORMANCE_PENDING is unset'})`,
      async () => {
        const b = liveBox()
        const r = await agw(b, JSON.parse(pending ?? '[]') as string[], { env: { AGW_WAIT_BUDGET_S: '0' } })
        expect(r.code).toBe(EXIT.pending)
        const done = await agw(b, resumeArgs(r.error?.hint ?? ''), { env: { AGW_WAIT_BUDGET_S: '230' } })
        expect([EXIT.ok, EXIT.general]).toContain(done.code as 0 | 1)
        expect(['done', 'failed', 'cancelled']).toContain(String(done.json().status))
      },
      300_000,
    )
  },
)

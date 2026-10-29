// Black-box conformance for the generated `agw` (ADR-004, contract v1): spawn `bin/agw.ts`, assert
// stdout, the one stderr error line and the exit code. Against the in-test fake host always; against
// a live host too when AGW_CONFORMANCE_URL is set (read-only and pending cases only).
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Socket } from 'bun'
import { EXIT } from '../src/exit.ts'
import { contractSha, servedSha } from '../src/spec.ts'
import { type FakeHost, hostSha, type RunStore, startFakeHost, type Workflow } from './fake-host.ts'

const BIN = join(import.meta.dir, '..', 'bin', 'agw.ts')

// Each case spawns several `bun` processes; under the full `make check` load 5 s is too tight.
setDefaultTimeout(20_000)

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
  return { dir, env, envFile: join(dir, 'config', 'agw', 'env') }
}

/** The documented layout: one cache per host URL. */
const cacheFile = (box: Sandbox, url: string) =>
  join(box.dir, 'cache', 'agw', createHash('sha256').update(url).digest('hex').slice(0, 12), 'openapi.json')

async function agw(
  box: Sandbox,
  args: string[],
  options: { stdin?: string; openStdin?: boolean; env?: Record<string, string> } = {},
): Promise<Result> {
  const proc = Bun.spawn(['bun', BIN, ...args], {
    env: { ...box.env, ...options.env },
    // `openStdin`: an inherited pipe nobody writes to or closes, as under some agent harnesses.
    stdin: options.openStdin ? 'pipe' : options.stdin === undefined ? 'ignore' : new Blob([options.stdin]),
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
    const cached = JSON.parse(readFileSync(cacheFile(b, host.url), 'utf8')) as { info: Record<string, string> }
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

  test('--format plain on a workflow reads plainField from .output, and only once the run is done', async () => {
    const b = box()
    // done: the field of the run's output, not of the envelope
    const done = await agw(b, ['fixture', 'echo', 'hi', '--format', 'plain'])
    expect(done.code).toBe(0)
    expect(done.stdout).toBe('hi\n')
    // pending (exit 10): no output yet, the whole state as before; the resume command then prints the field
    const pending = await agw(b, ['fixture', 'echo', 'slow', '--duration-s', '2.5', '--format', 'plain'], {
      env: { AGW_WAIT_BUDGET_S: '1' },
    })
    expect(pending.code).toBe(EXIT.pending)
    expect(JSON.parse(pending.stdout)).toMatchObject({ status: 'running' })
    const resumed = await agw(b, [...resumeArgs(pending.error?.hint ?? ''), '--format', 'plain'])
    expect(resumed.code).toBe(0)
    expect(JSON.parse(resumed.stdout)).toMatchObject({ status: 'done', output: { echo: 'slow' } })
    // failed: the state, exit 1
    const failed = await agw(b, ['fixture', 'fail', '--format', 'plain'])
    expect(failed.code).toBe(EXIT.general)
    expect(JSON.parse(failed.stdout)).toMatchObject({ status: 'failed' })
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
    const unions = await agw(b, ['fixture', 'echo', 'x', '--level', 'high', '--size', '12', '--no-loud'])
    expect(unions.code).toBe(0)
    const sent = host.requests.findLast((q) => q.path === '/workflows/fixture/echo')?.body
    expect(sent).toEqual({ message: 'x', level: 'high', size: '12', loud: false })
    for (const bad of [
      ['--times', '1.5'],
      ['--mode', 'loud'],
      ['--tags', '{nope'],
      ['--loud=maybe'],
      ['--level', 'mid'],
    ]) {
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
    // llm.summarize stays skipped (its `format` input collides with --format) until capabilities rename it.
    expect(r.error?.hint).toMatch(/^agw llm classify\|(summarize\|)?title$/)
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

  test('--help is never stale: a command added since the cache is found, a changed shape is shown, one fetch', async () => {
    const b = box()
    await agw(b, ['schema', '--refresh'])
    host.addWorkflow({
      id: 'fixture.shape',
      summary: 'Gets a flag later',
      input: { type: 'object', properties: { first: { type: 'string' } } },
      outcome: () => ({ output: {} }),
    })
    try {
      // a command added since the cache: top help and its own help both see it
      const top = await agw(b, ['--help'])
      expect(top.code).toBe(0)
      expect(top.stdout).toContain('agw fixture shape')
      host.removeWorkflow('fixture.shape')
      await agw(b, ['schema', '--refresh'])
      host.addWorkflow({
        id: 'fixture.shape',
        summary: 'Gets a flag later',
        input: { type: 'object', properties: { first: { type: 'string' } } },
        outcome: () => ({ output: {} }),
      })
      await agw(b, ['schema', '--refresh'])
      // the same command, a flag added on the host since the cache was written
      host.removeWorkflow('fixture.shape')
      host.addWorkflow({
        id: 'fixture.shape',
        summary: 'Gets a flag later',
        input: { type: 'object', properties: { first: { type: 'string' }, second: { type: 'string' } } },
        outcome: () => ({ output: {} }),
      })
      const before = host.requests.filter((q) => q.path === '/openapi.json').length
      const help = await agw(b, ['fixture', 'shape', '--help'])
      expect(help.code).toBe(0)
      expect(help.stdout).toContain('--second')
      expect(host.requests.filter((q) => q.path === '/openapi.json').length).toBe(before + 1)
    } finally {
      host.removeWorkflow('fixture.shape')
    }
  })

  test('--help answers from the cache when the host cannot be asked; an unknown command then says why', async () => {
    const own = await startFakeHost()
    const b = sandbox({ AGW_URL: own.url, AGW_API_SECRET: own.secret })
    expect((await agw(b, ['schema', '--refresh'])).code).toBe(0)
    await own.stop()
    const top = await agw(b, ['--help'])
    expect(top.code).toBe(0)
    expect(top.stdout).toContain('agw fixture echo')
    const one = await agw(b, ['fixture', 'echo', '--help'])
    expect(one.code).toBe(0)
    expect(one.stdout).toContain('usage: agw fixture echo')
    // no secret: help still works from the cache
    const keyless = sandbox({ AGW_URL: own.url })
    mkdirSync(join(keyless.dir, 'cache', 'agw'), { recursive: true })
    cpSync(join(b.dir, 'cache', 'agw'), join(keyless.dir, 'cache', 'agw'), { recursive: true })
    expect((await agw(keyless, ['fixture', 'echo', '--help'])).code).toBe(0)
    // a command the cache lacks, host unreachable: the refresh failure is in the message, not only in the details
    const unknown = await agw(b, ['fixture', 'nonesuch', '--help'])
    expect(unknown.code).toBe(EXIT.usage)
    expect(unknown.error?.message).toContain("unknown command 'fixture nonesuch'")
    expect(unknown.error?.message).toContain('the cached contract could not be refreshed')
  })

  test('--help per command comes from the schema', async () => {
    const r = await agw(box(), ['fixture', 'echo', '--help'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('usage: agw fixture echo [message]')
    expect(r.stdout).toContain('--times')
    expect(r.stdout).toContain('read from stdin when omitted')
    expect(r.stdout).toContain('[--loud|--no-loud]')
    expect(r.stdout).toContain('[--level <low|high>]')
    expect(r.stdout).not.toContain('<boolean>')
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

  test('env file: an unreadable one is exit 3 naming the path, not "no file"', async () => {
    const b = sandbox({ AGW_URL: host.url })
    mkdirSync(b.envFile, { recursive: true })
    chmodSync(b.envFile, 0o600)
    const r = await agw(b, ['llm', 'title', 'x'])
    expect(r.code).toBe(EXIT.auth)
    expect(r.error?.message).toStartWith(`${b.envFile} cannot be read:`)
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
    const own = await startFakeHost()
    const b = sandbox({ AGW_URL: own.url, AGW_API_SECRET: own.secret })
    expect((await agw(b, ['schema', '--refresh'])).code).toBe(0)
    const sha = own.sha()
    await own.stop()
    const down = {}
    expect((await agw(b, ['run', 'status', 'x'])).code).toBe(EXIT.network)
    const list = await agw(b, ['schema'], { env: down })
    expect(list.code).toBe(0)
    const commands = (list.json().commands as { command: string }[]).map((c) => c.command)
    expect(commands).toEqual(expect.arrayContaining(['llm title', 'decide', 'fixture echo', 'run wait', 'run cancel']))
    expect(list.json().contractSha).toBe(sha)
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

  test("schema prints a workflow's output type, $refs inlined; a run command keeps the open output", async () => {
    const b = box()
    const echo = (await agw(b, ['schema', 'fixture', 'echo'])).json() as {
      output: { properties: Record<string, Record<string, unknown>>; required: string[] }
    }
    expect(echo.output.required).toEqual(['runId', 'workflowId', 'status'])
    expect(echo.output.properties.output).toMatchObject({
      type: 'object',
      required: ['echo', 'mode'],
      properties: { echo: { type: 'string' }, tags: { type: 'object', additionalProperties: { type: 'string' } } },
    })
    const status = (await agw(b, ['schema', 'run', 'status'])).json() as {
      output: { properties: Record<string, unknown> }
    }
    expect(status.output.properties.output).toEqual({})
  })

  test('--commit takes only true or false inline; --commit=false keeps the gate shut', async () => {
    const b = box()
    await agw(b, ['schema', '--refresh'])
    const before = host.requests.length
    const off = await agw(b, ['fixture', 'deploy', '--target', 'mini', '--commit=false'])
    expect(off.code).toBe(EXIT.confirmation_required)
    const bad = await agw(b, ['fixture', 'deploy', '--target', 'mini', '--commit=yes'])
    expect(bad.code).toBe(EXIT.usage)
    expect(host.requests.length).toBe(before)
    const on = await agw(b, ['fixture', 'deploy', '--target', 'mini', '--commit=true'])
    expect(on.code).toBe(0)
  })

  test('a stale cache refreshes once on an unknown flag or a missing field, then parses again', async () => {
    const b = box()
    host.addWorkflow({ id: 'fixture.grow', summary: 'Gains a flag', input: { type: 'object', properties: {} } })
    try {
      await agw(b, ['schema', '--refresh'])
      host.addWorkflow({
        id: 'fixture.grow',
        summary: 'Gained a flag',
        input: { type: 'object', properties: { extra: { type: 'string' } }, required: ['extra'] },
        outcome: (input) => ({ output: { extra: input.extra } }),
      })
      const fetches = () => host.requests.filter((q) => q.path === '/openapi.json').length
      const before = fetches()
      const r = await agw(b, ['fixture', 'grow', '--extra', 'new'])
      expect(r.code).toBe(0)
      expect(r.json()).toMatchObject({ output: { extra: 'new' } })
      expect(fetches()).toBe(before + 1)
      const still = await agw(b, ['fixture', 'grow', '--extra', 'x', '--nope'])
      expect(still.code).toBe(EXIT.usage)
      expect(fetches()).toBe(before + 2)
    } finally {
      host.removeWorkflow('fixture.grow')
    }
  })

  test('an operation with an unknown x-cli.kind is skipped; a bad document keeps the old cache', async () => {
    const b = box()
    host.addWorkflow({
      id: 'fixture.odd',
      summary: 'Unknown kind',
      kind: 'mystery',
      input: { type: 'object', properties: {} },
    })
    try {
      expect((await agw(b, ['schema', '--refresh'])).code).toBe(0)
      const listed = (await agw(b, ['schema'])).json().commands as { command: string }[]
      expect(listed.map((c) => c.command)).not.toContain('fixture odd')
      const skipped = (await agw(b, ['schema'])).json().skipped as { operation: string; reason: string }[]
      expect(skipped).toContainEqual({
        operation: 'POST /workflows/fixture/odd',
        reason: 'unknown x-cli.kind "mystery"',
      })
      expect((await agw(b, ['fixture', 'odd'])).code).toBe(EXIT.usage)
      expect((await agw(b, ['fixture', 'echo', 'still works'])).code).toBe(0)
    } finally {
      host.removeWorkflow('fixture.odd')
    }
    await agw(b, ['schema', '--refresh'])
    const good = readFileSync(cacheFile(b, host.url), 'utf8')
    host.serveDocument({
      openapi: '3.1.1',
      paths: { '/x': { post: { 'x-cli': { command: ['x'], kind: 'mystery' } } } },
    })
    try {
      const r = await agw(b, ['schema', '--refresh'])
      expect(r.code).toBe(EXIT.general)
      expect(r.error?.message).toContain('the cached contract is kept')
      expect(readFileSync(cacheFile(b, host.url), 'utf8')).toBe(good)
    } finally {
      host.serveDocument(undefined)
    }
  })

  test('a 202 without a run id, or a workflow without x-cli.resume, exits 1 without a bogus hint', async () => {
    const b = box()
    const r = await agw(b, ['fixture', 'norunid'])
    expect(r.code).toBe(EXIT.general)
    expect(r.error?.message).toBe('host returned no run id')
    expect(r.stderr).not.toContain('undefined')
    expect(r.error?.hint).toBe('')
    const n = await agw(b, ['fixture', 'noresume'], { env: { AGW_WAIT_BUDGET_S: '0' } })
    expect(n.code).toBe(EXIT.general)
    expect(n.error?.message).toContain('no resume command')
  })

  test('a run id from the host gets the path check: .. exits 1 before any poll', async () => {
    const b = box()
    await agw(b, ['schema', '--refresh'])
    const r = await agw(b, ['fixture', 'dotrun'])
    expect(r.code).toBe(EXIT.general)
    expect(r.error?.message).toBe('host returned an unsafe runId: ..')
    expect(r.json()).toMatchObject({ runId: '..', status: 'running' })
    const last = host.requests.at(-1)
    expect(last?.path).toBe('/workflows/fixture/dotrun')
  })

  test('an optional stdin field is not read implicitly: an open pipe does not hang the call', async () => {
    const r = await agw(box(), ['fixture', 'note'], { openStdin: true })
    expect(r.code).toBe(0)
    expect(r.json()).toMatchObject({ status: 'done', output: { text: null } })
  })

  test('one cache per host URL', async () => {
    const other = await startFakeHost()
    try {
      for (let i = 0; i < 50; i++) other.bumpVersion()
      const b = sandbox({ AGW_API_SECRET: host.secret })
      expect((await agw(b, ['schema', '--refresh'], { env: { AGW_URL: host.url } })).code).toBe(0)
      expect((await agw(b, ['schema', '--refresh'], { env: { AGW_URL: other.url } })).code).toBe(0)
      expect(cacheFile(b, host.url)).not.toBe(cacheFile(b, other.url))
      const down = (await agw(b, ['schema'], { env: { AGW_URL: host.url } })).json()
      const otherDown = (await agw(b, ['schema'], { env: { AGW_URL: other.url } })).json()
      expect(down.contractSha).toBe(host.sha())
      expect(otherDown.contractSha).toBe(other.sha())
      expect(down.contractSha).not.toBe(otherDown.contractSha)
    } finally {
      await other.stop()
    }
  })

  test('a network failure on a workflow start hints the idempotency key to retry with', async () => {
    const b = box()
    await agw(b, ['schema', '--refresh'])
    const dead = 'http://127.0.0.1:1'
    mkdirSync(join(cacheFile(b, dead), '..'), { recursive: true })
    cpSync(cacheFile(b, host.url), cacheFile(b, dead))
    const r = await agw(b, ['fixture', 'echo', 'x'], { env: { AGW_URL: dead } })
    expect(r.code).toBe(EXIT.network)
    expect(r.error?.hint).toMatch(/^the run may have started; retry with --idempotency-key [0-9a-f-]{36}$/)
    const given = await agw(b, ['fixture', 'echo', 'x', '--idempotency-key', 'k-1'], { env: { AGW_URL: dead } })
    expect(given.error?.hint).toBe('the run may have started; retry with --idempotency-key k-1')
  })

  test('a request without a wait hits AGW_TIMEOUT_S as its own message', async () => {
    const b = box()
    const started = await agw(b, ['fixture', 'echo', 'x'])
    host.slowStatus(2500)
    try {
      const r = await agw(b, ['run', 'status', String(started.json().runId)], { env: { AGW_TIMEOUT_S: '1' } })
      expect(r.code).toBe(EXIT.network)
      expect(r.error?.message).toBe(`no answer from ${host.url} within 1s`)
    } finally {
      host.slowStatus(0)
    }
  })

  test('path parameters . and .. (in any encoding) are refused before any request', async () => {
    const b = box()
    await agw(b, ['schema', '--refresh'])
    const before = host.requests.length
    // `encodeURIComponent` leaves `.` alone, so nesting starts from an already encoded segment.
    const deep = (id: string, n: number) => Array.from({ length: n }).reduce<string>((v) => encodeURIComponent(v), id)
    const ids = [
      '.',
      '..',
      '%2e%2e',
      '%2E',
      '%252e%252e',
      '%2525252e',
      deep('%2e', 7),
      deep('%2e', 8),
      deep('a%20b', 8),
    ]
    for (const id of ids) {
      const r = await agw(b, ['run', 'status', id])
      expect(r.code).toBe(EXIT.usage)
    }
    expect(host.requests.length).toBe(before)
    const plain = await agw(b, ['run', 'status', 'a%20b'])
    expect(plain.code).toBe(EXIT.not_found)
  })

  test('an input property named like a reserved flag skips the operation; schema lists why', async () => {
    const b = box()
    host.addWorkflow({
      id: 'fixture.reserved',
      summary: 'Collides with --format',
      input: { type: 'object', properties: { format: { type: 'string' } } },
    })
    try {
      await agw(b, ['schema', '--refresh'])
      const list = (await agw(b, ['schema'])).json() as {
        commands: { command: string }[]
        skipped: { operation: string; command?: string; reason: string }[]
      }
      expect(list.commands.map((c) => c.command)).not.toContain('fixture reserved')
      expect(list.skipped).toContainEqual({
        operation: 'POST /workflows/fixture/reserved',
        command: 'fixture reserved',
        reason: 'input property "format" collides with the reserved flag --format',
      })
      expect((await agw(b, ['fixture', 'reserved'])).code).toBe(EXIT.usage)
      expect((await agw(b, ['fixture', 'echo', 'unaffected'])).code).toBe(0)
    } finally {
      host.removeWorkflow('fixture.reserved')
    }
  })

  test('the bearer never leaves in cleartext: plain http only to loopback', async () => {
    for (const url of ['http://example.invalid:7791', 'http://10.0.0.1:7791', 'ftp://127.0.0.1']) {
      const r = await agw(sandbox({ AGW_URL: url, AGW_API_SECRET: host.secret }), ['run', 'status', 'x'])
      expect(r.code).toBe(EXIT.auth)
      expect(r.error?.message).toContain('refused to send the secret')
    }
    for (const url of ['http://[::1]:1', 'http://localhost:1', 'https://127.0.0.1:1']) {
      const r = await agw(sandbox({ AGW_URL: url, AGW_API_SECRET: host.secret }), ['run', 'status', 'x'])
      expect(r.code).toBe(EXIT.network)
    }
  })

  test('$ref parameters and request bodies are dereferenced, not dropped', async () => {
    const b = box()
    const status = (await agw(b, ['schema', 'run', 'status'])).json() as {
      input: { properties: Record<string, Record<string, unknown>>; required: string[] }
    }
    expect(status.input.properties.runId).toMatchObject({ type: 'string', 'x-positional': 0 })
    expect(status.input.required).toEqual(['runId'])
    const deploy = (await agw(b, ['schema', 'fixture', 'deploy'])).json() as {
      input: { properties: Record<string, unknown> }
    }
    expect(Object.keys(deploy.input.properties)).toEqual(['target'])
  })

  test('contract sha: the CLI and the host agree on a known-answer vector', () => {
    const doc = {
      openapi: '3.1.1',
      info: { title: 'agw vector', version: '1.0.0' },
      paths: {
        '/runs/{runId}': {
          get: {
            operationId: 'runStatus',
            'x-cli': {
              command: ['run', 'status'],
              positional: ['runId'],
              mutating: false,
              defaultFormat: 'json' as const,
              kind: 'run' as const,
            },
          },
        },
      },
      components: { schemas: { Z: { type: 'string' }, A: { enum: [3, 1, 2] } } },
    }
    // Computed independently: python3 json.dumps(doc, sort_keys=True, separators=(',', ':')) | sha256.
    const expected = '52f36fc70a59fc53c8c217785f3fc197143482d84b6b7a87f0cde81bce62d190'
    expect(contractSha(doc)).toBe(expected)
    expect(servedSha(doc)).toBe(expected)
    expect(hostSha(doc)).toBe(expected)
    expect(contractSha({ ...doc, info: { ...doc.info, 'x-contract-sha': 'ignored' } })).toBe(expected)
  })

  test('schema --help prints usage and exits 0', async () => {
    const r = await agw(sandbox(), ['schema', '--help'])
    expect(r.code).toBe(0)
    expect(r.stdout).toStartWith('usage: agw schema')
    expect(r.stdout).toContain('--exit-codes')
    expect(r.stderr).toBe('')
  })

  test('schema --exit-codes needs neither a cache nor a host', async () => {
    const r = await agw(sandbox(), ['schema', '--exit-codes'])
    expect(r.code).toBe(0)
    const table = r.json().exitCodes as { code: number; kind: string }[]
    expect(table.map((row) => [row.kind, row.code])).toEqual(Object.entries(EXIT))
  })
})

/** A second platform process: its own workflows on its own port, the run ops, the host's journal. */
const audioWorkflows = (runs: RunStore): Workflow[] => [
  {
    id: 'audio.speak',
    summary: 'Speak the text after durationS seconds',
    input: {
      type: 'object',
      properties: { text: { type: 'string', minLength: 1 }, durationS: { type: 'number', default: 0 } },
      required: ['text'],
    },
    positional: ['text'],
    outcome: (input) => ({ durationS: Number(input.durationS ?? 0), output: { spoken: input.text } }),
  },
  {
    // Answers 202 at once, so the CLI's own wait loop runs: it must poll the process that started the run.
    id: 'audio.queue',
    summary: 'Queue a run and answer at once',
    input: { type: 'object', properties: {} },
    outcome: () => {
      const runId = crypto.randomUUID()
      runs.set(runId, {
        runId,
        workflowId: 'audio.queue',
        endsAt: Date.now() + 1500,
        output: { queued: true },
        cancelled: false,
        input: '{}',
      })
      return { respond: Response.json({ runId, workflowId: 'audio.queue', status: 'running' }, { status: 202 }) }
    },
  },
]

describe('agw across platform processes (AGW_PROCESSES)', () => {
  let host: FakeHost
  let audio: FakeHost
  const runs: RunStore = new Map()
  const box = (processes = `audio=${audio.url}`) =>
    sandbox({ AGW_URL: host.url, AGW_API_SECRET: host.secret, AGW_PROCESSES: processes })
  const fetches = (h: FakeHost) => h.requests.filter((q) => q.path === '/openapi.json').length

  beforeAll(async () => {
    host = await startFakeHost({ runs })
    audio = await startFakeHost({ runs, capabilities: false, workflows: audioWorkflows(runs) })
  })
  afterAll(async () => {
    await host.stop()
    await audio.stop()
  })

  test('help merges every process; each command goes to the process that declared it; one cache each', async () => {
    const b = box()
    const [hostFetches, audioFetches] = [fetches(host), fetches(audio)]
    const help = await agw(b, ['--help'])
    expect(help.code).toBe(0)
    expect(help.stdout).toContain('agw llm title')
    expect(help.stdout).toContain('agw audio speak')
    expect(help.stdout).not.toContain('unavailable')
    // Help fetches each contract once, no more.
    expect(fetches(host) - hostFetches).toBe(1)
    expect(fetches(audio) - audioFetches).toBe(1)
    expect(JSON.parse(readFileSync(cacheFile(b, audio.url), 'utf8')).info['x-contract-sha']).toBe(audio.sha())
    expect(JSON.parse(readFileSync(cacheFile(b, host.url), 'utf8')).info['x-contract-sha']).toBe(host.sha())

    const before = host.requests.length
    const spoken = await agw(b, ['audio', 'speak', 'hello'])
    expect(spoken.code).toBe(0)
    expect(spoken.json()).toMatchObject({ status: 'done', output: { spoken: 'hello' } })
    const call = audio.requests.findLast((q) => q.path === '/workflows/audio/speak')
    expect(call?.headers['x-agw-contract']).toBe(audio.sha())
    expect(host.requests.length).toBe(before)

    const title = await agw(b, ['llm', 'title', 'Routing across processes'])
    expect(title.code).toBe(0)
    expect(host.requests.findLast((q) => q.path === '/llm/title')?.headers['x-agw-contract']).toBe(host.sha())
    // No refetch on a call: the caches answered.
    expect(fetches(host) - hostFetches).toBe(1)
    expect(fetches(audio) - audioFetches).toBe(1)
  })

  test('the run commands are shared: one entry each in help, never a conflict', async () => {
    const help = await agw(box(), ['--help'])
    expect(help.stdout.match(/agw run wait/g)).toHaveLength(1)
    expect(help.stdout).not.toContain('conflict')
  })

  test('a pending answer from the second process: the wait loop polls it, the printed resume command finishes', async () => {
    const b = box()
    const queued = await agw(b, ['audio', 'queue'], { env: { AGW_WAIT_BUDGET_S: '20' } })
    expect(queued.code).toBe(0)
    const runId = String(queued.json().runId)
    expect(audio.requests.some((q) => q.path === `/runs/${runId}/wait`)).toBe(true)
    expect(host.requests.some((q) => q.path.startsWith(`/runs/${runId}`))).toBe(false)

    const r = await agw(b, ['audio', 'speak', 'slow', '--duration-s', '2.5'], { env: { AGW_WAIT_BUDGET_S: '1' } })
    expect(r.code).toBe(EXIT.pending)
    const state = r.json()
    expect(r.error?.hint).toBe(`agw run wait ${String(state.runId)}`)
    const done = await agw(b, resumeArgs(r.error?.hint ?? ''))
    expect(done.code).toBe(0)
    expect(done.json()).toMatchObject({ runId: state.runId, status: 'done', output: { spoken: 'slow' } })
    const status = await agw(b, ['run', 'status', String(state.runId)])
    expect(status.json()).toMatchObject({ status: 'done', workflowId: 'audio.speak' })
  })

  test('a run follow-up reaches the second process when the host is down', async () => {
    const b = box()
    const started = await agw(b, ['audio', 'speak', 'later', '--duration-s', '30'], { env: { AGW_WAIT_BUDGET_S: '0' } })
    expect(started.code).toBe(EXIT.pending)
    const runId = String(started.json().runId)
    const down = sandbox({
      AGW_URL: 'http://127.0.0.1:1',
      AGW_API_SECRET: host.secret,
      AGW_PROCESSES: `audio=${audio.url}`,
    })
    mkdirSync(join(cacheFile(down, 'http://127.0.0.1:1'), '..'), { recursive: true })
    cpSync(cacheFile(b, host.url), cacheFile(down, 'http://127.0.0.1:1'))
    mkdirSync(join(cacheFile(down, audio.url), '..'), { recursive: true })
    cpSync(cacheFile(b, audio.url), cacheFile(down, audio.url))
    const status = await agw(down, ['run', 'status', runId])
    expect(status.code).toBe(0)
    expect(status.json()).toMatchObject({ runId, status: 'running' })
    const cancel = await agw(down, ['run', 'cancel', runId, '--commit'])
    expect(cancel.code).toBe(0)
    expect(audio.requests.findLast((q) => q.path === `/runs/${runId}/cancel`)).toBeDefined()
    expect(cancel.json().status).toBe('cancelled')
  })

  test('a command two processes declare fails loudly, naming both', async () => {
    const clash = await startFakeHost({ runs, capabilities: false })
    try {
      const b = box(`clash=${clash.url}`)
      // A conflict is seen once both contracts are known: a call never fetches another process's contract.
      expect((await agw(b, ['schema'])).code).toBe(0)
      const r = await agw(b, ['fixture', 'echo', 'hi'])
      expect(r.code).toBe(EXIT.contract_mismatch)
      expect(r.error?.message).toBe("'fixture echo' is declared by more than one process: host, clash")
      expect(clash.requests.some((q) => q.path.startsWith('/workflows'))).toBe(false)
      const help = await agw(b, ['--help'])
      expect(help.stdout).toContain('[conflict: host, clash]')
      const schema = (await agw(b, ['schema'])).json()
      expect(schema.conflicts).toContainEqual({ command: 'fixture echo', processes: ['host', 'clash'] })
      expect(schema.conflicts).not.toContainEqual(expect.objectContaining({ command: 'run wait' }))
      // A command only the host declares still runs.
      expect((await agw(b, ['llm', 'title', 'Still fine'])).code).toBe(0)
    } finally {
      await clash.stop()
    }
  })

  test('a second process that is down: host commands work, its cached commands show unavailable and exit 7', async () => {
    const gone = await startFakeHost({ runs, capabilities: false, workflows: audioWorkflows(runs) })
    const b = box(`gone=${gone.url}`)
    expect((await agw(b, ['schema', '--refresh'])).code).toBe(0)
    await gone.stop()

    expect((await agw(b, ['llm', 'title', 'Host is up'])).code).toBe(0)
    const help = await agw(b, ['--help'])
    expect(help.code).toBe(0)
    expect(help.stdout).toContain('agw audio speak')
    expect(help.stdout).toMatch(/agw audio speak .*\[unavailable: gone\]/)
    expect(help.stdout).toContain(`(process gone unavailable: process gone unreachable at ${gone.url}`)
    expect((await agw(b, ['audio', 'speak', '--help'])).stdout).toContain('(unavailable: process gone unreachable')
    const r = await agw(b, ['audio', 'speak', 'hi'])
    expect(r.code).toBe(EXIT.network)
    expect(r.error?.message).toStartWith(`process gone unreachable at ${gone.url}`)

    // Offline: both caches answer, every entry naming its process.
    const schema = (await agw(b, ['schema'])).json()
    const commands = schema.commands as { process: string; command: string }[]
    expect(commands).toContainEqual(expect.objectContaining({ process: 'gone', command: 'audio speak' }))
    expect(commands).toContainEqual(expect.objectContaining({ process: 'host', command: 'llm title' }))
    expect(schema.contractSha).toBe(host.sha())
    const one = (await agw(b, ['schema', 'audio', 'speak'])).json()
    expect(one).toMatchObject({ process: 'gone', command: 'audio speak' })

    // Never cached and down: the host alone serves, without an error.
    const fresh = box(`gone=${gone.url}`)
    expect((await agw(fresh, ['llm', 'title', 'No second cache'])).code).toBe(0)
  })

  test('a 412 from the second process refreshes its contract only and retries', async () => {
    const b = box()
    expect((await agw(b, ['schema', '--refresh'])).code).toBe(0)
    audio.bumpVersion()
    const hostFetches = fetches(host)
    const r = await agw(b, ['audio', 'speak', 'again'])
    expect(r.code).toBe(0)
    expect(fetches(host)).toBe(hostFetches)
    expect(JSON.parse(readFileSync(cacheFile(b, audio.url), 'utf8')).info['x-contract-sha']).toBe(audio.sha())
  })

  /** A cached copy of the host's contract under another URL: the host as seen from a process that is not there. */
  const hostAt = (b: Sandbox, url: string) => {
    mkdirSync(join(cacheFile(b, url), '..'), { recursive: true })
    cpSync(cacheFile(b, host.url), cacheFile(b, url))
  }

  test('a 412 on a shared run command refreshes the process that answered it, not a down one', async () => {
    const gone = await startFakeHost({ runs, capabilities: false, workflows: audioWorkflows(runs) })
    const b = box(`gone=${gone.url}`)
    expect((await agw(b, ['schema', '--refresh'])).code).toBe(0)
    await gone.stop()
    const started = await agw(b, ['fixture', 'echo', 'x'])
    host.bumpVersion()
    const r = await agw(b, ['run', 'status', String(started.json().runId)])
    expect(r.code).toBe(0)
    expect(r.json().status).toBe('done')
  })

  test('schema --refresh with the host down still refreshes the other processes, then reports the host', async () => {
    const b = box()
    expect((await agw(b, ['schema', '--refresh'])).code).toBe(0)
    audio.bumpVersion()
    const dead = 'http://127.0.0.1:1'
    hostAt(b, dead)
    const r = await agw(b, ['schema', '--refresh'], { env: { AGW_URL: dead } })
    expect(r.code).toBe(EXIT.network)
    expect(r.error?.message).toStartWith(`host unreachable at ${dead}`)
    expect(JSON.parse(readFileSync(cacheFile(b, audio.url), 'utf8')).info['x-contract-sha']).toBe(audio.sha())
  })

  test('a connection that drops after the request was sent is never resent to the next process', async () => {
    const b = box()
    const started = await agw(b, ['audio', 'speak', 'once'])
    const runId = String(started.json().runId)
    let accepted = 0
    const dropper = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: {
        open: () => {
          accepted++
        },
        data: (socket: Socket) => {
          socket.end()
        },
      },
    })
    try {
      const url = `http://127.0.0.1:${dropper.port}`
      hostAt(b, url)
      const before = audio.requests.length
      const r = await agw(b, ['run', 'status', runId], { env: { AGW_URL: url } })
      expect(r.code).toBe(EXIT.network)
      expect(accepted).toBeGreaterThan(0)
      expect(audio.requests.slice(before).some((q) => q.path.startsWith('/runs/'))).toBe(false)
    } finally {
      dropper.stop(true)
    }
  })

  test('a host command never waits on another process: an uncached hung process is not contacted', async () => {
    let accepted = 0
    const hung = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: {
        open: () => {
          accepted++
        },
        data: () => {},
      },
    })
    try {
      const r = await agw(box(`hung=http://127.0.0.1:${hung.port}`), ['llm', 'title', 'Not waiting'])
      expect(r.code).toBe(0)
      expect(accepted).toBe(0)
    } finally {
      hung.stop(true)
    }
  })

  test('--help on a conflicting command shows the help and names the conflict', async () => {
    const clash = await startFakeHost({ runs, capabilities: false })
    try {
      const r = await agw(box(`clash=${clash.url}`), ['fixture', 'echo', '--help'])
      expect(r.code).toBe(0)
      expect(r.stdout).toContain('agw fixture echo')
      expect(r.stdout).toContain("'fixture echo' is declared by more than one process: host, clash")
    } finally {
      await clash.stop()
    }
  })

  test('run operations that drifted between processes are a conflict, not silently merged', async () => {
    const drifted = await startFakeHost({
      runs,
      capabilities: false,
      workflows: [],
      runIdSchema: { type: 'string', format: 'uuid' },
    })
    try {
      const b = box(`drifted=${drifted.url}`)
      expect((await agw(b, ['schema'])).code).toBe(0)
      const r = await agw(b, ['run', 'status', crypto.randomUUID()])
      expect(r.code).toBe(EXIT.contract_mismatch)
      expect(r.error?.message).toBe("'run status' is declared by more than one process: host, drifted")
    } finally {
      await drifted.stop()
    }
  })

  test("a typo in a host command does not blame an unrelated process's failure", async () => {
    const gone = await startFakeHost({ runs, capabilities: false, workflows: audioWorkflows(runs) })
    const b = box(`gone=${gone.url}`)
    expect((await agw(b, ['schema', '--refresh'])).code).toBe(0)
    await gone.stop()
    const typo = await agw(b, ['llm', 'titel'])
    expect(typo.code).toBe(EXIT.usage)
    expect(typo.error?.message).not.toContain('gone')
    const own = await agw(b, ['audio', 'speek'])
    expect(own.error?.message).toContain('process gone unreachable')
  })

  test('AGW_PROCESSES: a malformed list is a usage error naming the entry', async () => {
    for (const bad of [
      'audio',
      'host=http://127.0.0.1:9',
      'Audio=http://127.0.0.1:9',
      `a=${audio.url},b=${audio.url}`,
    ]) {
      const r = await agw(box(bad), ['llm', 'title', 'x'])
      expect(r.code).toBe(EXIT.usage)
      expect(r.error?.message).toStartWith('AGW_PROCESSES: ')
    }
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
      // Offline: the cache alone answers, with nothing listening at the URL it is keyed by.
      const dead = 'http://127.0.0.1:1'
      mkdirSync(join(cacheFile(b, dead), '..'), { recursive: true })
      cpSync(cacheFile(b, LIVE ?? ''), cacheFile(b, dead))
      expect((await agw(b, ['schema'], { env: { AGW_URL: dead } })).code).toBe(0)
    })

    test('read-only: a stale cached sha is refreshed and the call retried', async () => {
      const b = liveBox()
      await agw(b, ['schema', '--refresh'])
      const cached = JSON.parse(readFileSync(cacheFile(b, LIVE ?? ''), 'utf8')) as { info: Record<string, string> }
      cached.info['x-contract-sha'] = '0'.repeat(64)
      writeFileSync(cacheFile(b, LIVE ?? ''), JSON.stringify(cached))
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

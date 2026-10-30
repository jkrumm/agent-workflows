import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveRoute } from '@agent-workflows/routes'
import { boot, lazyOpenCodeHost } from '../src/boot.ts'
import { loadConfig } from '../src/config.ts'
import { Pool } from 'pg'
import { freshSchema, PG_URL, rejection, SECRET, until } from './support.ts'

const MAIN = new URL('../src/main.ts', import.meta.url).pathname

/** The door-tokens file every spawned host reads (`AGW_DOOR_CALLERS_FILE`): the process refuses to start without a good one. */
const DOOR_TOKEN = 'studio-token-0123456789abcdef-0123456789'
const tokensDir = mkdtempSync(join(tmpdir(), 'agw-main-tokens-'))
const TOKENS_FILE = join(tokensDir, 'door-tokens')
writeFileSync(TOKENS_FILE, `studio=${DOOR_TOKEN}\n`, { mode: 0o600 })
afterAll(() => rmSync(tokensDir, { recursive: true, force: true }))

/** A minimal environment: nothing of the developer's shell (secrets, OTEL, Argo) leaks into the process. */
function envFor(extra: Record<string, string>): Record<string, string> {
  return { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...extra }
}

const valid = (schema: string, extra: Record<string, string> = {}) => ({
  AGW_API_SECRET: SECRET,
  AGW_MACHINE: 'test-machine',
  AGW_PG_URL: PG_URL,
  AGW_PG_SCHEMA: schema,
  AGW_PORT: '0',
  IU_API_KEY: 'test-key',
  ...extra,
})

describe('loadConfig', () => {
  const base = { AGW_API_SECRET: SECRET, AGW_MACHINE: 'm', AGW_PG_URL: 'postgres://x' }
  test('defaults', () => {
    expect(loadConfig(base)).toMatchObject({ port: 7791, schema: 'agw', machine: 'm', version: 'dev' })
  })
  test('the door tokens file is AGW_DOOR_CALLERS_FILE, else data/door-tokens under HOME (the audio process reads the same one)', () => {
    expect(loadConfig({ ...base, HOME: '/home/u' }).doorTokensFile).toBe('/home/u/.agent-workflows/data/door-tokens')
    expect(loadConfig({ ...base, HOME: '/home/u', AGW_DOOR_CALLERS_FILE: '/x/tokens' }).doorTokensFile).toBe(
      '/x/tokens',
    )
  })
  test('IU_KEY_ID: unset or empty is personal, a known id is kept, an unknown one refuses without echoing it', () => {
    expect(loadConfig(base).iuKey).toBe('personal')
    expect(loadConfig({ ...base, IU_KEY_ID: '' }).iuKey).toBe('personal')
    expect(loadConfig({ ...base, IU_KEY_ID: 'athena-team' }).iuKey).toBe('athena-team')
    const attempt = () => loadConfig({ ...base, IU_KEY_ID: 'sk-not-an-id' })
    expect(attempt).toThrow('IU_KEY_ID')
    expect(attempt).not.toThrow('sk-not-an-id')
  })
  test('a secret with whitespace is named, not echoed', () => {
    const attempt = () => loadConfig({ ...base, AGW_API_SECRET: `${SECRET}\n` })
    expect(attempt).toThrow('whitespace')
    expect(attempt).not.toThrow(SECRET)
  })
  test('names every problem and never echoes a value', () => {
    const attempt = () => loadConfig({ AGW_API_SECRET: 'short-but-secret-looking', AGW_PORT: 'abc' })
    expect(attempt).toThrow('AGW_API_SECRET')
    expect(attempt).toThrow('AGW_MACHINE')
    expect(attempt).toThrow('AGW_PG_URL')
    expect(attempt).toThrow('AGW_PORT')
    expect(attempt).not.toThrow('short-but-secret-looking')
  })
})

describe('lazyOpenCodeHost', () => {
  /** A server stand-in: no process, no state directory. `start` decides what each attempt does. */
  function fake(starts: (attempt: number) => Promise<void>) {
    const calls = { created: 0, started: 0, closed: 0 }
    const createServer = () => {
      calls.created++
      return {
        endpoint: () => ({ baseUrl: 'http://127.0.0.1:1', password: 'x' }),
        ready: async () => {},
        start: () => starts(++calls.started),
        close: async () => {
          calls.closed++
        },
      }
    }
    return { calls, createServer }
  }

  test('builds nothing until the first agent step: close is a no-op, and a step after close is refused', async () => {
    const { calls, createServer } = fake(async () => {})
    const host = lazyOpenCodeHost({}, () => undefined, { createServer })
    await host.close()
    expect(calls.created).toBe(0)
    expect(await rejection(host.abort({}))).toContain('closed')
  })

  test('a failed start is not cached: the next step tries again', async () => {
    const { calls, createServer } = fake(async (attempt) => {
      if (attempt === 1) throw new Error('boom')
    })
    const host = lazyOpenCodeHost({}, () => undefined, { createServer })
    expect(await rejection(host.abort({}))).toBe('boom')
    // the second attempt starts, so the host itself answers (a handle that is not one of its own)
    expect(await rejection(host.abort({}))).toContain('not an OpenCode host handle')
    expect(calls.started).toBe(2)
    await host.close()
    expect(calls.closed).toBe(1)
  })

  test('close does not wait for a start in flight past its bound, and that start is closed when it ends', async () => {
    let finish = () => {}
    const { calls, createServer } = fake(() => new Promise<void>((resolve) => (finish = resolve)))
    const host = lazyOpenCodeHost({}, () => undefined, { createServer, closeWaitMs: 20 })
    const step = rejection(host.abort({}))
    await until(async () => calls.started, 'start begun', 2000)
    const began = Date.now()
    await host.close()
    expect(Date.now() - began).toBeLessThan(1000)
    expect(calls.closed).toBe(0)
    finish()
    expect(await step).toContain('closed')
    expect(calls.closed).toBe(1)
  })

  test('a real server runs on the given state directory, never the real one', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'agw-lazy-'))
    try {
      // no opencode binary on this PATH: the start fails after the server has made its directories
      const host = lazyOpenCodeHost({ PATH: '/nonexistent' }, () => undefined, { stateDir })
      await rejection(host.abort({}))
      expect(existsSync(join(stateDir, 'opencode', 'home'))).toBe(true)
      await host.close()
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })
})

describe('boot', () => {
  const ROUTE = 'review.angle' // an opencode route: its table entry has a rate and a fallback
  test('a taken port fails the start before the runtime opens: no schema, no claimed run, nothing left open', async () => {
    const fresh = freshSchema('boot')
    const squatter = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('taken') })
    const pool = new Pool({ connectionString: PG_URL, max: 1 })
    try {
      const config = loadConfig({ ...valid(fresh.schema), AGW_PORT: String(squatter.port) })
      expect(await rejection(boot(config))).toMatch(/port|EADDRINUSE|in use/i)
      // runtime.open() migrates the schema; it never ran
      const { rowCount } = await pool.query('select 1 from information_schema.schemata where schema_name = $1', [
        fresh.schema,
      ])
      expect(rowCount).toBe(0)
    } finally {
      await squatter.stop(true)
      await pool.end()
      await fresh.drop()
    }
  })

  test('a bad AGW_ROUTES refuses the start, naming the route id or the problem and never the override content', async () => {
    const fresh = freshSchema('bootroutes')
    const pool = new Pool({ connectionString: PG_URL, max: 1 })
    try {
      const config = loadConfig(valid(fresh.schema))
      const refused = (AGW_ROUTES: string) => rejection(boot(config, { env: { AGW_ROUTES } }))
      const unknown = await refused(JSON.stringify({ 'no.such.route': { model: 'leaky-model-name' } }))
      expect(unknown).toContain('AGW_ROUTES')
      expect(unknown).toContain('no.such.route')
      expect(unknown).not.toContain('leaky-model-name')
      const bad = await refused(JSON.stringify({ [ROUTE]: { effort: 'leaky-effort' } }))
      expect(bad).toContain('AGW_ROUTES')
      expect(bad).toContain(`"${ROUTE}"`)
      expect(bad).not.toContain('leaky-effort')
      // the parser quotes what it chokes on; the error must not
      const malformed = await refused('{"check": leakysecret}')
      expect(malformed).toContain('AGW_ROUTES: not valid JSON')
      expect(malformed).not.toContain('leakysecret')
      // nothing was opened: the schema was never migrated
      const { rowCount } = await pool.query('select 1 from information_schema.schemata where schema_name = $1', [
        fresh.schema,
      ])
      expect(rowCount).toBe(0)
    } finally {
      await pool.end()
      await fresh.drop()
    }
  })

  test('a valid AGW_ROUTES boots, and no AGW_ROUTES boots as before', async () => {
    const fresh = freshSchema('bootroutes2')
    try {
      // A patch built from the resolved route that really changes it, on a field with no ceiling to trip over.
      // That boot reads this env at all is shown by the refusals above: the same channel carries the bad ones.
      const route = resolveRoute(ROUTE, {})
      const patch = { [ROUTE]: { effort: route.effort === 'low' ? 'high' : 'low' } }
      for (const env of [{ AGW_ROUTES: JSON.stringify(patch) }, {}]) {
        const running = await boot(loadConfig(valid(fresh.schema)), { env })
        await running.shutdown()
      }
    } finally {
      await fresh.drop()
    }
  })

  test('a start that works can be shut down twice', async () => {
    const fresh = freshSchema('boot2')
    try {
      const running = await boot(loadConfig(valid(fresh.schema)))
      expect((await fetch(`http://127.0.0.1:${running.port}/health`)).status).toBe(200)
      await Promise.all([running.shutdown(), running.shutdown()])
      expect(
        await fetch(`http://127.0.0.1:${running.port}/health`).then(
          () => 'up',
          () => 'down',
        ),
      ).toBe('down')
    } finally {
      await fresh.drop()
    }
  })
})

describe('process entry', () => {
  const children: ReturnType<typeof Bun.spawn>[] = []
  afterEach(() => {
    for (const child of children.splice(0)) child.kill('SIGKILL')
  })

  function start(env: Record<string, string>) {
    const child = Bun.spawn([process.execPath, MAIN], {
      env: envFor({ AGW_DOOR_CALLERS_FILE: TOKENS_FILE, ...env }),
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
    })
    children.push(child)
    return child
  }

  async function listening(child: ReturnType<typeof start>): Promise<number> {
    const reader = child.stdout.getReader()
    let text = ''
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      const { value, done } = await Promise.race([
        reader.read(),
        Bun.sleep(deadline - Date.now()).then(() => ({ value: undefined, done: true })),
      ])
      if (done) break
      text += new TextDecoder().decode(value)
      const match = /listening on 127\.0\.0\.1:(\d+)/.exec(text)
      if (match) {
        reader.releaseLock()
        return Number(match[1])
      }
    }
    throw new Error(`host did not start; stdout so far:\n${text}`)
  }

  test.each([
    ['AGW_API_SECRET unset', { AGW_API_SECRET: undefined }, 'AGW_API_SECRET'],
    ['AGW_API_SECRET shorter than 32', { AGW_API_SECRET: 'x'.repeat(31) }, 'AGW_API_SECRET'],
    ['AGW_MACHINE unset', { AGW_MACHINE: undefined }, 'AGW_MACHINE'],
    ['AGW_PG_URL unset', { AGW_PG_URL: undefined }, 'AGW_PG_URL'],
  ])('refuses to start: %s', async (_name, override, variable) => {
    const env = { ...valid('agw_t_main_refuse'), ...override } as Record<string, string | undefined>
    const clean = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)) as Record<string, string>
    const child = start(clean)
    expect(await child.exited).not.toBe(0)
    const stdout = await new Response(child.stdout).text()
    expect(await new Response(child.stderr).text()).toContain(variable)
    expect(stdout).not.toContain('listening')
  })

  test.each([
    ['no file', (dir: string) => join(dir, 'absent'), 'is missing'],
    [
      'a wider mode',
      (dir: string) => {
        const file = join(dir, 'wide')
        writeFileSync(file, `studio=${DOOR_TOKEN}\n`)
        chmodSync(file, 0o644)
        return file
      },
      'mode 0600',
    ],
    [
      'a malformed line',
      (dir: string) => {
        const file = join(dir, 'malformed')
        writeFileSync(file, `# callers\nstudio ${DOOR_TOKEN}\n`, { mode: 0o600 })
        return file
      },
      'malformed:2: expected name=token',
    ],
  ])(
    'refuses to start on a door-tokens file with %s, naming the file and never a token',
    async (_name, make, message) => {
      const dir = mkdtempSync(join(tmpdir(), 'agw-main-bad-tokens-'))
      try {
        const file = make(dir)
        const child = start(valid('agw_t_main_refuse', { AGW_DOOR_CALLERS_FILE: file }))
        expect(await child.exited).not.toBe(0)
        const stderr = await new Response(child.stderr).text()
        expect(stderr).toContain(message)
        expect(stderr).toContain(file)
        expect(stderr).not.toContain(DOOR_TOKEN)
        expect(await new Response(child.stdout).text()).not.toContain('listening')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )

  test('SIGTERM stops the process with exit 0 and leaves a running run running', async () => {
    const fresh = freshSchema('main')
    const { schema } = fresh
    // An IU that never answers keeps the smoke run's only step open, so the run is mid-flight at SIGTERM.
    const hang = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Promise<Response>(() => {}) })
    const pool = new Pool({ connectionString: PG_URL, max: 1 })
    try {
      const child = start(valid(schema, { IU_BASE_URL: `http://127.0.0.1:${hang.port}/anthropic` }))
      const port = await listening(child)
      const base = `http://127.0.0.1:${port}`
      const auth = { authorization: `Bearer ${SECRET}` }

      expect((await fetch(`${base}/health`)).status).toBe(200)
      expect((await fetch(`${base}/openapi.json`)).status).toBe(401)
      const started = await fetch(`${base}/workflows/smoke/ping`, { method: 'POST', headers: auth })
      expect(started.status).toBe(202)
      const { runId } = (await started.json()) as { runId: string }
      await until(
        async () =>
          (await pool.query(`select 1 from "${schema}".steps where run_id = $1 and status = 'running'`, [runId]))
            .rowCount,
        'smoke step running',
        10_000,
      )

      child.kill('SIGTERM')
      expect(await child.exited).toBe(0)
      const { rows } = await pool.query(`select status, finished_at from "${schema}".runs where id = $1`, [runId])
      expect(rows[0]).toEqual({ status: 'running', finished_at: null })
    } finally {
      await hang.stop(true)
      await pool.end()
      await fresh.drop()
    }
  }, 40_000)

  test('a second process resumes the run the first one left (deploys need no drain)', async () => {
    const fresh = freshSchema('main2')
    const { schema } = fresh
    let phase: 'hang' | 'answer' = 'hang'
    const iu = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () =>
        phase === 'hang'
          ? new Promise<Response>(() => {})
          : Response.json({
              model: 'fake',
              stop_reason: 'end_turn',
              content: [{ type: 'text', text: 'Resumed Title' }],
              usage: { input_tokens: 3, output_tokens: 2 },
            }),
    })
    const pool = new Pool({ connectionString: PG_URL, max: 1 })
    try {
      const env = valid(schema, { IU_BASE_URL: `http://127.0.0.1:${iu.port}/anthropic` })
      const first = start(env)
      const base1 = `http://127.0.0.1:${await listening(first)}`
      const started = await fetch(`${base1}/workflows/smoke/ping`, {
        method: 'POST',
        headers: { authorization: `Bearer ${SECRET}` },
      })
      const { runId } = (await started.json()) as { runId: string }
      await until(
        async () =>
          (await pool.query(`select 1 from "${schema}".steps where run_id = $1 and status = 'running'`, [runId]))
            .rowCount,
        'step running',
        10_000,
      )
      first.kill('SIGTERM')
      expect(await first.exited).toBe(0)

      phase = 'answer'
      const second = start(env)
      const base2 = `http://127.0.0.1:${await listening(second)}`
      const ended = await fetch(`${base2}/runs/${runId}/wait`, {
        method: 'POST',
        headers: { authorization: `Bearer ${SECRET}`, prefer: 'wait=30' },
      })
      expect(ended.status).toBe(200)
      expect(await ended.json()).toMatchObject({ runId, status: 'done', output: { title: 'Resumed Title' } })
      second.kill('SIGTERM')
      await second.exited
    } finally {
      await iu.stop(true)
      await pool.end()
      await fresh.drop()
    }
  }, 60_000)
})

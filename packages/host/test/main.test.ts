import { afterEach, describe, expect, test } from 'bun:test'
import { boot } from '../src/boot.ts'
import { loadConfig } from '../src/config.ts'
import { Pool } from 'pg'
import { freshSchema, PG_URL, rejection, SECRET, until } from './support.ts'

const MAIN = new URL('../src/main.ts', import.meta.url).pathname

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

describe('boot', () => {
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
      env: envFor(env),
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

  test('SIGTERM stops the process with exit 0 and leaves a running run running', async () => {
    const fresh = freshSchema('main')
    const { schema } = fresh
    // An IU that never answers keeps the smoke run's only step open, so the run is mid-flight at SIGTERM.
    const hang = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) })
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

import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { boot } from '../src/boot.ts'
import { loadConfig } from '../src/config.ts'
import { freshSchema, PG_URL, SECRET } from './support.ts'

// The whole wiring in one boot: the reads, the workflow and the contract come out of `hostProcess`, with the Argo timer
// switched off (`AGW_ARGO_PUSH=0`) and every collector pointed at an empty directory, so the test reads nothing of the host.

test('a booted host serves agents, quota and quota-report beside the overview workflow, and journals none of the reads', async () => {
  const fresh = freshSchema('overviewboot')
  const home = mkdtempSync(join(tmpdir(), 'overview-boot-'))
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: home,
    XDG_STATE_HOME: home,
    AGW_ARGO_PUSH: '0',
    AGW_HERDR_BIN: join(home, 'no-herdr'),
    AGW_CLAUDE_BIN: join(home, 'no-claude'),
    AGW_CLAUDE_ACCOUNT_BIN: join(home, 'no-claude-account'),
    AGW_API_SECRET: SECRET,
    AGW_MACHINE: 'test-machine',
    AGW_PG_URL: PG_URL,
    AGW_PG_SCHEMA: fresh.schema,
    AGW_PORT: '0',
    IU_API_KEY: 'test-key',
  }
  const running = await boot(loadConfig(env), { env })
  try {
    const call = (path: string, body?: unknown) =>
      fetch(`http://127.0.0.1:${running.port}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })

    // collectors that find nothing are warnings, never a failure
    const agents = (await (await call('/agents', {})).json()) as {
      data: { summary: Record<string, number>; warnings: string[] }
    }
    expect(agents.data.summary).toEqual({ needsYou: 0, working: 0, idle: 0, stale: 0, done: 0, dispatch: 0 })
    expect(agents.data.warnings.some((w) => w.includes('herdr agent list failed'))).toBe(true)

    expect((await call('/quota/report', { fiveHourPct: 12, account: 'iu' })).status).toBe(200)
    const quota = (await (await call('/quota')).json()) as { data: { five_hour_pct: number } }
    expect(quota.data.five_hour_pct).toBe(12)

    const doc = (await (await call('/openapi.json')).json()) as { paths: Record<string, unknown> }
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining(['/agents', '/quota', '/quota/report', '/workflows/overview']),
    )
    expect(Object.keys(doc.paths)).not.toContain('/overview/classify') // the seat is internal: only the workflow calls it

    const { Pool } = await import('pg')
    const pool = new Pool({ connectionString: PG_URL, max: 1 })
    try {
      const { rows } = await pool.query(`select count(*)::int as n from "${fresh.schema}".runs`)
      expect(rows[0].n).toBe(0)
    } finally {
      await pool.end()
    }
  } finally {
    await running.shutdown()
    rmSync(home, { recursive: true, force: true })
    await fresh.drop()
  }
})

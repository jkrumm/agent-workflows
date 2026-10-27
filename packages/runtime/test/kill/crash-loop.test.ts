// The poison-run cap survives restarts: a run that kills its process on every boot ends as crash_loop.
import { afterAll, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { Pool } from 'pg'
import { Runtime } from '../../src/index.ts'
import { freshSchema, PG_URL } from '../support/pg.ts'
import { poison } from './crash-worker.ts'

const db = freshSchema('crash')
const pool = new Pool({ connectionString: PG_URL, max: 2 })

afterAll(async () => {
  await pool.end()
  await db.drop()
})

test('a step that kills the process on every boot reaches the drive cap and the run fails as crash_loop', async () => {
  const starter = new Runtime({ connectionString: PG_URL, schema: db.schema, workflows: [poison], journalPoolSize: 1 })
  await starter.open()
  await starter.close()
  const reader = new Runtime({ connectionString: PG_URL, schema: db.schema, workflows: [poison], journalPoolSize: 1 })
  const { runId } = await reader.start(poison, {}, { purpose: 'eval' })

  let boots = 0
  const deadline = Date.now() + 30_000
  for (;;) {
    const { rows } = await pool.query(`select status, error_kind, drives from "${db.schema}".runs where id = $1`, [
      runId,
    ])
    if (rows[0]?.status !== 'running' && rows[0]?.status !== 'pending') break
    if (Date.now() > deadline) throw new Error(`no end after ${boots} boots: ${JSON.stringify(rows[0])}`)
    boots++
    const proc = Bun.spawn(['bun', resolve(import.meta.dir, 'crash-worker.ts')], {
      env: { ...process.env, KILL_SCHEMA: db.schema, MAX_DRIVES: '3' },
      stdout: 'ignore',
      stderr: 'ignore',
    })
    // Each boot either dies on the poison step or ends the run at the cap; stop a survivor once the run ended.
    const ended = (async () => {
      for (;;) {
        await Bun.sleep(50)
        const { rows: now } = await pool.query(`select status from "${db.schema}".runs where id = $1`, [runId])
        if (now[0]?.status === 'failed') return
      }
    })()
    await Promise.race([proc.exited, ended])
    proc.kill('SIGTERM')
    await proc.exited
  }
  const result = await reader.wait(runId)
  await reader.close()
  expect(result.status).toBe('failed')
  expect(result.error?.kind).toBe('crash_loop')
  const { rows } = await pool.query(`select drives from "${db.schema}".runs where id = $1`, [runId])
  expect(rows[0]?.drives).toBe(4)
  expect(boots).toBe(4)
}, 40_000)

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Pool } from 'pg'
import { z } from 'zod'
import { defineWorkflow, InfraError, LeaseLost } from '../src/index.ts'
import { Journal } from '../src/journal.ts'
import { lockKey } from '../src/lease.ts'
import { migrate } from '../src/migrate.ts'
import { captureLogger, freshSchema, inspector, PG_URL, testRuntime, until } from './support/pg.ts'

const db = freshSchema('infra')
const sql = inspector(db.schema)

beforeAll(async () => {
  await migrate(sql.pool, db.schema)
})

afterAll(async () => {
  await sql.close()
  await db.drop()
})

const empty = z.object({})

describe('migrations', () => {
  test('concurrent migrators apply each numbered file once, in one transaction under a lock', async () => {
    const fresh = freshSchema('mig')
    const pools = Array.from({ length: 4 }, () => new Pool({ connectionString: PG_URL, max: 1 }))
    try {
      const applied = await Promise.all(pools.map((p) => migrate(p, fresh.schema)))
      expect(applied.flat()).toEqual(['0001_journal.sql'])
      const { rows } = await sql.pool.query(`select version from "${fresh.schema}".schema_migrations`)
      expect(rows.map((r) => r.version)).toEqual(['0001_journal.sql'])
    } finally {
      await Promise.all(pools.map((p) => p.end()))
      await fresh.drop()
    }
  })
})

describe('lease keys', () => {
  test('are 64-bit and stable', () => {
    const key = lockKey('agw:run-1')
    expect(lockKey('agw:run-1')).toBe(key)
    expect(BigInt(key) > 2n ** 31n || BigInt(key) < -(2n ** 31n)).toBe(true)
  })
})

describe('fencing', () => {
  test('a write carrying a superseded lease token matches nothing and raises LeaseLost', async () => {
    const journal = new Journal(sql.pool, db.schema)
    const id = `fence-${crypto.randomUUID()}`
    await journal.insertRun({
      id,
      workflow: 'fence',
      parentId: null,
      rootId: id,
      purpose: 'build',
      input: {},
      inputHash: '-',
      idempotencyKey: null,
      traceparent: null,
      traceId: null,
      version: 'v1',
    })
    const stale = { rootId: id, token: 'old' }
    await journal.takeLease(id, 'old')
    await journal.stepRunning(id, 's', 'code', stale)
    await journal.takeLease(id, 'new') // another process took the run over
    const staleWrite = await journal
      .finishStep(id, 's', stale, {
        status: 'done',
        output: 1,
        error: null,
        model: null,
        usage: {
          tokens: { input: 0, output: 0, cacheRead: 0, reasoning: 0 },
          cost: null,
          toolCalls: 0,
          unpricedCalls: 0,
          byModel: {},
        },
      })
      .catch((err: unknown) => err)
    expect(staleWrite).toBeInstanceOf(LeaseLost)
    expect(await sql.step(id, 's')).toMatchObject({ status: 'running' })
  })

  test('losing the lease connection aborts the run without a failed mark; recovery finishes it', async () => {
    const aborts: unknown[] = []
    let calls = 0
    const wf = defineWorkflow({
      id: 'infra.lease-lost',
      version: 'v1',
      input: empty,
      output: z.object({ calls: z.number() }),
      async run(ctx) {
        const n = await ctx.step('hold', async ({ signal }) => {
          calls++
          if (calls === 1) {
            await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()))
            aborts.push(signal.reason)
          }
          return calls
        })
        return { calls: n }
      },
    })
    const logger = captureLogger()
    const rt = testRuntime({ schema: db.schema, workflows: [wf], logger })
    await rt.open()
    try {
      const { runId } = await rt.start(wf, {}, { purpose: 'build' })
      await until(() => calls === 1, 'first attempt')
      await sql.pool.query('select pg_terminate_backend(pid) from pg_stat_activity where application_name = $1', [
        `agw-lease:${db.schema}`,
      ])
      expect((await rt.wait(runId)).output).toEqual({ calls: 2 })
      expect(aborts[0]).toBeInstanceOf(InfraError)
      expect(await sql.step(runId, 'hold')).toMatchObject({ status: 'done', attempts: 2 })
    } finally {
      await rt.close()
    }
  })
})

describe('infra errors', () => {
  test('a journal failure leaves the run running and it is retried with backoff, never marked failed', async () => {
    let calls = 0
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const wf = defineWorkflow({
      id: 'infra.journal-down',
      version: 'v1',
      input: empty,
      output: z.object({ ok: z.boolean() }),
      async run(ctx) {
        await ctx.step('work', async () => {
          calls++
          if (calls === 1) await gate
          return null
        })
        return { ok: true }
      },
    })
    const logger = captureLogger()
    const rt = testRuntime({ schema: db.schema, workflows: [wf], logger })
    await rt.open()
    try {
      const { runId } = await rt.start(wf, {}, { purpose: 'build' })
      await until(() => calls === 1, 'step start')
      await sql.pool.query(`alter table "${db.schema}".steps rename to steps_away`)
      release()
      await until(() => logger.lines.filter((l) => l.message.includes('infra error')).length >= 2, 'infra retries')
      expect((await sql.run(runId))?.status).toBe('running')
      await sql.pool.query(`alter table "${db.schema}".steps_away rename to steps`)
      expect(await rt.wait(runId)).toMatchObject({ status: 'done', output: { ok: true } })
      expect(await sql.step(runId, 'work')).toMatchObject({ status: 'done' })
    } finally {
      await rt.close()
    }
  })
})

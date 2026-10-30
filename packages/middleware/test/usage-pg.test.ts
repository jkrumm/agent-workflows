import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { defineWorkflow } from '@agent-workflows/runtime'
import { Pool } from 'pg'
import { z } from 'zod'
import {
  JournalDb,
  pgUsageTransport,
  type UsageRow,
  UsageOutbox,
  type UsageTransport,
  usageRowsForStep,
} from '../src/index.ts'
import { captureLogger, freshSchema, inspector, PG_URL, testPlatform, testRuntime, until } from './support.ts'

// The real `usage` schema in a scratch database: usage-tracker owns the DDL, so its migrations are applied as they are
// (`USAGE_MIGRATIONS_DIR`, default the sibling checkout). Creating a database needs an admin connection
// (`USAGE_TEST_PG_URL`, as usage-tracker's own tests: `make check` builds it through secrets-run); the journal's test
// role may only create schemas. Either one absent skips the suite, with the reason in its name and on stderr.

const ADMIN_URL = process.env.USAGE_TEST_PG_URL
const MIGRATIONS_DIR = resolve(
  process.env.USAGE_MIGRATIONS_DIR ??
    join(import.meta.dir, '..', '..', '..', '..', 'usage-tracker', 'migrations', 'pg'),
)

const skipReason = !ADMIN_URL
  ? 'USAGE_TEST_PG_URL unset: no admin connection to create a scratch database'
  : !existsSync(MIGRATIONS_DIR)
    ? `usage migrations not found at ${MIGRATIONS_DIR} (set USAGE_MIGRATIONS_DIR)`
    : null
if (skipReason) console.warn(`usage postgres tests skipped: ${skipReason}`)

const describePg = skipReason ? describe.skip : describe
const suite = skipReason ? `usage postgres (skipped: ${skipReason})` : 'usage postgres'

const scratchName = `usage_test_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
const SCRATCH_NAME = /^usage_test_[0-9a-f]{12}$/

const journal = freshSchema('mwu')
const sql = inspector(journal.schema)
const logger = captureLogger()

let admin: Pool
let scratch: Pool
let scratchUrl = ''

afterAll(async () => {
  await sql.close()
  await journal.drop()
  await scratch?.end()
  // The admin role can drop anything on the shared server: only the name this file generated ever reaches DDL.
  if (admin && SCRATCH_NAME.test(scratchName)) await admin.query(`drop database if exists ${scratchName} with (force)`)
  await admin?.end()
})

beforeAll(async () => {
  if (skipReason || !ADMIN_URL) return
  admin = new Pool({ connectionString: ADMIN_URL, max: 1 })
  await admin.query(`create database ${scratchName}`)
  const url = new URL(ADMIN_URL)
  url.pathname = `/${scratchName}`
  scratchUrl = url.toString()
  scratch = new Pool({ connectionString: scratchUrl, max: 2 })
  await scratch.query('create schema usage')
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    await scratch.query(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  // The scratch price tables start empty; one catalog price: $1 per 1M input, $2 per 1M output.
  await scratch.query(
    `insert into usage.prices (model_key, valid_from, input, output, source) values ('priced-model', '2026-01-01', 1, 2, 'seed-git')`,
  )
})

const n = z.object({ n: z.number() })
const tokens = { input: 1_000_000, output: 500_000, cacheRead: 0, reasoning: 0 }

function usageWorkflow(id: string, model: string, cost: number | null) {
  return defineWorkflow({
    id,
    version: 'v1',
    input: n,
    output: n,
    async run(ctx, { n }) {
      await ctx.step('work', ({ addUsage }) => {
        addUsage({ model, tokens, cost })
        return n
      })
      return { n }
    },
  })
}

const reported = usageWorkflow('u.reported', 'm1', 0.001)
const priced = usageWorkflow('u.priced', 'priced-model', null)
const mystery = usageWorkflow('u.mystery', 'mystery-model', null)

/** Finished runs of one workflow, their runPost delivered (what the outbox waits for). */
async function finished(workflow: typeof reported, count: number, project?: string): Promise<string[]> {
  const platform = testPlatform(journal.schema)
  const rt = testRuntime({ schema: journal.schema, workflows: [workflow], middleware: platform.middleware })
  await rt.open()
  try {
    const ids = await Promise.all(
      Array.from(
        { length: count },
        async (_, i) =>
          (await rt.start(workflow, { n: i }, { purpose: 'build', ...(project ? { project } : {}) })).runId,
      ),
    )
    await Promise.all(ids.map((id) => rt.wait(id)))
    await until(async () => (await Promise.all(ids.map((id) => sql.run(id)))).every((r) => r?.post_hooks_at), 'runPost')
    return ids
  } finally {
    await rt.close()
    await platform.close()
  }
}

function outboxFor(transport: UsageTransport, extra: Partial<ConstructorParameters<typeof UsageOutbox>[0]> = {}) {
  const db = new JournalDb({ connectionString: PG_URL, schema: journal.schema }, logger)
  const outbox = new UsageOutbox({ db, transport, logger, machine: 'test-machine', ...extra })
  return { outbox, close: () => db.close() }
}

const record = async (sourceId: string) =>
  (
    await scratch.query('select * from usage.records where source = $1 and source_id = $2', [
      'agent-workflows',
      sourceId,
    ])
  ).rows[0] as Record<string, unknown> | undefined

describePg(suite, () => {
  test('first post: one record per step and model, its session, cost from the reported value', async () => {
    const [runId = ''] = await finished(reported, 1, 'argo')
    const transport = pgUsageTransport({ connectionString: scratchUrl, logger })
    const { outbox, close } = outboxFor(transport)
    try {
      expect(await outbox.flush()).toMatchObject({ posted: expect.any(Number), error: null, quarantined: 0 })
      const row = await record(`${runId}:work:m1`)
      expect(row).toMatchObject({
        source: 'agent-workflows',
        grain: 'session',
        model_raw: 'm1',
        model: 'm1',
        repo: 'argo',
        project_raw: 'argo',
        billing: 'api_key',
        api_key: 'personal',
        account: null,
        machine: 'test-machine',
        outcome: 'ok',
        lane: 'agw_workflow',
        lane_detail: { workflow: 'u.reported', step: 'work', caller: 'host', purpose: 'build' },
        run_id: runId,
        input_tokens: '1000000',
        output_tokens: '500000',
        cache_read_tokens: '0',
        cache_write_5m_tokens: '0',
        cache_write_1h_tokens: '0',
        reasoning_tokens: '0',
        cost_source: 'reported',
      })
      expect(Number(row?.cost_reported_usd)).toBe(0.001)
      expect(Number(row?.cost_usd)).toBe(0.001)
      expect(row?.raw).toMatchObject({ runId, stepId: 'work', purpose: 'build' })
      const { rows: sessions } = await scratch.query('select * from usage.sessions where source_session_id = $1', [
        runId,
      ])
      expect(sessions).toHaveLength(1)
      expect(sessions[0]).toMatchObject({
        source: 'agent-workflows',
        lane: 'agw_workflow',
        lane_detail: { workflow: 'u.reported', caller: 'host', purpose: 'build' },
        billing: 'api_key',
        api_key: 'personal',
        machine: 'test-machine',
        model: 'm1',
        repo: 'argo',
        run_id: runId,
      })
      expect(row?.session_id).toBe(sessions[0]?.id)
      expect(sessions[0]?.first_ts).toEqual(row?.ts as Date)
      const step = await sql.step(runId, 'work')
      expect(step?.argo_synced_at).toBeInstanceOf(Date)
    } finally {
      await close()
      await transport.close?.()
    }
  })

  test('re-posting the same rows changes nothing: no new row, no new tuple version, one session', async () => {
    const [runId = ''] = await finished(reported, 1)
    const transport = pgUsageTransport({ connectionString: scratchUrl, logger })
    const { outbox, close } = outboxFor(transport)
    try {
      await outbox.flush()
      const before = await scratch.query(
        `select r.id, r.xmin::text as rx, s.xmin::text as sx from usage.records r join usage.sessions s on s.id = r.session_id
         where r.source_id = $1`,
        [`${runId}:work:m1`],
      )
      // The same step claimed and written again (a crash between write and mark, or a lost claim).
      await sql.pool.query(
        `update "${journal.schema}".steps set argo_synced_at = null where run_id = $1 and step_id = 'work'`,
        [runId],
      )
      expect(await outbox.flush()).toMatchObject({ posted: 1, marked: 1, error: null })
      const after = await scratch.query(
        `select r.id, r.xmin::text as rx, s.xmin::text as sx from usage.records r join usage.sessions s on s.id = r.session_id
         where r.source_id = $1`,
        [`${runId}:work:m1`],
      )
      expect(after.rows).toEqual(before.rows)
      const { rows: counts } = await scratch.query(
        `select (select count(*) from usage.records where run_id = $1)::int as records,
                (select count(*) from usage.sessions where run_id = $1)::int as sessions`,
        [runId],
      )
      expect(counts[0]).toEqual({ records: 1, sessions: 1 })
    } finally {
      await close()
      await transport.close?.()
    }
  })

  test('a rescored run re-posts: raw is updated in place, ingested_at and the row id stay', async () => {
    const [runId = ''] = await finished(reported, 1)
    const transport = pgUsageTransport({ connectionString: scratchUrl, logger })
    const { outbox, close } = outboxFor(transport)
    try {
      await outbox.flush()
      const before = await record(`${runId}:work:m1`)
      expect(before?.raw).toMatchObject({ scorePass: null })
      await sql.pool.query(`update "${journal.schema}".runs set scores = $2::jsonb where id = $1`, [
        runId,
        JSON.stringify({ final: { source: 'drift', scorer: 's1', scores: { ok: 1 }, pass: true } }),
      ])
      await sql.pool.query(
        `update "${journal.schema}".steps set argo_synced_at = null where run_id = $1 and step_id = 'work'`,
        [runId],
      )
      await outbox.flush()
      const after = await record(`${runId}:work:m1`)
      expect(after?.raw).toMatchObject({ scorePass: true })
      expect(after?.id).toBe(before?.id)
      expect(after?.ingested_at).toEqual(before?.ingested_at as Date)
      const { rows } = await scratch.query('select count(*)::int as n from usage.records where run_id = $1', [runId])
      expect(rows[0]?.n).toBe(1)
    } finally {
      await close()
      await transport.close?.()
    }
  })

  test('cost: an unknown model is NULL (never 0), a catalog model is priced by the tables, a reported cost wins', async () => {
    const [pricedId = ''] = await finished(priced, 1)
    const [mysteryId = ''] = await finished(mystery, 1)
    const transport = pgUsageTransport({ connectionString: scratchUrl, logger })
    const { outbox, close } = outboxFor(transport)
    try {
      await outbox.flush()
      const unknown = await record(`${mysteryId}:work:mystery-model`)
      expect(unknown).toMatchObject({ cost_reported_usd: null, cost_usd: null, cost_source: 'none', price_id: null })
      const byPrices = await record(`${pricedId}:work:priced-model`)
      expect(byPrices).toMatchObject({ cost_reported_usd: null, cost_source: 'prices' })
      expect(Number(byPrices?.cost_usd)).toBeCloseTo(2, 9) // 1M input at $1 + 0.5M output at $2
      expect(byPrices?.price_id).not.toBeNull()
    } finally {
      await close()
      await transport.close?.()
    }
  })

  test('a row the database refuses quarantines only its step; the rest are written', async () => {
    const [bad = '', ...good] = await finished(reported, 4)
    // A step that ran longer than duration_ms (integer) can hold: SQLSTATE 22003, a data exception, permanent.
    await sql.pool.query(
      `update "${journal.schema}".steps set finished_at = started_at + interval '40 days' where run_id = $1`,
      [bad],
    )
    const transport = pgUsageTransport({ connectionString: scratchUrl, logger })
    const { outbox, close } = outboxFor(transport)
    try {
      expect(await outbox.flush()).toMatchObject({ quarantined: 1, error: null })
      const step = await sql.step(bad, 'work')
      expect(String(step?.argo_error)).toContain('22003')
      expect([step?.argo_synced_at, step?.argo_claim]).toEqual([null, null])
      expect(await record(`${bad}:work:m1`)).toBeUndefined()
      expect((await scratch.query('select 1 from usage.sessions where source_session_id = $1', [bad])).rowCount).toBe(0) // the refused transaction rolled its session back too
      for (const id of good) expect(await record(`${id}:work:m1`)).toBeDefined()
      // Quarantined steps are not claimed again.
      expect(await outbox.flush()).toMatchObject({ posted: 0, quarantined: 0 })
    } finally {
      await close()
      await transport.close?.()
    }
  })

  test('a database that is down is transient: nothing quarantined, claim released, written once it is back', async () => {
    const ids = await finished(reported, 3)
    const real = pgUsageTransport({ connectionString: scratchUrl, logger })
    // Nothing listens on port 1: the connection is refused.
    const dead = pgUsageTransport({ connectionString: 'postgres://usage:unused@127.0.0.1:1/shared', logger })
    let up = false
    const flaky: UsageTransport = { write: (rows) => (up ? real : dead).write(rows) }
    let now = 1_000
    const { outbox, close } = outboxFor(flaky, { backoff: { baseMs: 100, maxMs: 100 }, now: () => now })
    try {
      const failed = await outbox.flush()
      expect(failed).toMatchObject({ posted: 0, quarantined: 0, error: expect.stringMatching(/ECONNREFUSED|refused/i) })
      for (const id of ids) {
        const step = await sql.step(id, 'work')
        expect([step?.argo_error, step?.argo_claim, step?.argo_synced_at]).toEqual([null, null, null])
      }
      expect(await outbox.flush()).toMatchObject({ skipped: 'backoff' })
      up = true
      now += 100
      expect(await outbox.flush()).toMatchObject({ posted: 3, marked: 3, error: null, skipped: null })
      for (const id of ids) expect(await record(`${id}:work:m1`)).toBeDefined()
      // The connection string (a password in production) is in no log line.
      expect(JSON.stringify(logger.lines)).not.toContain('unused')
    } finally {
      await close()
      await real.close?.()
      await dead.close?.()
    }
  })

  test('rows of one run written in two batches: the session spans both', async () => {
    const transport = pgUsageTransport({ connectionString: scratchUrl, logger })
    const [first] = usageRowsForStep(stepAt('run_split', 'a', new Date('2026-10-27T10:00:00Z')), { machine: 'm' })
    const [second] = usageRowsForStep(stepAt('run_split', 'b', new Date('2026-10-27T10:05:00Z')), { machine: 'm' })
    try {
      await transport.write([second as UsageRow])
      await transport.write([first as UsageRow])
      const { rows } = await scratch.query(
        'select first_ts, last_ts, model from usage.sessions where source_session_id = $1',
        ['run_split'],
      )
      expect(rows).toHaveLength(1)
      expect(rows[0]?.first_ts).toEqual(new Date('2026-10-27T10:00:00.000Z'))
      expect(rows[0]?.last_ts).toEqual(new Date('2026-10-27T10:05:00.000Z'))
    } finally {
      await transport.close?.()
    }
  })
})

function stepAt(runId: string, stepId: string, startedAt: Date) {
  return {
    runId,
    stepId,
    status: 'done',
    model: 'm1',
    tokens: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    cost: 0.001,
    toolCalls: 0,
    unpricedCalls: 0,
    byModel: null,
    startedAt,
    finishedAt: new Date(startedAt.getTime() + 1000),
    sessionId: null,
    run: {
      workflowId: 'u.reported',
      rootId: runId,
      purpose: 'build',
      iuKey: 'personal' as const,
      traceparent: null,
      traceId: null,
      fingerprint: null,
      friction: null,
      status: 'done',
      errorKind: null,
      wallMs: 1000,
    },
  }
}

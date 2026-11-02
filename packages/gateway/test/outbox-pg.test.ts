import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Pool } from 'pg'
import { Ledger } from '../src/ledger.ts'
import { Outbox, pgUsageSink } from '../src/outbox.ts'
import {
  API_SECRET,
  DOOR_TOKEN,
  fakeUpstream,
  harness,
  jsonBody,
  listening,
  pool,
  processEnv,
  silentLogger,
  spawnGateway,
  tempDir,
  pickRow,
  recordRow,
} from './support.ts'

// The outbox guarantees against the real `usage` schema: a scratch database with usage-tracker's migrations applied as
// they are (the pattern of packages/middleware/test/usage-pg.test.ts). Either input absent skips, with the reason in the name.

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
if (skipReason) console.warn(`gateway postgres tests skipped: ${skipReason}`)

const describePg = skipReason ? describe.skip : describe
const suite = skipReason ? `gateway outbox postgres (skipped: ${skipReason})` : 'gateway outbox postgres'

const scratchName = `usage_test_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
const SCRATCH_NAME = /^usage_test_[0-9a-f]{12}$/

let admin: Pool
let scratch: Pool
let scratchUrl = ''

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
  await scratch.query(
    `insert into usage.prices (model_key, valid_from, input, output, source) values ('priced-model', '2026-01-01', 1, 2, 'seed-git')`,
  )
})

afterAll(async () => {
  await scratch?.end()
  // The admin role can drop anything on the shared server: only the name this file generated ever reaches DDL.
  if (admin && SCRATCH_NAME.test(scratchName)) await admin.query(`drop database if exists ${scratchName} with (force)`)
  await admin?.end()
})

const fresh = (prefix: string) => `${prefix}-${crypto.randomUUID()}`

function scene() {
  const dir = tempDir()
  const ledger = new Ledger(join(dir.path, 'ledger.sqlite'))
  const logger = silentLogger()
  const sink = pgUsageSink({ connectionString: scratchUrl, logger })
  const outbox = new Outbox({ ledger, sink, logger })
  return {
    ledger,
    logger,
    sink,
    outbox,
    async close() {
      await outbox.close()
      ledger.close()
      dir.remove()
    },
  }
}

const record = async (id: string) =>
  (await scratch.query('select * from usage.records where source = $1 and source_id = $2', ['gateway', id])).rows[0] as
    | Record<string, unknown>
    | undefined
const picksOf = async (id: string) =>
  (await scratch.query('select * from usage.gateway_picks where request_id = $1 order by ts', [id])).rows as Record<
    string,
    unknown
  >[]

describePg(suite, () => {
  test('a credit row lands priced, with its account and billing, and its picks', async () => {
    const s = scene()
    const id = fresh('credit')
    s.ledger.writePick(pickRow(id, 'iu'))
    s.ledger.writePick(pickRow(id, 'iu-api', { reason: 'drained-retry' }))
    s.ledger.writeRecord(recordRow(id, { cost_reported_usd: 0.25, run_id: 'run-1', raw: { status: 200 } }))
    await s.outbox.flush()
    expect(s.outbox.lastError()).toBeNull()
    expect(await record(id)).toMatchObject({
      billing: 'api_credit',
      account: 'iu',
      api_key: null,
      grain: 'message',
      lane: 'other',
      run_id: 'run-1',
      input_tokens: '10',
      cost_source: 'reported',
      raw: { status: 200 },
    })
    expect(Number((await record(id))?.cost_usd)).toBe(0.25)
    expect((await picksOf(id)).map((row) => row.picked)).toEqual(['iu', 'iu-api'])
    expect(s.ledger.stats().unsynced).toBe(0)
    await s.close()
  })

  test('the attribution columns land, and a re-flush updates them', async () => {
    const s = scene()
    const id = fresh('attributed')
    s.ledger.writeRecord(
      recordRow(id, { repo: 'agent-workflows', project_raw: 'agent-workflows', workspace: 'private' }),
    )
    const first = s.ledger.pending(1)
    await s.sink.write(first)
    expect(await record(id)).toMatchObject({
      repo: 'agent-workflows',
      project_raw: 'agent-workflows',
      workspace: 'private',
    })
    const row = first.records[0]?.row
    if (row === undefined) throw new Error('no row')
    await s.sink.write({ records: [{ id: 1, row: { ...row, repo: null, workspace: 'work' } }], picks: [] })
    expect(await record(id)).toMatchObject({ repo: null, project_raw: 'agent-workflows', workspace: 'work' })
    await s.close()
  })

  test('a row an old ledger still owes flushes unattributed', async () => {
    const s = scene()
    const id = fresh('old-row')
    const { repo: _repo, project_raw: _project, workspace: _workspace, ...oldRow } = recordRow(id)
    const dir = tempDir()
    const path = join(dir.path, 'old.sqlite')
    const db = new Database(path, { create: true })
    db.run(`create table records (
      id integer primary key, request_id text not null unique, pool text not null, usd real,
      written_at_ms integer not null, row_json text not null, synced_at_ms integer, quarantine_error text
    )`)
    db.query(`insert into records (request_id, pool, usd, written_at_ms, row_json) values (?, 'iu', 1, 1, ?)`).run(
      id,
      JSON.stringify(oldRow),
    )
    db.close()
    const ledger = new Ledger(path)
    const outbox = new Outbox({ ledger, sink: s.sink, logger: s.logger })
    await outbox.flush()
    expect(outbox.lastError()).toBeNull()
    expect(ledger.stats()).toMatchObject({ unsynced: 0, quarantined: 0 })
    expect(s.logger.lines.filter((line) => line.level !== 'info')).toEqual([])
    expect(await record(id)).toMatchObject({ repo: null, project_raw: null, workspace: null })
    ledger.close()
    dir.remove()
    await s.close()
  })

  test('an IU row without a reported cost is priced by the database in the same statement', async () => {
    const s = scene()
    const id = fresh('priced')
    s.ledger.writeRecord(
      recordRow(id, {
        billing: 'api_key',
        account: null,
        api_key: 'personal',
        cost_reported_usd: null,
        input_tokens: 1_000_000,
        output_tokens: 500_000,
        lane_detail: { pool: 'iu-api' },
      }),
    )
    await s.outbox.flush()
    const row = await record(id)
    expect(row).toMatchObject({ billing: 'api_key', api_key: 'personal', cost_source: 'prices' })
    expect(Number(row?.cost_usd)).toBe(2)
    await s.close()
  })

  test('at-least-once: a crash between commit and mark re-flushes, and nothing duplicates', async () => {
    const s = scene()
    const id = fresh('reflush')
    s.ledger.writePick(pickRow(id))
    s.ledger.writeRecord(recordRow(id))
    const batch = s.ledger.pending(10)
    await s.sink.write(batch)
    expect(s.ledger.stats().unsynced).toBe(2)
    await s.outbox.flush()
    await s.sink.write(batch)
    expect(s.ledger.stats().unsynced).toBe(0)
    const { rows } = await scratch.query('select count(*)::int as n from usage.records where source_id = $1', [id])
    expect(rows[0]).toEqual({ n: 1 })
    expect(await picksOf(id)).toHaveLength(1)
    await s.close()
  })

  test('a re-flush with a changed row updates it, without a second row', async () => {
    const s = scene()
    const id = fresh('update')
    s.ledger.writeRecord(recordRow(id, { output_tokens: 1 }))
    const first = s.ledger.pending(1)
    await s.sink.write(first)
    const row = first.records[0]?.row
    if (row === undefined) throw new Error('no row')
    await s.sink.write({ records: [{ id: 1, row: { ...row, output_tokens: 7 } }], picks: [] })
    expect(await record(id)).toMatchObject({ output_tokens: '7' })
    await s.close()
  })

  test('a CHECK violation quarantines that row only; the batch around it lands; it is never retried', async () => {
    const s = scene()
    const [before, bad, after, badPick] = [fresh('before'), fresh('bad'), fresh('after'), fresh('bad-pick')]
    s.ledger.writeRecord(recordRow(before))
    s.ledger.writeRecord(recordRow(bad, { lane: 'not-a-lane' as 'other' }))
    s.ledger.writeRecord(recordRow(after))
    s.ledger.writePick(pickRow(badPick, 'x', { ts: 'not a time' }))
    s.ledger.writePick(pickRow(after))
    await s.outbox.flush()
    expect(s.outbox.lastError()).toBeNull()
    expect(await record(before)).toBeDefined()
    expect(await record(after)).toBeDefined()
    expect(await picksOf(after)).toHaveLength(1)
    expect(await record(bad)).toBeUndefined()
    expect(s.ledger.stats()).toMatchObject({ unsynced: 0, quarantined: 2 })
    const quarantined = s.logger.lines.filter((line) => line.message.includes('quarantined'))
    expect(quarantined).toHaveLength(2)
    expect(JSON.stringify(quarantined[0]?.fields)).toContain('23514')
    await s.outbox.flush()
    expect(s.logger.lines.filter((line) => line.message.includes('quarantined'))).toHaveLength(2)
    await s.close()
  })

  test('a requeued row that still fails is quarantined again, once, and a fixed one lands', async () => {
    const s = scene()
    const [fixed, broken] = [fresh('fixed'), fresh('broken')]
    s.ledger.writeRecord(recordRow(fixed, { lane: 'later-allowed' as 'other' }))
    s.ledger.writeRecord(recordRow(broken, { lane: 'never-allowed' as 'other' }))
    await s.outbox.flush()
    expect(s.ledger.stats()).toMatchObject({ quarantined: 2 })
    // A migration widens the check.
    await scratch.query(
      `alter table usage.records drop constraint records_lane_check, add constraint records_lane_check
       check (lane in ('interactive', 'wave_mother', 'lead', 'worker', 'fan_worker', 'subagent', 'hermes', 'iris',
         'agw_workflow', 'other', 'later-allowed'))`,
    )
    expect(s.ledger.requeueQuarantined()).toBe(2)
    await s.outbox.flush()
    expect(await record(fixed)).toBeDefined()
    expect(s.ledger.stats()).toMatchObject({ unsynced: 0, quarantined: 1 })
    await s.outbox.flush()
    expect(s.logger.lines.filter((line) => line.message.includes('quarantined'))).toHaveLength(3)
    await s.close()
  })

  test('a credit row that breaks the api_credit guard and a type error are row refusals too', async () => {
    const s = scene()
    const [guard, type] = [fresh('guard'), fresh('type')]
    s.ledger.writeRecord(recordRow(guard, { account: null }))
    s.ledger.writeRecord(recordRow(type, { duration_ms: 9_999_999_999 }))
    await s.outbox.flush()
    expect(s.ledger.stats()).toMatchObject({ unsynced: 0, quarantined: 2 })
    await s.close()
  })

  test('a Postgres outage: rows accumulate, /health figures show the backlog, the flush resumes', async () => {
    const dir = tempDir()
    const ledger = new Ledger(join(dir.path, 'ledger.sqlite'))
    const logger = silentLogger()
    const down = new Outbox({
      ledger,
      sink: pgUsageSink({ connectionString: 'postgres://nobody:x@127.0.0.1:1/none', logger }),
      logger,
    })
    const id = fresh('outage')
    ledger.writeRecord(recordRow(id))
    await down.flush()
    ledger.writeRecord(recordRow(`${id}-2`))
    await down.flush()
    expect(down.lastError()).not.toBeNull()
    expect(ledger.stats().unsynced).toBe(2)
    expect(ledger.stats().oldestUnsyncedAt).not.toBeNull()
    await down.close().catch(() => {})
    const up = new Outbox({ ledger, sink: pgUsageSink({ connectionString: scratchUrl, logger }), logger })
    await up.flush()
    expect(up.lastError()).toBeNull()
    expect(ledger.stats().unsynced).toBe(0)
    expect(await record(id)).toBeDefined()
    await up.close()
    ledger.close()
    dir.remove()
  })

  test('a missing table is an outage, not a refusal: nothing is quarantined', async () => {
    const url = new URL(scratchUrl)
    const bad = `usage_test_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
    await admin.query(`create database ${bad}`)
    url.pathname = `/${bad}`
    const dir = tempDir()
    const ledger = new Ledger(join(dir.path, 'ledger.sqlite'))
    const logger = silentLogger()
    const outbox = new Outbox({ ledger, sink: pgUsageSink({ connectionString: url.toString(), logger }), logger })
    ledger.writeRecord(recordRow(fresh('no-table')))
    await outbox.flush()
    expect(outbox.lastError()).toContain('usage')
    expect(ledger.stats()).toMatchObject({ unsynced: 1, quarantined: 0 })
    await outbox.close()
    await admin.query(`drop database ${bad} with (force)`)
    ledger.close()
    dir.remove()
  })

  describe('through the gateway', () => {
    const usage = { model: 'priced-model', usage: { input_tokens: 1_000_000, output_tokens: 500_000 } }
    const until = async (check: () => Promise<boolean>): Promise<void> => {
      for (let i = 0; i < 500; i++) {
        if (await check()) return
        await Bun.sleep(10)
      }
      throw new Error('timed out')
    }

    test('a served request lands soon after the write, priced, with its pick', async () => {
      const anthropic = fakeUpstream(() => Response.json(usage))
      const iu = fakeUpstream()
      const gw = harness({
        anthropic,
        iu,
        registry: [pool('iu')],
        usage: { connectionString: scratchUrl, debounceMs: 5 },
      })
      const response = await gw.call('/anthropic/v1/messages', jsonBody({ model: 'priced-model', messages: [] }))
      await response.text()
      const id = response.headers.get('x-agw-request-id') ?? ''
      await until(async () => (await record(id)) !== undefined && (await picksOf(id)).length === 1)
      // No Claude rate for the model: Postgres prices the row, and the estimate is only the meter's.
      const row = await record(id)
      expect(row).toMatchObject({ billing: 'api_credit', account: 'iu', cost_source: 'prices' })
      expect(Number(row?.cost_usd)).toBe(2)
      expect(row?.lane_detail).toMatchObject({ costEstimated: true })
      expect(row).toMatchObject({ repo: null, project_raw: null, workspace: null })
      const health = (await (await fetch(`${gw.url}/health`)).json()) as { ledger: unknown }
      expect(health.ledger).toMatchObject({ flush: 'on', unsynced: 0, quarantined: 0 })
      await gw.close()
      anthropic.stop()
      iu.stop()
    })

    test('the attribution headers land in usage.records; a caller-written request lands nothing', async () => {
      const anthropic = fakeUpstream()
      const iu = fakeUpstream(() => Response.json(usage))
      const gw = harness({ anthropic, iu, usage: { connectionString: scratchUrl, debounceMs: 5 } })
      const init = jsonBody({ model: 'priced-model', messages: [] })
      const headers = { ...init.headers, 'x-agw-project': 'agent-workflows', 'x-agw-workspace': 'private' }
      const skipped = await gw.call('/openai/v1/images/generations', {
        ...init,
        token: API_SECRET,
        headers: { ...headers, 'x-agw-usage': 'caller' },
      })
      await skipped.text()
      const served = await gw.call('/openai/v1/chat/completions', { ...init, headers })
      await served.text()
      const id = served.headers.get('x-agw-request-id') ?? ''
      await until(async () => (await record(id)) !== undefined)
      expect(await record(id)).toMatchObject({
        repo: 'agent-workflows',
        project_raw: 'agent-workflows',
        workspace: 'private',
        lane: 'other',
        lane_detail: { raw: 'oc' },
      })
      expect(await record(skipped.headers.get('x-agw-request-id') ?? '')).toBeUndefined()
      await gw.close()
      anthropic.stop()
      iu.stop()
    })

    test('a forced request lands its row and its pick with reason forced', async () => {
      const anthropic = fakeUpstream()
      const iu = fakeUpstream(() => Response.json(usage))
      const gw = harness({
        anthropic,
        iu,
        registry: [pool('iu')],
        usage: { connectionString: scratchUrl, debounceMs: 5 },
      })
      const init = jsonBody({ model: 'priced-model', messages: [] })
      const response = await gw.call('/anthropic/v1/messages', {
        ...init,
        headers: { ...init.headers, 'x-agw-upstream': 'iu' },
      })
      await response.text()
      const id = response.headers.get('x-agw-request-id') ?? ''
      await until(async () => (await record(id)) !== undefined && (await picksOf(id)).length === 1)
      expect(await picksOf(id)).toMatchObject([{ picked: 'iu-api', reason: 'forced' }])
      expect(await record(id)).toMatchObject({ billing: 'api_key', lane_detail: { fallback: null } })
      expect(gw.ledger.stats()).toMatchObject({ quarantined: 0 })
      await gw.close()
      anthropic.stop()
      iu.stop()
    })

    test('shutdown flushes what the debounce still holds', async () => {
      const anthropic = fakeUpstream()
      const iu = fakeUpstream(() => Response.json(usage))
      const gw = harness({ anthropic, iu, usage: { connectionString: scratchUrl, debounceMs: 60_000 } })
      await Bun.sleep(50)
      const response = await gw.call('/anthropic/v1/messages', jsonBody({ model: 'priced-model', messages: [] }))
      await response.text()
      const id = response.headers.get('x-agw-request-id') ?? ''
      expect(await record(id)).toBeUndefined()
      await gw.close()
      const row = await record(id)
      expect(row).toMatchObject({ billing: 'api_key', api_key: 'personal', cost_source: 'prices' })
      expect(Number(row?.cost_usd)).toBe(2)
      anthropic.stop()
      iu.stop()
    })

    test('a process killed before its flush delivers on the next boot', async () => {
      const dir = tempDir()
      const iu = fakeUpstream(() => Response.json(usage))
      const env = processEnv(dir.path, `${iu.url}/anthropic`)
      const first = spawnGateway(env)
      const port = await listening(first)
      const init = jsonBody({ model: 'priced-model', messages: [] })
      const response = await fetch(`http://127.0.0.1:${port}/anthropic/v1/messages`, {
        ...init,
        headers: { ...init.headers, authorization: `Bearer ${DOOR_TOKEN}` },
      })
      await response.text()
      const id = response.headers.get('x-agw-request-id') ?? ''
      first.kill('SIGKILL')
      await first.exited
      expect(await record(id)).toBeUndefined()

      const second = spawnGateway({ ...env, USAGE_PG_URL: scratchUrl, AGW_API_SECRET: API_SECRET })
      await listening(second)
      await until(async () => (await record(id)) !== undefined)
      second.kill('SIGTERM')
      expect(await second.exited).toBe(0)
      iu.stop()
      dir.remove()
    })
  })
})

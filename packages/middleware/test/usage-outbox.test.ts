import { afterAll, describe, expect, test } from 'bun:test'
import { defineWorkflow } from '@agent-workflows/runtime'
import { FakeAgentHost } from '@agent-workflows/runtime/testing'
import { z } from 'zod'
import { JournalDb, UsageOutbox, UsageWriteError, usageFromOpenCodeMessages } from '../src/index.ts'
import { toolTurns } from './fixtures/opencode-messages.ts'
import {
  captureLogger,
  FakeUsage,
  freshSchema,
  inspector,
  PG_URL,
  testPlatform,
  testRuntime,
  until,
} from './support.ts'

const db = freshSchema('mwo')
const sql = inspector(db.schema)

afterAll(async () => {
  await sql.close()
  await db.drop()
})

const n = z.object({ n: z.number() })

const child = defineWorkflow({
  id: 'o.child',
  version: 'v1',
  input: n,
  output: n,
  async run(ctx, { n }) {
    await ctx.step('work', ({ addUsage }) => {
      addUsage({ model: 'm1', tokens: { input: 10, output: 2, cacheRead: 0, reasoning: 0 }, cost: 0.001 })
      return n
    })
    return { n }
  },
})

const busy = defineWorkflow({
  id: 'o.busy',
  version: 'v1',
  input: n,
  output: n,
  async run(ctx, { n }) {
    await ctx.step('prep', () => n) // no usage: marked, never posted
    await ctx.step('two-models', async ({ addUsage }) => {
      await Bun.sleep(Math.random() * 30)
      addUsage({ model: 'm1', tokens: { input: 100, output: 30, cacheRead: 20, reasoning: 10 }, cost: 0.01 })
      addUsage({ model: 'm2', tokens: { input: 50, output: 5, cacheRead: 0, reasoning: 0 }, cost: null })
      return 1
    })
    await ctx.agent('ask', { agent: 'brain', prompt: `q${n}` })
    await ctx.workflow('kids', child, [{ n: 1 }, { n: 2 }])
    return { n }
  },
})

const host = new FakeAgentHost(async (s) => {
  await s.sleep(Math.random() * 30)
  return { output: { ok: true }, usage: usageFromOpenCodeMessages(toolTurns, { model: 'deepseek-v4.1-flash' }) }
})

/** Rows each run must produce: 2 (two-models) + 1 (ask) on the run, 1 per child. */
function expectedSourceIds(runIds: string[]): string[] {
  return runIds
    .flatMap((id) => [
      `${id}:two-models:m1`,
      `${id}:two-models:m2`,
      `${id}:ask:deepseek-v4.1-flash`,
      `${id}/kids/0:work:m1`,
      `${id}/kids/1:work:m1`,
    ])
    .sort()
}

async function finishedChildren(platform: ReturnType<typeof testPlatform>, count: number): Promise<string[]> {
  const rt = testRuntime({ schema: db.schema, workflows: [child], middleware: platform.middleware })
  await rt.open()
  try {
    const ids = await Promise.all(
      Array.from({ length: count }, async (_, i) => (await rt.start(child, { n: i }, { purpose: 'build' })).runId),
    )
    await Promise.all(ids.map((id) => rt.wait(id)))
    await until(async () => (await Promise.all(ids.map((id) => sql.run(id)))).every((r) => r?.post_hooks_at), 'runPost')
    return ids
  } finally {
    await rt.close()
  }
}

describe('usage outbox', () => {
  test('24 concurrent runs, two flushers racing, a usage database outage: every row once, none lost', async () => {
    const usage = new FakeUsage()
    const platform = testPlatform(db.schema)
    const rt = testRuntime({
      schema: db.schema,
      workflows: [busy, child],
      host,
      middleware: platform.middleware,
      maxConcurrentRuns: 12,
    })
    // Two "processes": their own pools and outboxes against the same journal, small batches to force many rounds.
    const logger = captureLogger()
    const dbs = [0, 1].map(() => new JournalDb({ connectionString: PG_URL, schema: db.schema }, logger))
    const outboxes = dbs.map(
      (journal) =>
        new UsageOutbox({
          db: journal,
          transport: usage,
          logger,
          machine: 'test-machine',
          batchSize: 7,
          backoff: { baseMs: 1, maxMs: 20 },
        }),
    )
    await rt.open()
    try {
      usage.down = true
      const runIds = await Promise.all(
        Array.from({ length: 24 }, async (_, i) => (await rt.start(busy, { n: i }, { purpose: 'build' })).runId),
      )
      // Flushers tick while runs finish and the database is down: every post fails, no step may be marked.
      let ticking = true
      const tick = async (outbox: UsageOutbox) => {
        while (ticking) {
          await outbox.flush()
          await Bun.sleep(3)
        }
      }
      const tickers = outboxes.map(tick)
      const results = await Promise.all(runIds.map((id) => rt.wait(id)))
      expect(results.every((r) => r.status === 'done')).toBe(true)
      await until(async () => {
        const rows = await Promise.all(runIds.map((id) => sql.run(id)))
        return rows.every((r) => r?.post_hooks_at)
      }, 'every runPost')
      await Bun.sleep(50)
      expect(usage.failedPosts).toBeGreaterThan(0)
      expect(usage.stored.size).toBe(0)
      const { rows: marked } = await sql.pool.query(
        `select count(*)::int as n from "${db.schema}".steps
         where argo_synced_at is not null and (tokens_input > 0 or cost is not null)`,
      )
      expect(marked[0]?.n).toBe(0)

      // the database is back: the racing flushers drain the outbox.
      usage.down = false
      const expected = expectedSourceIds(runIds)
      await until(() => usage.stored.size >= expected.length, 'every row in the usage database', 15_000)
      await until(async () => {
        const { rows } = await sql.pool.query(
          `select count(*)::int as n from "${db.schema}".steps
           where argo_synced_at is null and (tokens_input > 0 or cost is not null)`,
        )
        return rows[0]?.n === 0
      }, 'every step with usage marked')
      ticking = false
      await Promise.all(tickers)

      expect([...usage.accepted.keys()].sort()).toEqual(expected)
      expect([...usage.accepted.values()].every((count) => count === 1)).toBe(true)
      const m1 = [...usage.stored.values()].find((r) => r.source_id === `${runIds[0]}:two-models:m1`)
      expect(m1).toMatchObject({
        input_tokens: 80,
        output_tokens: 20,
        cache_read_tokens: 20,
        reasoning_tokens: 10,
        cost_reported_usd: 0.01,
        lane_detail: { workflow: 'o.busy', step: 'two-models' },
        raw: { purpose: 'build', unpricedCalls: 1 },
      })
      expect(typeof (m1?.raw as { fingerprint?: unknown } | undefined)?.fingerprint).toBe('string')
      const m2 = [...usage.stored.values()].find((r) => r.source_id === `${runIds[0]}:two-models:m2`)
      expect(m2).toMatchObject({ cost_reported_usd: null })
      expect(logger.lines.some((l) => l.message.startsWith('usage outbox: flush failed'))).toBe(true)

      // Nothing left: a further flush posts nothing.
      const before = usage.posts
      expect(await outboxes[0]?.flush()).toMatchObject({ posted: 0, marked: 0, error: null })
      expect(usage.posts).toBe(before)
    } finally {
      await rt.close()
      await platform.close()
      await Promise.all(dbs.map((d) => d.close()))
    }
  })

  test('backoff: a failed flush skips until the delay passed', async () => {
    let now = 1_000
    const usage = new FakeUsage()
    const logger = captureLogger()
    const journal = new JournalDb({ connectionString: PG_URL, schema: db.schema }, logger)
    const outbox = new UsageOutbox({
      db: journal,
      transport: usage,
      logger,
      machine: 'm',
      backoff: { baseMs: 100, maxMs: 150 },
      now: () => now,
    })
    const platform = testPlatform(db.schema)
    const rt = testRuntime({ schema: db.schema, workflows: [child], middleware: platform.middleware })
    await rt.open()
    try {
      const { runId } = await rt.start(child, { n: 9 }, { purpose: 'build' })
      await rt.wait(runId)
      await until(async () => (await sql.run(runId))?.post_hooks_at, 'runPost')
      usage.down = true
      expect((await outbox.flush()).error).toMatch(/ECONNREFUSED/)
      expect(await outbox.flush()).toMatchObject({ skipped: 'backoff' })
      now += 100
      expect((await outbox.flush()).error).toMatch(/ECONNREFUSED/)
      now += 100
      expect(await outbox.flush()).toMatchObject({ skipped: 'backoff' })
      now += 50
      usage.down = false
      expect(await outbox.flush()).toMatchObject({ skipped: null, error: null })
      expect(usage.accepted.get(`${runId}:work:m1`)).toBe(1)
    } finally {
      await rt.close()
      await platform.close()
      await journal.close()
    }
  })

  test('a run whose runPost is not delivered yet is not posted: its record must reach the usage database', async () => {
    const usage = new FakeUsage()
    const logger = captureLogger()
    const journal = new JournalDb({ connectionString: PG_URL, schema: db.schema }, logger)
    const outbox = new UsageOutbox({ db: journal, transport: usage, logger, machine: 'm' })
    const platform = testPlatform(db.schema)
    try {
      // The runtime is closed first: a live one would re-deliver the runPost the test takes back.
      const [runId = ''] = await finishedChildren(platform, 1)
      await sql.pool.query(`update "${db.schema}".runs set post_hooks_at = null where id = $1`, [runId])
      await outbox.flush()
      expect(usage.accepted.has(`${runId}:work:m1`)).toBe(false)
      await sql.pool.query(`update "${db.schema}".runs set post_hooks_at = now() where id = $1`, [runId])
      await outbox.flush()
      const row = [...usage.stored.values()].find((r) => r.source_id === `${runId}:work:m1`)
      expect((row?.raw as { runWallMs?: unknown } | undefined)?.runWallMs).toEqual(expect.any(Number))
    } finally {
      await platform.close()
      await journal.close()
    }
  })

  test('poison rows are quarantined, the rest keep flowing', async () => {
    const usage = new FakeUsage()
    const logger = captureLogger()
    const journal = new JournalDb({ connectionString: PG_URL, schema: db.schema }, logger)
    const outbox = new UsageOutbox({ db: journal, transport: usage, logger, machine: 'm', batchSize: 50 })
    const platform = testPlatform(db.schema)
    const rt = testRuntime({ schema: db.schema, workflows: [child], middleware: platform.middleware })
    await rt.open()
    try {
      const ids = await Promise.all(
        Array.from({ length: 8 }, async (_, i) => (await rt.start(child, { n: i }, { purpose: 'build' })).runId),
      )
      await Promise.all(ids.map((id) => rt.wait(id)))
      await until(
        async () => (await Promise.all(ids.map((id) => sql.run(id)))).every((r) => r?.post_hooks_at),
        'runPost',
      )
      const [unbuildable, refused, ...good] = ids as [string, string, ...string[]]
      // A row that cannot be built (a run without a purpose) and one the database refuses (a constraint violation).
      await sql.pool.query(`update "${db.schema}".runs set purpose = ' ' where id = $1`, [unbuildable])
      usage.refuse = (r) => r.source_id.startsWith(`${refused}:`)
      const result = await outbox.flush()
      expect(result).toMatchObject({ quarantined: 2, error: null, skipped: null })
      for (const id of good) expect(usage.accepted.get(`${id}:work:m1`)).toBe(1)
      const bad = await Promise.all([unbuildable, refused].map((id) => sql.step(id, 'work')))
      expect(bad.map((s) => [s?.argo_synced_at, s?.argo_claim])).toEqual([
        [null, null],
        [null, null],
      ])
      expect(String(bad[0]?.argo_error)).toContain('purpose')
      expect(String(bad[1]?.argo_error)).toContain('23514')
      expect(logger.lines.filter((l) => l.message.startsWith('usage outbox: step quarantined'))).toHaveLength(2)
      // Quarantined steps are not claimed again, until requeued once the cause is fixed.
      expect(await outbox.flush()).toMatchObject({ posted: 0, quarantined: 0 })
      usage.refuse = () => false
      expect(await outbox.requeue({ runId: refused })).toBe(1)
      expect(await outbox.flush()).toMatchObject({ posted: 1, quarantined: 0 })
      expect(usage.accepted.get(`${refused}:work:m1`)).toBe(1)
      expect((await sql.step(refused, 'work'))?.argo_error).toBeNull()
      expect((await sql.step(unbuildable, 'work'))?.argo_error).not.toBeNull()
    } finally {
      await rt.close()
      await platform.close()
      await journal.close()
    }
  })

  test('a hanging usage database holds no connection and never blocks a run record (24 concurrent runs)', async () => {
    const usage = new FakeUsage()
    usage.hang = true
    const platform = testPlatform(db.schema, {
      usage: { transport: usage, machine: 'm', postTimeoutMs: 100, claimTtlMs: 1000, backoff: { baseMs: 1, maxMs: 5 } },
    })
    const outbox = platform.outbox
    if (!outbox) throw new Error('no outbox')
    const rt = testRuntime({ schema: db.schema, workflows: [busy, child], host, middleware: platform.middleware })
    await rt.open()
    let ticking = true
    const ticker = (async () => {
      while (ticking) {
        await outbox.flush()
        await Bun.sleep(5)
      }
    })()
    try {
      const ids = await Promise.all(
        Array.from({ length: 24 }, async (_, i) => (await rt.start(busy, { n: i }, { purpose: 'build' })).runId),
      )
      await Promise.all(ids.map((id) => rt.wait(id)))
      const rows = await until(
        async () => {
          const all = await Promise.all(ids.map((id) => sql.run(id)))
          return all.every((r) => r?.post_hooks_at) ? all : null
        },
        'every record written while the database hangs',
        15_000,
      )
      expect(rows.every((r) => r?.wall_ms !== null && r?.unpriced_calls === 1)).toBe(true)
      await until(() => usage.inflight > 2, 'posts hanging')
      // Posts hang outside any transaction: no outbox connection is checked out while they wait.
      const { rows: open } = await sql.pool.query(
        `select count(*)::int as n from pg_stat_activity
         where application_name = $1 and state like 'idle in transaction%'`,
        [`agw-middleware:${db.schema}`],
      )
      expect(open[0]?.n).toBe(0)
      usage.hang = false
      const expected = expectedSourceIds(ids)
      await until(() => expected.every((id) => usage.accepted.has(id)), 'every row once the database answers', 15_000)
      expect(expected.every((id) => usage.accepted.get(id) === 1)).toBe(true)
    } finally {
      ticking = false
      await ticker
      await rt.close()
      await platform.close()
    }
  })

  test('machine id: AGW_MACHINE, else the host name with a warning', async () => {
    const logger = captureLogger()
    const journal = new JournalDb({ connectionString: PG_URL, schema: db.schema }, logger)
    const before = process.env.AGW_MACHINE
    try {
      delete process.env.AGW_MACHINE
      new UsageOutbox({ db: journal, transport: new FakeUsage(), logger })
      expect(logger.lines.map((l) => l.message)).toEqual([
        'usage outbox: AGW_MACHINE unset; using the host name as the machine id',
      ])
      process.env.AGW_MACHINE = 'mini'
      new UsageOutbox({ db: journal, transport: new FakeUsage(), logger })
      expect(logger.lines).toHaveLength(1)
    } finally {
      if (before === undefined) delete process.env.AGW_MACHINE
      else process.env.AGW_MACHINE = before
      await journal.close()
    }
  })

  test('an authentication failure is transient: nothing quarantined, claim released, logged as an error, posted once fixed', async () => {
    const usage = new FakeUsage()
    const logger = captureLogger()
    const journal = new JournalDb({ connectionString: PG_URL, schema: db.schema }, logger)
    const outbox = new UsageOutbox({
      db: journal,
      transport: usage,
      logger,
      machine: 'm',
      backoff: { baseMs: 1, maxMs: 1 },
    })
    const platform = testPlatform(db.schema)
    try {
      const ids = await finishedChildren(platform, 3)
      usage.failWith = new UsageWriteError('usage write: 28P01 password authentication failed', false, '28P01')
      expect(await outbox.flush()).toMatchObject({ quarantined: 0, error: expect.stringContaining('28P01') })
      const steps = await Promise.all(ids.map((id) => sql.step(id, 'work')))
      expect(steps.every((s) => s?.argo_error === null && s?.argo_claim === null && s?.argo_synced_at === null)).toBe(
        true,
      )
      expect(logger.lines.find((l) => l.message.startsWith('usage outbox: flush failed'))?.level).toBe('error')
      usage.failWith = null
      await Bun.sleep(5)
      await outbox.flush()
      for (const id of ids) expect(usage.accepted.get(`${id}:work:m1`)).toBe(1)
    } finally {
      await platform.close()
      await journal.close()
    }
  })

  test('the claim is renewed before every chunk; a lost claim is warned at mark', async () => {
    const usage = new FakeUsage()
    const logger = captureLogger()
    const journal = new JournalDb({ connectionString: PG_URL, schema: db.schema }, logger)
    const outbox = new UsageOutbox({
      db: journal,
      transport: usage,
      logger,
      machine: 'm',
      chunkSize: 2,
      claimTtlMs: 60_000,
      postTimeoutMs: 1000,
    })
    const platform = testPlatform(db.schema)
    try {
      const ids = await finishedChildren(platform, 5)
      const until_: number[] = []
      usage.onPost = async () => {
        const { rows } = await sql.pool.query(
          `select max(argo_claimed_until) as t from "${db.schema}".steps where argo_claim is not null`,
        )
        until_.push(new Date(rows[0]?.t).getTime())
        await Bun.sleep(20)
        if (until_.length === 2) {
          // Another flusher took one step after an expiry: its claim token is gone.
          await sql.pool.query(`update "${db.schema}".steps set argo_claim = 'other' where run_id = $1`, [ids[0]])
        }
      }
      const result = await outbox.flush()
      expect(until_).toHaveLength(3) // 5 rows in chunks of 2
      expect(until_[1]).toBeGreaterThan(until_[0] ?? 0)
      expect(until_[2]).toBeGreaterThan(until_[1] ?? 0)
      expect(result).toMatchObject({ posted: 5, marked: 4 })
      expect(logger.lines.some((l) => l.message.startsWith('usage outbox: claim lost before mark'))).toBe(true)
    } finally {
      await platform.close()
      await journal.close()
    }
  })

  test('close() waits for the flush in flight before the pool closes', async () => {
    const usage = new FakeUsage()
    const platform = testPlatform(db.schema, { usage: { transport: usage, machine: 'm' } })
    const outbox = platform.outbox
    if (!outbox) throw new Error('no outbox')
    const ids = await finishedChildren(platform, 2)
    let release: () => void = () => {}
    usage.onPost = () => new Promise<void>((resolve) => (release = resolve))
    const flushing = outbox.flush()
    await until(() => usage.posts > 0, 'post in flight')
    let closed = false
    const closing = platform.close().then(() => {
      closed = true
    })
    await Bun.sleep(50)
    expect(closed).toBe(false)
    release()
    expect(await flushing).toMatchObject({ posted: 2, marked: 2, error: null })
    await closing
    expect(await outbox.flush()).toMatchObject({ error: 'closed' })
    for (const id of ids) expect((await sql.step(id, 'work'))?.argo_synced_at).not.toBeNull()
  })
})

import { afterAll, describe, expect, test } from 'bun:test'
import { defineWorkflow } from '@agent-workflows/runtime'
import { FakeAgentHost } from '@agent-workflows/runtime/testing'
import { z } from 'zod'
import { ArgoOutbox, JournalDb, usageFromOpenCodeMessages } from '../src/index.ts'
import { toolTurns } from './fixtures/opencode-messages.ts'
import { captureLogger, FakeArgo, freshSchema, inspector, PG_URL, testPlatform, testRuntime, until } from './support.ts'

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

describe('argo outbox', () => {
  test('24 concurrent runs, two flushers racing, an Argo outage: every row once, none lost', async () => {
    const argo = new FakeArgo()
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
        new ArgoOutbox({
          db: journal,
          transport: argo,
          logger,
          machine: 'test-machine',
          batchSize: 7,
          backoff: { baseMs: 1, maxMs: 20 },
        }),
    )
    await rt.open()
    try {
      argo.down = true
      const runIds = await Promise.all(
        Array.from({ length: 24 }, async (_, i) => (await rt.start(busy, { n: i }, { purpose: 'build' })).runId),
      )
      // Flushers tick while runs finish and Argo is down: every post fails, no step with usage may be marked
      // (steps without usage are marked without a post).
      let ticking = true
      const tick = async (outbox: ArgoOutbox) => {
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
      expect(argo.failedPosts).toBeGreaterThan(0)
      expect(argo.stored.size).toBe(0)
      const { rows: marked } = await sql.pool.query(
        `select count(*)::int as n from "${db.schema}".steps
         where argo_synced_at is not null and (tokens_input > 0 or cost is not null)`,
      )
      expect(marked[0]?.n).toBe(0)

      // Argo is back: the racing flushers drain the outbox.
      argo.down = false
      const expected = expectedSourceIds(runIds)
      await until(() => argo.stored.size >= expected.length, 'every row in argo', 15_000)
      await until(async () => {
        const { rows } = await sql.pool.query(
          `select count(*)::int as n from "${db.schema}".steps where argo_synced_at is null`,
        )
        return rows[0]?.n === 0
      }, 'every step marked')
      ticking = false
      await Promise.all(tickers)

      expect([...argo.accepted.keys()].sort()).toEqual(expected)
      expect([...argo.accepted.values()].every((count) => count === 1)).toBe(true)
      const m1 = [...argo.stored.values()].find((r) => r.source_id === `${runIds[0]}:two-models:m1`)
      expect(m1).toMatchObject({
        input_tokens: 80,
        output_tokens: 20,
        cache_read_tokens: 20,
        reasoning_tokens: 10,
        cost_usd: 0.01,
        sub_tool: 'o.busy',
        raw: { purpose: 'build', unpricedCalls: 1 },
      })
      expect(typeof (m1?.raw as { fingerprint?: unknown } | undefined)?.fingerprint).toBe('string')
      const m2 = [...argo.stored.values()].find((r) => r.source_id === `${runIds[0]}:two-models:m2`)
      expect(m2).toMatchObject({ cost_usd: null, cost_source: 'none' })
      expect(logger.lines.some((l) => l.message.startsWith('argo outbox: flush failed'))).toBe(true)

      // Nothing left: a further flush posts nothing.
      const before = argo.posts
      expect(await outboxes[0]?.flush()).toMatchObject({ posted: 0, marked: 0, error: null })
      expect(argo.posts).toBe(before)
    } finally {
      await rt.close()
      await platform.close()
      await Promise.all(dbs.map((d) => d.close()))
    }
  })

  test('backoff: a failed flush skips until the delay passed', async () => {
    let now = 1_000
    const argo = new FakeArgo()
    const logger = captureLogger()
    const journal = new JournalDb({ connectionString: PG_URL, schema: db.schema }, logger)
    const outbox = new ArgoOutbox({
      db: journal,
      transport: argo,
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
      argo.down = true
      expect((await outbox.flush()).error).toMatch(/503/)
      expect(await outbox.flush()).toMatchObject({ skipped: 'backoff' })
      now += 100
      expect((await outbox.flush()).error).toMatch(/503/)
      now += 100
      expect(await outbox.flush()).toMatchObject({ skipped: 'backoff' })
      now += 50
      argo.down = false
      expect(await outbox.flush()).toMatchObject({ skipped: null, error: null })
      expect(argo.accepted.get(`${runId}:work:m1`)).toBe(1)
    } finally {
      await rt.close()
      await platform.close()
      await journal.close()
    }
  })
})

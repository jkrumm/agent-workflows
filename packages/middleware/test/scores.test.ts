import { afterAll, describe, expect, test } from 'bun:test'
import { defineWorkflow, type Json } from '@agent-workflows/runtime'
import { z } from 'zod'
import { ArgoOutbox, JournalDb, type RunRecord, recordMiddleware } from '../src/index.ts'
import { captureLogger, FakeArgo, freshSchema, inspector, PG_URL, testPlatform, testRuntime, until } from './support.ts'

const db = freshSchema('mwscore')
const sql = inspector(db.schema)

afterAll(async () => {
  await sql.close()
  await db.drop()
})

const scored = defineWorkflow({
  id: 's.scored',
  version: 'v1',
  input: z.object({ n: z.number() }),
  output: z.object({ n: z.number() }),
  scorer: {
    version: 'sc1',
    score: (_input, output) => ({ scores: { big: Number(((output as { n?: number }).n ?? 0) > 1) }, pass: true }),
  },
  async run(ctx, { n }) {
    await ctx.score('gate', { n })
    await ctx.step('work', ({ addUsage }) => {
      addUsage({ model: 'm1', tokens: { input: 10, output: 2, cacheRead: 0, reasoning: 0 }, cost: 0.001 })
      return n
    })
    return { n }
  },
})

function setup() {
  const logger = captureLogger()
  const platform = testPlatform(db.schema)
  const records: RunRecord[] = []
  const recordDb = new JournalDb({ connectionString: PG_URL, schema: db.schema }, logger)
  const record = recordMiddleware({ db: recordDb, logger, onRecord: (r) => records.push(r) })
  const rt = testRuntime({ schema: db.schema, workflows: [scored], middleware: [...platform.middleware, record] })
  const argo = new FakeArgo()
  const outboxDb = new JournalDb({ connectionString: PG_URL, schema: db.schema }, logger)
  const outbox = new ArgoOutbox({ db: outboxDb, transport: argo, logger, machine: 'test-machine' })
  return {
    rt,
    argo,
    outbox,
    records,
    async run(n: number) {
      const { runId } = await rt.start(scored, { n }, { purpose: 'eval' })
      await rt.wait(runId)
      await until(async () => (await sql.run(runId))?.post_hooks_at, 'runPost')
      return runId
    },
    rawScores: (runId: string) =>
      argo.stored.get(`agent-workflows|${runId}:work:m1|test-machine`)?.raw as { scores: Json } | undefined,
    async close() {
      await outbox.close()
      await rt.close()
      await platform.close()
      await recordDb.close()
      await outboxDb.close()
    },
  }
}

const gate = { scores: { big: 1 }, pass: true }

describe('scores in the run record and in Argo raw', () => {
  test('the gate verdicts ride the record and raw; a later score re-posts the rows with it', async () => {
    const t = setup()
    await t.rt.open()
    try {
      const runId = await t.run(2)
      expect(t.records.find((r) => r.runId === runId)?.scores).toEqual({ gates: { gate } })
      await t.outbox.flush()
      expect(t.rawScores(runId)?.scores).toEqual({ gates: { gate } })
      expect((await sql.step(runId, 'work'))?.argo_synced_at).toBeInstanceOf(Date)

      const final = await t.rt.scoreRun(runId, { source: 'regression', caseId: 'c1' })
      expect((await sql.step(runId, 'work'))?.argo_synced_at).toBeNull()
      expect((await sql.step(runId, 'gate'))?.argo_synced_at).toBeNull() // no usage: never in the outbox
      await t.outbox.flush()
      expect(t.rawScores(runId)?.scores).toEqual({ gates: { gate }, final })
      expect(t.argo.accepted.get(`${runId}:work:m1`)).toBe(2)
      // Top level never carries the scores.
      const row = t.argo.stored.get(`agent-workflows|${runId}:work:m1|test-machine`) as Record<string, unknown>
      expect(Object.keys(row)).not.toContain('scores')
    } finally {
      await t.close()
    }
  })

  test('a score landing while the rows are being posted drops the claim; the next flush posts the scored rows', async () => {
    const t = setup()
    await t.rt.open()
    try {
      const runId = await t.run(3)
      let scoredMidPost = false
      t.argo.onPost = async () => {
        if (scoredMidPost) return
        scoredMidPost = true
        await t.rt.scoreRun(runId, { source: 'drift', onlyUnscored: true })
      }
      const first = await t.outbox.flush()
      expect(first.marked).toBe(0) // the claim went with the score
      expect((t.rawScores(runId)?.scores as { final?: unknown } | undefined)?.final).toBeUndefined()
      await t.outbox.flush()
      expect((t.rawScores(runId)?.scores as { final?: { source: string } } | undefined)?.final?.source).toBe('drift')
      expect((await sql.step(runId, 'work'))?.argo_synced_at).toBeInstanceOf(Date)
    } finally {
      await t.close()
    }
  })
})

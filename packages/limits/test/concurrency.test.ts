import { afterAll, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineWorkflow } from '@agent-workflows/runtime'
import { z } from 'zod'
import { type LimitDecision, runawayCap, snapshotSpendSource, walletGate } from '../src/index.ts'
import { captureLogger, costUsage, freshSchema, inspector, PG_URL, seedRuns, testRuntime } from './support.ts'

const db = freshSchema('lim_conc')
const sql = inspector(db.schema)
const dir = await mkdtemp(join(tmpdir(), 'agw-wallet-conc-'))

afterAll(async () => {
  await sql.close()
  await db.drop()
  await rm(dir, { recursive: true, force: true })
})

const RUNS = 25
const STEPS = ['s1', 's2', 's3', 's4'] as const

const wf = defineWorkflow({
  id: 'conc.ocr',
  version: 'v1',
  input: z.object({ i: z.number() }),
  output: z.object({ i: z.number() }),
  async run(ctx, { i }) {
    const usage = costUsage(0.01, 500)
    await ctx.step('s1', (s) => {
      s.addUsage(usage)
      return 1
    })
    await ctx.step('s2', (s) => {
      s.addUsage(usage)
      return 2
    })
    await ctx.step('s3', (s) => {
      s.addUsage(usage)
      return 3
    })
    await ctx.step('s4', (s) => {
      s.addUsage(usage)
      return 4
    })
    return { i }
  },
})

test(`${RUNS} concurrent runs through both rules: one history query, none per step`, async () => {
  const snapshot = join(dir, 'latest.json')
  await writeFile(snapshot, JSON.stringify({ schema: 1, fetched_at: new Date().toISOString(), rolling30_usd: 50 }))
  const decisions: LimitDecision[] = []
  const onDecision = (d: LimitDecision) => decisions.push(d)
  const logger = captureLogger()
  const cap = runawayCap({ connectionString: PG_URL, schema: db.schema, logger, onDecision })
  const gate = walletGate({
    workflows: ['conc.ocr'],
    spend: snapshotSpendSource({ path: snapshot }),
    pausedUntil: null,
    thresholdUsd: 400,
    logger,
    onDecision,
  })
  const rt = testRuntime({ schema: db.schema, workflows: [wf], middleware: [gate, cap], maxConcurrentRuns: RUNS })
  await rt.open()
  try {
    await seedRuns(
      sql.pool,
      db.schema,
      'conc.ocr',
      Array.from({ length: 30 }, () => ({ cost: 0.04, tokens: 2000, wallMs: 500, steps: 4 })),
    )
    const ids = await Promise.all(
      Array.from({ length: RUNS }, async (_, i) => (await rt.start(wf, { i }, { purpose: 'test' })).runId),
    )
    const results = await Promise.all(ids.map((id) => rt.wait(id)))
    expect(results.map((r) => r.status)).toEqual(Array(RUNS).fill('done'))

    expect(cap.queries).toBe(1)
    expect((await cap.caps('conc.ocr')).basis.tree).toMatchObject({ kind: 'learned', sample: 30 })
    const wallet = decisions.filter((d) => d.rule === 'wallet-gate')
    const steps = decisions.filter((d) => d.rule === 'runaway-cap')
    expect(wallet).toHaveLength(RUNS)
    expect(wallet.every((d) => d.allowed)).toBe(true)
    expect(steps).toHaveLength(RUNS * STEPS.length)
    expect(steps.every((d) => d.allowed)).toBe(true)
    expect(logger.lines).toEqual([])
  } finally {
    await rt.close()
    await cap.close()
  }
}, 60_000)

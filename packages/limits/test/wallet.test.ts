import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineWorkflow } from '@agent-workflows/runtime'
import { z } from 'zod'
import {
  type DecisionSink,
  type LimitDecision,
  snapshotSpendSource,
  type WalletDecision,
  type WalletGateOptions,
  walletEnv,
  walletGate,
} from '../src/index.ts'
import { captureLogger, freshSchema, inspector, testRuntime, until } from './support.ts'

const db = freshSchema('lim_wallet')
const sql = inspector(db.schema)
const dir = await mkdtemp(join(tmpdir(), 'agw-wallet-'))

afterAll(async () => {
  await sql.close()
  await db.drop()
  await rm(dir, { recursive: true, force: true })
})

const empty = z.object({})
const optional = defineWorkflow({
  id: 'review.ocr',
  version: 'v1',
  input: empty,
  output: empty,
  async run(ctx) {
    await ctx.step('scan', () => 1)
    return {}
  },
})
const plain = defineWorkflow({
  id: 'review.plain',
  version: 'v1',
  input: empty,
  output: empty,
  async run(ctx) {
    await ctx.step('scan', () => 1)
    return {}
  },
})

async function snapshot(name: string, body: unknown, raw = false): Promise<string> {
  const path = join(dir, `${name}.json`)
  await writeFile(path, raw ? String(body) : JSON.stringify(body))
  return path
}

const fresh = (usd: number, hoursAgo = 1) => ({
  schema: 1,
  fetched_at: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(),
  rolling30_usd: usd,
})

function gate(path: string, options: Partial<WalletGateOptions> = {}) {
  const decisions: LimitDecision[] = []
  const logger = captureLogger()
  const middleware = walletGate({
    workflows: ['review.ocr'],
    spend: snapshotSpendSource({ path }),
    thresholdUsd: 400,
    pausedUntil: null,
    logger,
    onDecision: (d) => decisions.push(d),
    ...options,
  })
  return { middleware, decisions, logger }
}

async function runOnce(g: ReturnType<typeof gate>, workflow = optional) {
  const rt = testRuntime({ schema: db.schema, workflows: [optional, plain], middleware: [g.middleware] })
  await rt.open()
  // One runtime at a time on the schema: an open one would claim the next test's runs through its own gate.
  try {
    return await rt.wait((await rt.start(workflow, {}, { purpose: 'test' })).runId)
  } finally {
    await rt.close()
  }
}

describe('wallet gate', () => {
  test('refused at or above the threshold; other workflows pass untouched', async () => {
    const g = gate(await snapshot('over', fresh(450)))
    const result = await runOnce(g)
    expect(result.status).toBe('failed')
    expect(result.error).toEqual({
      kind: 'admission_refused',
      message: 'wallet gate: IU rolling 30d $450 >= $400 wallet gate',
    })
    expect(await sql.steps(result.runId)).toEqual([])
    expect(g.decisions).toEqual([
      expect.objectContaining({ allowed: false, rolling30Usd: 450, thresholdUsd: 400, resume: false }),
    ])
    expect(g.logger.lines[0]?.message).toBe('wallet gate refused admission')

    expect((await runOnce(gate(await snapshot('at', fresh(400))))).error?.kind).toBe('admission_refused')
    expect((await runOnce(g, plain)).status).toBe('done')
  })

  test('refused while a pause date is in the future', async () => {
    const until = new Date(Date.now() + 86_400_000)
    const g = gate(await snapshot('under-paused', fresh(10)), { pausedUntil: until })
    const result = await runOnce(g)
    expect(result.error?.kind).toBe('admission_refused')
    expect(result.error?.message).toContain(`paused until ${until.toISOString()}`)

    const past = gate(await snapshot('under-past', fresh(10)), { pausedUntil: new Date(Date.now() - 1000) })
    expect((await runOnce(past)).status).toBe('done')
  })

  test.each([
    ['missing', async () => join(dir, 'nope.json'), 'IU spend snapshot missing'],
    ['stale', () => snapshot('stale', fresh(10, 49)), 'IU spend snapshot is stale'],
    ['malformed', () => snapshot('malformed', '{"schema":1,', true), 'IU spend snapshot is not valid JSON'],
    ['wrong schema', () => snapshot('schema2', { ...fresh(10), schema: 2 }), 'unsupported schema'],
    ['no spend', () => snapshot('nospend', { ...fresh(10), rolling30_usd: 'x' }), 'no valid rolling30_usd'],
    ['negative spend', () => snapshot('negative', fresh(-5)), 'no valid rolling30_usd'],
    ['future', () => snapshot('future', fresh(10, -1)), 'fetched_at in the future'],
    ['no fetched_at', () => snapshot('nofetch', { schema: 1, rolling30_usd: 1 }), 'no valid fetched_at'],
  ])('fails closed on a %s snapshot', async (_name, path, reason) => {
    const result = await runOnce(gate(await path()))
    expect(result.error?.kind).toBe('admission_refused')
    expect(result.error?.message).toContain(reason)
  })

  test('a throwing spend source refuses too, also when read() throws synchronously', async () => {
    const rejecting = gate('', { spend: { read: () => Promise.reject(new Error('boom')) } })
    expect((await runOnce(rejecting)).error).toEqual({
      kind: 'admission_refused',
      message: 'wallet gate: IU spend source failed: boom',
    })
    const throwing = gate('', {
      spend: {
        read: () => {
          throw new Error('sync boom')
        },
      },
    })
    expect((await runOnce(throwing)).error).toEqual({
      kind: 'admission_refused',
      message: 'wallet gate: IU spend source failed: sync boom',
    })
  })

  test('allowed under the threshold, and threshold 0 skips the spend check', async () => {
    const g = gate(await snapshot('under', fresh(120.5)))
    expect((await runOnce(g)).status).toBe('done')
    expect(g.decisions[0]).toMatchObject({ allowed: true, reason: null, rolling30Usd: 120.5 })

    const off = gate(join(dir, 'nope.json'), { thresholdUsd: 0 })
    expect((await runOnce(off)).status).toBe('done')
  })

  test('a resumed run is admitted even when the spend crossed the threshold meanwhile', async () => {
    let block = true
    const longOcr = defineWorkflow({
      id: 'review.ocr',
      version: 'v1',
      input: empty,
      output: empty,
      async run(ctx) {
        await ctx.step('scan', async (s) => {
          if (block) await new Promise((resolve) => s.signal.addEventListener('abort', resolve))
          return 1
        })
        return {}
      },
    })
    const path = await snapshot('crossing', fresh(100))
    const rt1 = testRuntime({ schema: db.schema, workflows: [longOcr], middleware: [gate(path).middleware] })
    await rt1.open()
    const { runId } = await rt1.start(longOcr, {}, { purpose: 'test' })
    await until(async () => (await sql.step(runId, 'scan'))?.status === 'running', 'scan running')
    await rt1.close()

    block = false
    await snapshot('crossing', fresh(500))
    const g = gate(path)
    const rt2 = testRuntime({ schema: db.schema, workflows: [longOcr], middleware: [g.middleware] })
    await rt2.open()
    let result: Awaited<ReturnType<typeof rt2.wait>>
    try {
      result = await rt2.wait(runId)
    } finally {
      await rt2.close()
    }
    expect(result.status).toBe('done')
    const decision = g.decisions[0] as WalletDecision
    expect(decision).toMatchObject({ allowed: true, resume: true, reason: 'resume' })
  })

  test('env defaults', () => {
    const logger = captureLogger()
    expect(walletEnv({}, logger)).toMatchObject({
      thresholdUsd: 400,
      pausedUntil: new Date('2026-11-02T00:00:00Z'),
    })
    expect(
      walletEnv(
        { AGW_WALLET_THRESHOLD_USD: '250', AGW_WALLET_PAUSED_UNTIL: '', AGW_WALLET_SNAPSHOT: '/tmp/s.json' },
        logger,
      ),
    ).toEqual({ thresholdUsd: 250, pausedUntil: null, snapshotPath: '/tmp/s.json' })
    expect(walletEnv({ AGW_WALLET_THRESHOLD_USD: ' ' }, logger).thresholdUsd).toBe(400)
    expect(walletEnv({ AGW_WALLET_THRESHOLD_USD: '0' }, logger).thresholdUsd).toBe(0)
    // Fail closed: an invalid pause date keeps the default pause, never no pause.
    expect(walletEnv({ AGW_WALLET_THRESHOLD_USD: '-1', AGW_WALLET_PAUSED_UNTIL: 'soon' }, logger)).toMatchObject({
      thresholdUsd: 400,
      pausedUntil: new Date('2026-11-02T00:00:00Z'),
    })
    expect(logger.lines.map((l) => l.message)).toEqual([
      'AGW_WALLET_THRESHOLD_USD is not a number >= 0; the default applies',
      'AGW_WALLET_PAUSED_UNTIL is not a valid date; the default pause applies',
    ])
  })
})

describe('wallet gate, options and sinks', () => {
  test.each([Number.NaN, -1, Number.POSITIVE_INFINITY])(
    'thresholdUsd %p falls back to the default with a warning',
    async (bad) => {
      const g = gate(await snapshot('opt-over', fresh(450)), { thresholdUsd: bad })
      const result = await runOnce(g)
      expect(result.error?.message).toContain('>= $400 wallet gate')
      expect(g.logger.lines[0]?.message).toBe('wallet gate: thresholdUsd is not a number >= 0; the default applies')
    },
  )

  test('an invalid pausedUntil option falls back to the default pause (fail closed)', async () => {
    const g = gate(await snapshot('opt-under', fresh(10)), {
      pausedUntil: new Date('nope'),
      now: () => new Date('2026-10-30T00:00:00Z'),
    })
    const result = await runOnce(g)
    expect(result.error?.message).toContain('paused until 2026-11-02T00:00:00.000Z')
    expect(g.logger.lines[0]?.message).toBe('wallet gate: pausedUntil is an invalid date; the default pause applies')
  })

  test('a throwing or rejecting onDecision sink never refuses nor admits on its own', async () => {
    const throwing: DecisionSink = () => {
      throw new Error('sink down')
    }
    // A misused async sink: the type says void, the runtime value is a rejected promise.
    const rejecting = (() => Promise.reject(new Error('sink down'))) as unknown as DecisionSink
    for (const sink of [throwing, rejecting]) {
      const under = gate(await snapshot('sink-under', fresh(10)), { onDecision: sink })
      expect((await runOnce(under)).status).toBe('done')
      const over = gate(await snapshot('sink-over', fresh(450)), { onDecision: sink })
      const refused = await runOnce(over)
      expect(refused.error).toMatchObject({ kind: 'admission_refused', message: expect.stringContaining('$450') })
      await until(() => over.logger.lines.some((l) => l.message === 'onDecision threw; ignored'), 'sink logged')
      expect(under.logger.lines.some((l) => l.message === 'onDecision threw; ignored')).toBe(true)
    }
  })
})

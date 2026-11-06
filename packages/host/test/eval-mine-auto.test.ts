import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { AUTO_DEFAULTS, perCandidateCosts, sizeRun } from '../src/workflows/eval-mine/auto.ts'
import { evalMineAutoPorts } from '../src/workflows/eval-mine/history.ts'
import { startTestHost, type TestHost } from './support.ts'

const sizing = {
  creditAvailableUsd: 5,
  iuSpentUsd: 2.7,
  iuLineUsd: 20,
  iuMarginUsd: 0.75,
  perCandidate: { creditUsd: 0.05, iuUsd: 0.035 },
  unlabelled: 1000,
  maxPerRun: 150,
}

describe('perCandidateCosts', () => {
  test('falls back to the constants without history, per payer', () => {
    expect(perCandidateCosts([])).toEqual({ creditUsd: 0.05, iuUsd: 0.035, runs: 0 })
    expect(perCandidateCosts([{ runId: 'a', labelled: 0, creditUsd: 1, iuUsd: 1 }]).runs).toBe(0)
    // A payer that was never billed keeps its fallback; the other is measured.
    expect(perCandidateCosts([{ runId: 'a', labelled: 10, creditUsd: 0.5, iuUsd: 0 }])).toEqual({
      creditUsd: 0.05,
      iuUsd: AUTO_DEFAULTS.fallbackIuUsd,
      runs: 1,
    })
  })

  test('pools the runs: spend over the records they wrote', () => {
    const cost = perCandidateCosts([
      { runId: 'a', labelled: 3, creditUsd: 0.15, iuUsd: 0.09 },
      { runId: 'b', labelled: 17, creditUsd: 0.75, iuUsd: 0.51 },
    ])
    expect(cost.creditUsd).toBeCloseTo(0.045, 10)
    expect(cost.iuUsd).toBeCloseTo(0.03, 10)
    expect(cost.runs).toBe(2)
  })

  test('a run with no labelled candidate has no cost to pool', () => {
    expect(perCandidateCosts([{ runId: 'b', labelled: 0, creditUsd: 0, iuUsd: 0.2 }])).toEqual({
      creditUsd: AUTO_DEFAULTS.fallbackCreditUsd,
      iuUsd: AUTO_DEFAULTS.fallbackIuUsd,
      runs: 0,
    })
  })
})

describe('sizeRun', () => {
  test('the smallest of the credit, the IU room, the cap and the candidates left', () => {
    // credit: 5 × 0.9 / 0.05 = 90; IU: (20 − 0.75 − 2.7) / (0.035 × 1.25) = 378; cap 150; left 1000.
    expect(sizeRun(sizing)).toEqual({ state: 'labelled', planned: 90 })
    expect(sizeRun({ ...sizing, creditAvailableUsd: 100 })).toEqual({ state: 'labelled', planned: 150 })
    expect(sizeRun({ ...sizing, creditAvailableUsd: 100, maxPerRun: 500, unlabelled: 7 })).toEqual({
      state: 'labelled',
      planned: 7,
    })
    // IU: (20 − 0.75 − 18.5) / (0.035 × 1.25) = 17.1 → 17, below the credit's 90.
    expect(sizeRun({ ...sizing, iuSpentUsd: 18.5 })).toEqual({ state: 'labelled', planned: 17 })
  })

  test('no room is iu-line (checked first) or no-credit', () => {
    expect(sizeRun({ ...sizing, iuSpentUsd: 19.25 })).toEqual({ state: 'iu-line', planned: 0 })
    expect(sizeRun({ ...sizing, iuSpentUsd: 25 })).toEqual({ state: 'iu-line', planned: 0 })
    expect(sizeRun({ ...sizing, creditAvailableUsd: 0.05 })).toEqual({ state: 'no-credit', planned: 0 })
    expect(sizeRun({ ...sizing, creditAvailableUsd: 0, iuSpentUsd: 25 }).state).toBe('iu-line')
  })

  test('the plan prices IU at 1.25 × the measured cost: the room of exactly N measured records buys fewer', () => {
    // 0.35 of room is 10 records at the measured $0.035, but only 8 at $0.04375.
    const planned = sizeRun({ ...sizing, iuLineUsd: 20, iuSpentUsd: 18.9, creditAvailableUsd: 100 }).planned
    expect(planned).toBe(8)
  })

  test('the total plus the plan never passes line − margin', () => {
    for (const iuSpentUsd of [0, 2.7, 10, 18, 19, 19.2]) {
      const { planned } = sizeRun({ ...sizing, iuSpentUsd, creditAvailableUsd: 1000, maxPerRun: 100000 })
      // Even at the measured cost the plan stays under the line; the 1.25 factor is the margin on top.
      expect(iuSpentUsd + planned * sizing.perCandidate.iuUsd * 1.25).toBeLessThanOrEqual(20 - 0.75 + 1e-9)
    }
  })
})

describe('evalMineAutoPorts', () => {
  let t: TestHost
  const usageSchema = `usage_t_${Math.random().toString(36).slice(2, 10)}`
  const health = (pools: unknown) => (async () => Response.json({ status: 'ok', pools })) as unknown as typeof fetch
  const ports = (extra: Partial<Parameters<typeof evalMineAutoPorts>[0]> = {}) =>
    evalMineAutoPorts({
      journal: t.pool,
      schema: t.schema,
      usage: t.pool,
      usageSchema,
      gatewayUrl: 'http://gateway.test',
      ...extra,
    })

  beforeAll(async () => {
    t = await startTestHost({ prefix: 'evalminespend', extra: [] })
    await t.pool.query(`create schema ${usageSchema}`)
    await t.pool.query(`create table ${usageSchema}.records (
      source text not null, ts timestamptz not null, billing text not null, api_key text, run_id text,
      lane_detail jsonb, cost_usd numeric)`)
    const row = (o: {
      ts: string
      billing: string
      key?: string
      run?: string
      workflow: string
      cost: number | null
      source?: string
    }) =>
      t.pool.query(
        `insert into ${usageSchema}.records (source, ts, billing, api_key, run_id, lane_detail, cost_usd) values ($1,$2,$3,$4,$5,$6,$7)`,
        [o.source ?? 'gateway', o.ts, o.billing, o.key ?? null, o.run ?? null, { workflow: o.workflow }, o.cost],
      )
    const after = '2026-11-03T10:00:00Z'
    // Counted in the IU total: the personal key, an eval.* workflow, after the line was set (whatever the purpose).
    await row({ ts: after, billing: 'api_key', key: 'personal', workflow: 'eval.mine', cost: 1.5, run: 'run-new' })
    await row({ ts: after, billing: 'api_key', key: 'personal', workflow: 'eval.judge', cost: 0.25 })
    // Not counted: before the line, another key, credit, a non-eval workflow, another source, no cost.
    await row({ ts: '2026-11-02T23:59:59Z', billing: 'api_key', key: 'personal', workflow: 'eval.mine', cost: 9 })
    await row({ ts: after, billing: 'api_key', key: 'work', workflow: 'eval.mine', cost: 9 })
    await row({ ts: after, billing: 'api_credit', workflow: 'eval.mine', cost: 9, run: 'run-new' })
    await row({ ts: after, billing: 'api_key', key: 'personal', workflow: 'review', cost: 9 })
    await row({ ts: after, billing: 'api_key', key: 'personal', workflow: 'eval.mine', cost: 9, source: 'other' })
    // The spend of two labelling runs, per payer.
    await row({ ts: after, billing: 'api_credit', workflow: 'eval.mine', cost: 0.4, run: 'run-old' })
    await row({ ts: after, billing: 'api_key', key: 'personal', workflow: 'eval.mine', cost: 0.2, run: 'run-old' })
    const run = (id: string, output: unknown, status = 'done', root = id, finished = '2026-11-03T05:00:00Z') =>
      t.pool.query(
        `insert into ${t.schema}.runs (id, workflow, root_id, status, purpose, input, input_hash, lock_key, version_started, output, finished_at)
         values ($1, 'eval.mine', $2, $3, 'test', '{}', 'h', $4, 'test', $5, $6)`,
        [id, root, status, Math.floor(Math.random() * 1e9), output, finished],
      )
    await run('run-old', { labelledThisRun: 8, thirdSeatThisRun: 2 }, 'done', 'run-old', '2026-11-02T05:00:00Z')
    await run('run-new', { labelledThisRun: 20, thirdSeatThisRun: 0 })
    await run('run-plan', { labelledThisRun: 0, thirdSeatThisRun: 0 })
    await run('run-failed', { labelledThisRun: 5, thirdSeatThisRun: 0 }, 'failed')
  })
  afterAll(async () => {
    await t.pool.query(`drop schema ${usageSchema} cascade`)
    await t.close()
  })

  test('the IU total: the personal key on eval.* workflows since the line, whatever the purpose', async () => {
    const total = await ports().iuSpentUsd({ since: AUTO_DEFAULTS.iuSince })
    expect(total).toBeCloseTo(1.5 + 0.25 + 0.2, 10)
    expect(await ports().iuSpentUsd({ since: '2030-01-01T00:00:00Z' })).toBe(0)
  })

  test('an IU eval row without a cost fails the read, naming how many; it is never counted as 0', async () => {
    const insert = (cost: number | null, key = 'personal') =>
      t.pool.query(
        `insert into ${usageSchema}.records (source, ts, billing, api_key, run_id, lane_detail, cost_usd)
         values ('gateway', '2026-11-03T10:00:00Z', 'api_key', $1, 'run-null', '{"workflow":"eval.judge"}', $2)`,
        [key, cost],
      )
    // Not counted, so not unknown: another key, and a priced row.
    await insert(null, 'work')
    expect(await ports().iuSpentUsd({ since: AUTO_DEFAULTS.iuSince })).toBeCloseTo(1.5 + 0.25 + 0.2, 10)
    await insert(null)
    await insert(null)
    const failure = await ports()
      .iuSpentUsd({ since: AUTO_DEFAULTS.iuSince })
      .then(
        () => 'resolved',
        (error: Error) => error.message,
      )
    expect(failure).toContain('2 IU eval rows')
    expect(failure).toContain('no cost_usd')
    // Before the line they do not matter.
    expect(await ports().iuSpentUsd({ since: '2026-11-04T00:00:00Z' })).toBe(0)
    await t.pool.query(`delete from ${usageSchema}.records where run_id = 'run-null'`)
  })

  test('a run whose spend is unknown is left out of the history, never read as $0', async () => {
    const journal = (id: string) =>
      t.pool.query(
        `insert into ${t.schema}.runs (id, workflow, root_id, status, purpose, input, input_hash, lock_key, version_started, output, finished_at)
         values ($1, 'eval.mine', $1, 'done', 'test', '{}', 'h', $2, 'test', $3, '2026-11-03T06:00:00Z')`,
        [id, Math.floor(Math.random() * 1e9), { labelledThisRun: 5, thirdSeatThisRun: 0 }],
      )
    const usage = (run: string, billing: string, key: string | null, cost: number | null) =>
      t.pool.query(
        `insert into ${usageSchema}.records (source, ts, billing, api_key, run_id, lane_detail, cost_usd)
         values ('gateway', '2026-11-02T10:00:00Z', $1, $2, $3, '{"workflow":"eval.mine"}', $4)`,
        [billing, key, run, cost],
      )
    // A NULL on the credit payer, a NULL on the IU payer, and a done run with no usage rows at all.
    for (const id of ['run-null-credit', 'run-null-iu', 'run-no-rows']) await journal(id)
    await usage('run-null-credit', 'api_credit', null, null)
    await usage('run-null-credit', 'api_key', 'personal', 0.1)
    await usage('run-null-iu', 'api_credit', null, 0.2)
    await usage('run-null-iu', 'api_key', 'personal', null)
    try {
      const spend = await ports().runSpend({ limit: 10 })
      expect(spend.map((s) => s.runId)).toEqual(['run-new', 'run-old'])
      // With only unknown runs in range, the history is empty and the sizing falls back to its constants.
      expect(
        await ports()
          .runSpend({ limit: 3 })
          .then((s) => s.map((x) => x.runId)),
      ).toEqual([])
    } finally {
      await t.pool.query(`delete from ${usageSchema}.records where run_id like 'run-null-%'`)
      await t.pool.query(`delete from ${t.schema}.runs where id in ('run-null-credit', 'run-null-iu', 'run-no-rows')`)
    }
  })

  test('the run spend: the newest runs that wrote records, with what each payer was billed', async () => {
    const spend = await ports().runSpend({ limit: 10 })
    expect(spend.map((s) => s.runId)).toEqual(['run-new', 'run-old'])
    expect(spend[0]).toEqual({ runId: 'run-new', labelled: 20, creditUsd: 9, iuUsd: 1.5 })
    expect(spend[1]).toEqual({ runId: 'run-old', labelled: 8, creditUsd: 0.4, iuUsd: 0.2 })
    expect((await ports().runSpend({ limit: 1 })).map((s) => s.runId)).toEqual(['run-new'])
  })

  test('the credit: the eval-eligible pools’ evalAvailableUsd summed', async () => {
    const pools = [
      { id: 'me', evalEligible: true, evalAvailableUsd: 1.25 },
      { id: 'iu', evalEligible: false, evalAvailableUsd: 7 },
      { id: 'me2', evalEligible: true, evalAvailableUsd: 0.5 },
    ]
    expect(await ports({ fetch: health(pools) }).creditAvailableUsd()).toBe(1.75)
    expect(await ports({ fetch: health([]) }).creditAvailableUsd()).toBe(0)
  })

  test('a read that cannot answer throws with its reason', async () => {
    const reason = (read: Promise<unknown>) =>
      read.then(
        () => 'resolved',
        (error: Error) => error.message,
      )
    const refused = (async () => new Response('x', { status: 503 })) as unknown as typeof fetch
    expect(await reason(ports({ fetch: refused }).creditAvailableUsd())).toContain(
      'gateway /health unreadable: HTTP 503',
    )
    expect(await reason(ports({ fetch: health('nope') }).creditAvailableUsd())).toContain('gateway /health unreadable')
    expect(await reason(ports({ gatewayUrl: undefined }).creditAvailableUsd())).toContain('AGW_GATEWAY_URL is not set')
    expect(await reason(ports({ usage: undefined }).iuSpentUsd({ since: AUTO_DEFAULTS.iuSince }))).toContain(
      'USAGE_PG_URL is not set',
    )
    expect(() => evalMineAutoPorts({ journal: t.pool, schema: 'bad;drop' })).toThrow('invalid schema name')
  })
})

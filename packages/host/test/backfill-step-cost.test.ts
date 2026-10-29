import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { migrate } from '../../runtime/src/migrate.ts'
import { Pool } from 'pg'
import { backfillStepCost, type MessageSource } from '../../../scripts/backfill-step-cost.ts'
import { freshSchema, PG_URL } from './support.ts'

// Haiku 5.5: in 0.10, out 0.50 per M, and 5x on every column for a request over 100K prompt tokens.
const pool = new Pool({ connectionString: PG_URL, max: 4 })
const fresh = freshSchema('backfill')
const schema = fresh.schema
const q = (sql: string, params: unknown[] = []) => pool.query(sql, params)

beforeAll(async () => {
  await migrate(pool, schema)
})
afterAll(async () => {
  await pool.end()
  await fresh.drop()
})

async function run(id: string, workflow = 'review') {
  await q(
    `insert into "${schema}".runs (id, workflow, root_id, status, purpose, input, input_hash, lock_key, version_started, cost)
     values ($1, $2, $1, 'done', 'test', '{}', 'h', 1, 'v', null)`,
    [id, workflow],
  )
}

async function step(
  runId: string,
  stepId: string,
  options: {
    model: string
    session?: string
    input: number
    output: number
    reasoning?: number
    cost?: number | null
    argoError?: string
  },
) {
  await q(
    `insert into "${schema}".steps
       (run_id, step_id, kind, status, handle, model, tokens_input, tokens_output, tokens_reasoning, cost, unpriced_calls,
        usage_by_model, argo_synced_at, argo_error)
     values ($1, $2, 'agent', 'done', $3, $4, $5, $6, $7, $8, $9, $10, now(), $11)`,
    [
      runId,
      stepId,
      options.session ? JSON.stringify({ handle: { sessionId: options.session } }) : null,
      options.model,
      options.input,
      options.output,
      options.reasoning ?? 0,
      options.cost ?? null,
      options.cost === null || options.cost === undefined ? 1 : 0,
      JSON.stringify({
        [options.model]: {
          cost: options.cost ?? null,
          tokens: { input: options.input, output: options.output },
          toolCalls: 0,
          unpricedCalls: options.cost === null || options.cost === undefined ? 1 : 0,
        },
      }),
      options.argoError ?? null,
    ],
  )
}

const assistant = (input: number, output: number, cost: number, reasoning = 0) => ({
  id: `m-${input}-${output}`,
  type: 'assistant',
  tokens: { input, output, reasoning, cache: { read: 0, write: 0 } },
  cost,
})

/** s1's session: one short message (OpenCode's cost 0.001) and one over 100K (OpenCode's flat-row cost 0.015). */
const sessions: Record<string, unknown[]> = {
  ses_s1: [assistant(1_000, 50, 0.001, 10), assistant(150_000, 100, 0.015)],
}
const source: MessageSource = {
  messages: async (id) => {
    const found = sessions[id]
    if (!found) throw new Error('session gone')
    return found as never
  },
}
// short message as OpenCode reported it; the long one repriced at the tier: (150000 * 0.10 + 100 * 0.50) * 5 / 1e6
const S1_COST = 0.001 + ((150_000 * 0.1 + 100 * 0.5) * 5) / 1e6
const S3_ESTIMATE = (120_000 * 0.1 * 5 + 100 * 0.5 * 5) / 1e6

async function seed() {
  await q(`truncate "${schema}".runs cascade`)
  await run('r1')
  await step('r1', 's1', {
    model: 'claude-haiku-5-5-eu',
    session: 'ses_s1',
    input: 151_000,
    output: 160,
    reasoning: 10,
  })
  await step('r1', 's2', { model: 'claude-haiku-5-5-eu', input: 10, output: 5, cost: 0.5 })
  await run('r2')
  await step('r2', 's3', { model: 'claude-haiku-5-5-eu', session: 'ses_gone', input: 120_000, output: 100 })
  await run('r3')
  await step('r3', 's4', {
    model: 'claude-haiku-5-5-eu',
    session: 'ses_s1',
    input: 151_000,
    output: 160,
    argoError: 'bad row',
  })
  await run('r4', 'research')
  await step('r4', 's5', { model: 'deepseek-v4.1-flash', session: 'ses_s1', input: 151_000, output: 160 })
}

const snapshot = async () => ({
  steps: (
    await q(
      `select run_id, step_id, cost, unpriced_calls, argo_synced_at, usage_by_model from "${schema}".steps order by 1, 2`,
    )
  ).rows,
  runs: (await q(`select id, cost, unpriced_calls from "${schema}".runs order by 1`)).rows,
})
const stepRow = async (id: string) =>
  (await q(`select * from "${schema}".steps where step_id = $1`, [id])).rows[0] as Record<string, unknown>
const runRow = async (id: string) =>
  (await q(`select * from "${schema}".runs where id = $1`, [id])).rows[0] as Record<string, unknown>
const lines: string[] = []
const options = (extra: object = {}) => ({
  pool,
  schema,
  messages: source,
  log: (l: string) => lines.push(l),
  ...extra,
})

describe('backfillStepCost', () => {
  test('a dry run prices the plan and writes nothing', async () => {
    await seed()
    const before = await snapshot()
    lines.length = 0
    const result = await backfillStepCost(options())
    expect(result).toMatchObject({ planned: 1, written: 0, requeued: 0, runs: 0 })
    expect(result.usd).toBeCloseTo(S1_COST, 12)
    expect(await snapshot()).toEqual(before)
    const out = lines.join('\n')
    expect(out).toContain('DRY RUN')
    expect(out).toContain('rate source: claude-haiku-5-5-eu -> route ') // per model, which route's rate priced it
    expect(out).toContain('tier x5/x5 over 100000')
    expect(out).toContain('per-call')
    expect(out).toContain('Argo quarantined') // s4 is counted, not touched
    expect(out).toContain('--all-models') // s5 is not selected
  })

  test('--commit prices per call, re-queues the Argo row and recomputes only that run', async () => {
    await seed()
    const result = await backfillStepCost(options({ commit: true }))
    expect(result).toMatchObject({ planned: 1, written: 1, requeued: 1, runs: 1 })

    const s1 = await stepRow('s1')
    expect(Number(s1.cost)).toBeCloseTo(S1_COST, 12)
    expect(s1.unpriced_calls).toBe(0)
    expect(s1.argo_synced_at).toBeNull() // back in the outbox
    expect((s1.usage_by_model as Record<string, Record<string, unknown>>)['claude-haiku-5-5-eu']).toMatchObject({
      unpricedCalls: 0,
      costBackfill: 'per-call',
    })

    // journal.ts / record middleware semantics: the run's cost is the sum of its own steps, unpriced calls summed
    const r1 = await runRow('r1')
    expect(Number(r1.cost)).toBeCloseTo(0.5 + S1_COST, 12)
    expect(r1.unpriced_calls).toBe(0)

    // untouched: the gone session without --estimates, the quarantined step, the non-Claude step and their runs
    for (const id of ['s3', 's4', 's5']) {
      const row = await stepRow(id)
      expect(row.cost).toBeNull()
      expect(row.argo_synced_at).not.toBeNull()
    }
    for (const id of ['r2', 'r3', 'r4']) expect((await runRow(id)).cost).toBeNull()
  })

  test('a re-run is a no-op', async () => {
    await seed()
    await backfillStepCost(options({ commit: true }))
    const before = await snapshot()
    const again = await backfillStepCost(options({ commit: true }))
    expect(again).toMatchObject({ planned: 0, written: 0, requeued: 0, runs: 0 })
    expect(await snapshot()).toEqual(before)
  })

  test('--estimates prices a step whose session is gone from its totals (upper bound), marked as such', async () => {
    await seed()
    const result = await backfillStepCost(options({ commit: true, estimates: true }))
    expect(result).toMatchObject({ planned: 2, written: 2, runs: 2 })
    const s3 = await stepRow('s3')
    expect(Number(s3.cost)).toBeCloseTo(S3_ESTIMATE, 12)
    expect((s3.usage_by_model as Record<string, Record<string, unknown>>)['claude-haiku-5-5-eu']).toMatchObject({
      costBackfill: 'step-total-tier',
    })
    expect((await stepRow('s4')).cost).toBeNull() // quarantined by Argo: never written, whatever the flags
  })

  test('--all-models includes the non-Claude step, priced by its route rate', async () => {
    await seed()
    const result = await backfillStepCost(options({ allModels: true }))
    // s5 (deepseek, research.agent's rate) shares s1's session, so it reconciles and is priced too
    expect(result.planned).toBe(2)
  })
})

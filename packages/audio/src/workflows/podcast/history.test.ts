import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { freshSchema, inspector, testRuntime } from '../../../../runtime/test/support/pg.ts'
import { postgresCosts, postgresHistory, type Queryable, renderTranscriptMarkdown } from './history.ts'
import { createPodcastWorkflow } from './index.ts'
import { researchKey } from './ports.ts'
import { fakeHistory, fakeRoom } from './testing.ts'

// The show's memory on Postgres: imported legacy episodes and finished `podcast` runs, one order, per series.

const db = freshSchema('podcast_history')
const sql = inspector(db.schema)
const pool = sql.pool as unknown as Queryable

beforeAll(async () => {
  const rt = testRuntime({ schema: db.schema, workflows: [] })
  await rt.open()
  await rt.close()
})

afterAll(async () => {
  await sql.close()
  await db.drop()
})

const SCRIPT = {
  title: 'T',
  description: 'D.',
  segments: [
    {
      title: 'S1',
      turns: [
        { speaker: 'A' as const, text: 'Hallo.' },
        { speaker: 'B' as const, text: 'Hi.' },
      ],
    },
  ],
  hosts: [
    { id: 'A' as const, name: 'Jonas' },
    { id: 'B' as const, name: 'Lena' },
  ],
}

describe('renderTranscriptMarkdown', () => {
  test('renders title, description and one heading per segment with display names', () => {
    expect(renderTranscriptMarkdown(SCRIPT)).toBe('# T\n\nD.\n\n## S1\n\n**Jonas:** Hallo.\n**Lena:** Hi.\n')
  })
})

describe('postgresHistory', () => {
  test('merges imported episodes and finished prod runs of the series, newest first', async () => {
    await sql.pool.query(
      `insert into "${db.schema}".podcast_episodes (id, series, created_at, title, description, profile, request, transcript)
       values ('legacy-old', 'Show', '2026-09-01T00:00:00Z', 'Old', 'Old one.', '{"format":"Gespräch"}', '{}', '# Old\n'),
              ('legacy-other', 'Other show', '2026-09-02T00:00:00Z', 'Other', '', null, '{}', null)`,
    )
    const room = fakeRoom()
    const podcast = createPodcastWorkflow({
      costs: postgresCosts(pool, db.schema),
      history: fakeHistory(),
      models: room,
      config: {
        agentic: false,
        voicePath: null,
        hosts: [
          { id: 'A', name: 'Jonas', voice: 'a' },
          { id: 'B', name: 'Lena', voice: 'b' },
        ],
      },
    })
    const rt = testRuntime({ schema: db.schema, workflows: [podcast] })
    await rt.open()
    let prodRun: string
    try {
      const input = { source: 'Notizen.', series: 'Show', research: false }
      prodRun = (await rt.start(podcast, input, { purpose: 'prod' })).runId
      expect((await rt.wait(prodRun)).status).toBe('done')
      // An eval run of the same series is not part of the show.
      const evalRun = (await rt.start(podcast, input, { purpose: 'eval' })).runId
      expect((await rt.wait(evalRun)).status).toBe('done')
    } finally {
      await rt.close()
    }

    const history = postgresHistory(pool, db.schema)
    const recent = await history.recent('Show', 10)
    expect(recent.map((e) => e.id)).toEqual([prodRun, 'legacy-old'])
    expect(recent[0]).toMatchObject({ title: 'Final title', description: 'Final description.' })
    expect(recent[0]?.profile).toMatchObject({ format: 'Gespräch', segmentCount: 2 })
    expect(recent[1]).toEqual({
      id: 'legacy-old',
      createdAt: '2026-09-01T00:00:00.000Z',
      title: 'Old',
      description: 'Old one.',
      profile: { format: 'Gespräch' } as never,
    })
    expect(await history.recent('Show', 1)).toHaveLength(1)

    expect(await history.transcript('legacy-old')).toBe('# Old\n')
    expect(await history.transcript('legacy-other')).toBeNull()
    const transcript = await history.transcript(prodRun)
    expect(transcript?.startsWith('# Final title\n\nFinal description.\n\n## Chapter 1\n\n**Jonas:** ')).toBe(true)
    expect(await history.transcript('nope')).toBeNull()
  })

  test('refuses a schema name it would have to quote', () => {
    expect(() => postgresHistory(pool, 'x"; drop')).toThrow('invalid journal schema name')
    expect(() => postgresCosts(pool, 'x"; drop')).toThrow('invalid journal schema name')
  })
})

describe('postgresCosts', () => {
  /** A run row as the runtime writes it, reduced to the columns these queries read. */
  async function run(id: string, workflow: string, rootId: string, key: string | null) {
    await sql.pool.query(
      `insert into "${db.schema}".runs (id, workflow, parent_id, root_id, status, purpose, input, input_hash, lock_key,
         version_started, idempotency_key)
       values ($1, $2, $3, $4, 'done', 'build', '{}', 'h', 1, 'v', $5)`,
      [id, workflow, id === rootId ? null : rootId, rootId, key],
    )
  }
  async function step(runId: string, stepId: string, cost: number | null, unpriced: number) {
    await sql.pool.query(
      `insert into "${db.schema}".steps (run_id, step_id, kind, status, cost, unpriced_calls)
       values ($1, $2, 'code', 'failed', $3, $4)`,
      [runId, stepId, cost, unpriced],
    )
  }

  test("sums the run's own steps, its keyed research runs and its produce child; failed steps included", async () => {
    await run('ep-1', 'podcast', 'ep-1', null)
    await step('ep-1', 'segment:0', 0.5, 0)
    await step('ep-1', 'segment:1', 0.25, 2) // a failed attempt still carries what it billed
    await step('ep-1', 'house', null, 0)
    // Two research runs this episode started (a resumed step re-attached to the first, so it is counted once).
    await run('rs-1', 'research', 'rs-1', researchKey('ep-1', 'research', 'quick', 'a'))
    await step('rs-1', 'research', 0.1, 0)
    await run('rs-2', 'research', 'rs-2', researchKey('ep-1', 'research:fact:0', 'standard', 'b'))
    await step('rs-2', 'research', 0.2, 1)
    // Another episode's research run and an unkeyed one are not this episode's.
    await run('rs-3', 'research', 'rs-3', researchKey('ep-2', 'research', 'quick', 'a'))
    await step('rs-3', 'research', 9, 0)
    await run('rs-4', 'research', 'rs-4', null)
    await step('rs-4', 'research', 9, 0)
    await run('ep-1/produce/0', 'podcast.produce', 'ep-1', null)
    await step('ep-1/produce/0', 'synth', 1, 0)

    const cost = await postgresCosts(pool, db.schema).episodeCost('ep-1')
    expect(cost.script).toEqual({ usd: 0.75, unpriced: 2 })
    expect(cost.research.runs).toBe(2)
    expect(cost.research.usd).toBeCloseTo(0.3, 9)
    expect(cost.research.unpriced).toBe(1)
    expect(cost.produce).toEqual({ usd: 1, unpriced: 0 })
    expect(await postgresCosts(pool, db.schema).episodeCost('nobody')).toEqual({
      script: { usd: 0, unpriced: 0 },
      research: { usd: 0, unpriced: 0, runs: 0 },
      produce: { usd: 0, unpriced: 0 },
    })
  })
})

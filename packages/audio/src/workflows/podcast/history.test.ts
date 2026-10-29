import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { freshSchema, inspector, testRuntime } from '../../../../runtime/test/support/pg.ts'
import { postgresHistory, type Queryable, renderTranscriptMarkdown } from './history.ts'
import { createPodcastWorkflow } from './index.ts'
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
  })
})

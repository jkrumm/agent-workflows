import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { defineWorkflow } from '../../../../runtime/src/index.ts'
import { freshSchema, inspector, testRuntime, until } from '../../../../runtime/test/support/pg.ts'
import { type PodcastDeps, createPodcastWorkflow, PodcastInput } from './index.ts'
import { ProduceInput, type ProduceInputValue } from './produce-input.ts'
import { MAX_MINUTES, MIN_MINUTES } from './schema.ts'
import { postgresCosts } from './history.ts'
import { fakeBrain, fakeHistory, fakeResearch, fakeRoom, type Stage } from './testing.ts'

// The room as journaled steps on a real runtime (Postgres) with a fake model transport: the full pass, resume after a
// kill between segments, the best-effort fallbacks, the `podcast.produce` hand-off, and the request clamps.

const db = freshSchema('podcast')
const sql = inspector(db.schema)
const costs = postgresCosts(sql.pool, db.schema)

beforeAll(async () => {
  const rt = testRuntime({ schema: db.schema, workflows: [] })
  await rt.open()
  await rt.close()
})

afterAll(async () => {
  await sql.close()
  await db.drop()
})

const config = (overrides: NonNullable<PodcastDeps['config']> = {}): NonNullable<PodcastDeps['config']> => ({
  hosts: [
    { id: 'A', name: 'Jonas', voice: 'voice-a', speed: 0.94 },
    { id: 'B', name: 'Lena', voice: 'voice-b', speed: 1 },
  ],
  historyDepth: 8,
  researchMaxCalls: 0,
  agentic: true,
  maxUnitChars: 3000,
  concurrency: 3,
  voicePath: null,
  ...overrides,
})

/** A produce stand-in: records its input, answers a duration and chapter times. */
function stubProduce(seen: ProduceInputValue[], fail = false) {
  return defineWorkflow({
    id: 'podcast.produce',
    version: 'test',
    input: ProduceInput,
    output: z.looseObject({
      durationSeconds: z.number(),
      chapters: z.array(z.object({ title: z.string(), startMs: z.number() })),
    }),
    async run(_ctx, input) {
      seen.push(input)
      if (fail) throw new Error('synth exploded')
      return {
        durationSeconds: 321,
        chapters: input.script.segments.map((s, i) => ({ title: s.title, startMs: i * 1000 })),
        mp3: 'episode.mp3',
      }
    },
  })
}

const REQUEST = { source: 'Notizen über Wochenplanung.', brief: 'Kurz und klar.', minutes: 5 }

describe('podcast workflow', () => {
  test('the full room: research, editorial, follow-up, outline, segments, lint, review, revise, metadata, produce', async () => {
    const room = fakeRoom({ segments: 2, loadBearing: [{ question: 'What is OKR?', open_question: 'Open one' }] })
    const research = fakeResearch()
    const produced: ProduceInputValue[] = []
    const podcast = createPodcastWorkflow({
      costs,
      history: fakeHistory([
        { id: 'old-1', createdAt: '2026-10-01T00:00:00.000Z', title: 'Old', description: 'Earlier.', profile: null },
      ]),
      models: room,
      research,
      brain: fakeBrain({}),
      produce: stubProduce(produced),
      config: config(),
    })
    const rt = testRuntime({ schema: db.schema, workflows: [podcast] })
    await rt.open()
    try {
      const { runId } = await rt.start(podcast, REQUEST, { purpose: 'build' })
      const result = await rt.wait(runId)
      expect(result.status).toBe('done')
      const output = result.output as Record<string, unknown>

      // Every stage ran, in the room's order of steps.
      const steps = (await sql.steps(runId)).map((s) => s.step_id)
      for (const id of [
        'house',
        'source',
        'research',
        'history',
        'editorial',
        'outline',
        'segment:0',
        'segment:1',
        'lint',
        'review:dramaturge:a',
        'review:fact-editor:b',
        'revise:0',
        'metadata',
        'script',
        'produce',
      ]) {
        expect(steps).toContain(id)
      }
      // The reviewers noted segment 0 only: segment 1 has no revision step.
      expect(steps).not.toContain('revise:1')
      expect(room.count('review')).toBe(6)

      // The research loop echoed the assistant message unchanged, provider fields included.
      const second = room.rounds.find((m) => m.some((x) => x.role === 'tool'))
      expect(second?.[2]).toMatchObject({ role: 'assistant', reasoning_content: 'opaque provider state' })
      expect(second?.[3]).toMatchObject({ role: 'tool', tool_call_id: 'c1' })

      // The editor's load-bearing fact ran at standard depth and closed its open question.
      expect(research.queries).toEqual(['standard:What is OKR?'])
      // Keyed to this run and the fact's own step: a resume re-attaches to the same host run.
      expect(research.keys[0]?.startsWith(`podcast:${runId}:research:fact:0:`)).toBe(true)
      expect(steps).toContain('research:fact:0')
      expect(steps).not.toContain('research:fact:1')

      expect(output.title).toBe('Final title')
      expect(output.chapters).toEqual([
        { title: 'Chapter 1', startMs: 0 },
        { title: 'Chapter 2', startMs: 1000 },
      ])
      expect(output.profile).toMatchObject({ format: 'Gespräch', durationSeconds: 321, segmentCount: 2 })
      expect((output.profile as { agent?: { runs: number } }).agent?.runs).toBeGreaterThanOrEqual(3)
      // Cost is the journal's record: every call priced on its step; the fake research runs are not in the journal.
      expect(output.cost).toEqual({
        scriptUsd: Number((room.calls.length * 0.001).toFixed(6)),
        scriptUnpriced: 0,
        researchUsd: 0,
        researchUnpriced: 0,
        researchRuns: 0,
        produceUsd: 0,
        produceUnpriced: 0,
        totalUsd: Number((room.calls.length * 0.001).toFixed(6)),
        unpriced: 0,
      })

      // What the produce child received: the locked script with chapter titles, hosts, metadata, request, profile.
      expect(produced).toHaveLength(1)
      const input = produced[0] as ProduceInputValue
      expect(input.episode.id).toBe(runId)
      expect(input.script.segments.map((s) => s.title)).toEqual(['Chapter 1', 'Chapter 2'])
      expect(input.script.segments[0]?.turns[2]?.text).toContain('revised')
      expect(input.hosts.map((h) => h.name)).toEqual(['Jonas', 'Lena'])
      expect(input.metadata).toMatchObject({
        title: 'Final title',
        coverPrompt: 'a desk at dawn',
        topics: ['planning', 'weeks', 'time'],
      })
      expect(input.request).toEqual({
        series: 'Brain Sonderausgabe',
        language: 'de',
        minutes: 5,
        publish: false,
        cover: true,
        brainNote: true,
      })

      // Every model call is priced on its step (the run record sums the steps).
      const priced = (await sql.steps(runId)).filter((s) => s.cost !== null)
      const total = priced.reduce((n, s) => n + Number(s.cost), 0)
      expect(total).toBeCloseTo(room.calls.length * 0.001, 6)
      expect((await sql.step(runId, 'segment:0'))?.unpriced_calls ?? 0).toBe(0)
    } finally {
      await rt.close()
    }
  })

  test('resume after a kill between segments re-runs no finished segment', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let held = false
    const room = fakeRoom({
      segments: 4,
      // Segment 2 (third of the first window of three) is held on its first call only.
      hold: (stage, index) => {
        if (stage !== 'segment' || index !== 2 || held) return undefined
        held = true
        return gate
      },
    })
    const podcast = createPodcastWorkflow({
      costs,
      history: fakeHistory(),
      models: room,
      config: config({ agentic: false }),
    })
    const first = testRuntime({ schema: db.schema, workflows: [podcast] })
    await first.open()
    const { runId } = await first.start(podcast, { ...REQUEST, research: false }, { purpose: 'build' })
    await until(
      async () => (await sql.step(runId, 'segment:1'))?.status === 'done' && held,
      'segments 0 and 1 done, 2 held',
    )
    expect((await sql.step(runId, 'segment:0'))?.status).toBe('done')
    await first.close() // a deploy mid-run: the row stays running
    expect((await sql.run(runId))?.status).toBe('running')
    release()

    const second = testRuntime({ schema: db.schema, workflows: [podcast] })
    await second.open()
    try {
      const result = await second.wait(runId)
      expect(result.status).toBe('done')
      // Finished segments were replayed from the journal; the interrupted one ran again; the rest once.
      expect(room.count('segment', 0)).toBe(1)
      expect(room.count('segment', 1)).toBe(1)
      expect(room.count('segment', 2)).toBe(2)
      expect(room.count('segment', 3)).toBe(1)
      expect(room.count('outline')).toBe(1)
      expect(room.count('editorial')).toBe(1)
      for (const id of ['segment:0', 'segment:1', 'outline', 'editorial']) {
        expect(await sql.step(runId, id)).toMatchObject({ status: 'done', attempts: 1 })
      }
      expect((result.output as { produce: unknown }).produce).toBeNull()
      // The output's cost is what the journal recorded, the resumed run's steps included.
      const recorded = (await sql.steps(runId)).reduce((n, s) => n + Number(s.cost ?? 0), 0)
      expect((result.output as { cost: { scriptUsd: number } }).cost.scriptUsd).toBeCloseTo(recorded, 6)
    } finally {
      await second.close()
    }
  })

  test('resume after a kill re-runs no finished research: the research step and each fact step replay', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let held = false
    const room = fakeRoom({
      loadBearing: [
        { question: 'Fact one?', open_question: 'Open one' },
        { question: 'Fact two?', open_question: '' },
      ],
      hold: (stage) => {
        if (stage !== 'outline' || held) return undefined
        held = true
        return gate
      },
    })
    const research = fakeResearch()
    const podcast = createPodcastWorkflow({
      costs,
      history: fakeHistory(),
      models: room,
      research,
      config: config({ agentic: false }),
    })
    const first = testRuntime({ schema: db.schema, workflows: [podcast] })
    await first.open()
    const { runId } = await first.start(podcast, REQUEST, { purpose: 'build' })
    await until(() => held, 'the outline call to start')
    await first.close()
    release()
    const second = testRuntime({ schema: db.schema, workflows: [podcast] })
    await second.open()
    try {
      expect((await second.wait(runId)).status).toBe('done')
      expect(room.count('research')).toBe(2) // the loop's two rounds, once
      expect([...research.queries].sort()).toEqual(['standard:Fact one?', 'standard:Fact two?'])
      expect(room.count('outline')).toBe(2)
    } finally {
      await second.close()
    }
  })

  test('best-effort stages fall back: research, editorial, reviewers and metadata failing still yield an episode', async () => {
    const fail: Partial<Record<Stage, boolean>> = { research: true, editorial: true, review: true, metadata: true }
    const room = fakeRoom({ segments: 3, fail })
    const podcast = createPodcastWorkflow({
      costs,
      history: fakeHistory(),
      models: room,
      config: config({ agentic: false }),
    })
    const rt = testRuntime({ schema: db.schema, workflows: [podcast] })
    await rt.open()
    try {
      const { runId } = await rt.start(podcast, { ...REQUEST, minutes: 12 }, { purpose: 'build' })
      const result = await rt.wait(runId)
      expect(result.status).toBe('done')
      const output = result.output as { title: string; chapters: { title: string }[]; profile: Record<string, unknown> }
      // The default brief: requested minutes, the neutral format, planSegmentCount(12) = 3 segments.
      expect(output.profile).toMatchObject({ format: 'Gespräch', minutes: 12, toolCalls: 0, segmentCount: 3 })
      // Metadata failed: the outline's drafts and working titles stand.
      expect(output.title).toBe('Outline title')
      expect(output.chapters.map((c) => c.title)).toEqual(['Working title 1', 'Working title 2', 'Working title 3'])
      // A failed reviewer is skipped, never fatal (a transport failure is not re-asked; only an unparseable answer is).
      expect(room.count('review')).toBe(6)
      expect((await sql.step(runId, 'review:dramaturge:a'))?.output).toBeNull()
    } finally {
      await rt.close()
    }
  })

  test('a required stage failing is fatal: the outline', async () => {
    const room = fakeRoom({ fail: { outline: true } })
    const podcast = createPodcastWorkflow({
      costs,
      history: fakeHistory(),
      models: room,
      config: config({ agentic: false }),
    })
    const rt = testRuntime({ schema: db.schema, workflows: [podcast] })
    await rt.open()
    try {
      const { runId } = await rt.start(podcast, { ...REQUEST, research: false }, { purpose: 'build' })
      const result = await rt.wait(runId)
      expect(result.status).toBe('failed')
      expect(room.count('segment')).toBe(0)
    } finally {
      await rt.close()
    }
  })

  test('a failed produce child fails the run after the script is journaled', async () => {
    const produced: ProduceInputValue[] = []
    const podcast = createPodcastWorkflow({
      costs,
      history: fakeHistory(),
      models: fakeRoom(),
      produce: stubProduce(produced, true),
      config: config({ agentic: false }),
    })
    const rt = testRuntime({ schema: db.schema, workflows: [podcast] })
    await rt.open()
    try {
      const { runId } = await rt.start(podcast, { ...REQUEST, research: false }, { purpose: 'build' })
      const result = await rt.wait(runId)
      expect(result.status).toBe('failed')
      expect(produced).toHaveLength(1)
      expect((await sql.step(runId, 'script'))?.status).toBe('done')
    } finally {
      await rt.close()
    }
  })

  test('sourcePaths are read through the source reader and appended to the source', async () => {
    const room = fakeRoom()
    const podcast = createPodcastWorkflow({
      costs,
      history: fakeHistory(),
      models: room,
      sources: {
        read: async (path) => {
          if (path === 'Inbox/Plan.md') return 'Der Plan.'
          throw new Error(`"${path}": not found`)
        },
      },
      config: config({ agentic: false }),
    })
    const rt = testRuntime({ schema: db.schema, workflows: [podcast] })
    await rt.open()
    try {
      const { runId } = await rt.start(
        podcast,
        { sourcePaths: ['Inbox/Plan.md'], research: false },
        { purpose: 'build' },
      )
      expect((await rt.wait(runId)).status).toBe('done')
      expect((await sql.step(runId, 'source'))?.output).toBe('\n\n## Inbox/Plan.md\nDer Plan.')

      const missing = await rt.start(podcast, { sourcePaths: ['Areas/Nope.md'], research: false }, { purpose: 'build' })
      const failed = await rt.wait(missing.runId)
      expect(failed.status).toBe('failed')
      expect(failed.error?.message).toContain('Areas/Nope.md')
    } finally {
      await rt.close()
    }
  })
})

describe('podcast input', () => {
  test('clamps minutes, defaults the flags and the series, as legacy did', () => {
    const parsed = PodcastInput.parse({ source: 'x', minutes: 500, series: '  ' })
    expect(parsed).toMatchObject({
      minutes: MAX_MINUTES,
      series: 'Brain Sonderausgabe',
      language: 'de',
      publish: false,
      cover: true,
      research: true,
      pinMinutes: false,
      brainNote: true,
      sourcePaths: [],
    })
    expect(PodcastInput.parse({ source: 'x', minutes: 1 }).minutes).toBe(MIN_MINUTES)
    expect(PodcastInput.parse({ source: 'x' }).minutes).toBe(20)
  })

  test('refuses what legacy refused: no source, more than 20 paths, a blank path, an unknown language, a long source', () => {
    expect(PodcastInput.safeParse({ source: '  ' }).success).toBe(false)
    expect(PodcastInput.safeParse({ sourcePaths: Array.from({ length: 21 }, (_, i) => `a/${i}.md`) }).success).toBe(
      false,
    )
    expect(PodcastInput.safeParse({ sourcePaths: [' '] }).success).toBe(false)
    expect(PodcastInput.safeParse({ source: 'x', language: 'fr' }).success).toBe(false)
    expect(PodcastInput.safeParse({ source: 'x'.repeat(200_001) }).success).toBe(false)
    expect(PodcastInput.safeParse({ source: 'x', unknown: 1 }).success).toBe(false)
    expect(PodcastInput.safeParse({ sourcePaths: ['Areas/a.md'] }).success).toBe(true)
  })
})

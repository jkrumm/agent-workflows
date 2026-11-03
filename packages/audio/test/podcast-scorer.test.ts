import { describe, expect, test } from 'bun:test'
import { plainSuite } from '../../host/src/workflows/suite.ts'
import { CASES_PATH, podcastSuite } from '../src/workflows/podcast/module.ts'
import { PodcastInput, type PodcastResult } from '../src/workflows/podcast/schema.ts'
import { DURATION_BAND, languageOf, PodcastReference, podcastScorer, wordsOf } from '../src/workflows/podcast/scorer.ts'

const DE_TEXT =
  'In dieser Folge geht es um den Kompost auf dem Balkon und darum, wie man mit wenig Platz und ein paar Würmern aus den Küchenresten gute Erde macht.'
const EN_TEXT =
  'In this episode we talk about keeping a sourdough starter alive, how often you have to feed it and what to do when it does not rise.'

const profile: PodcastResult['profile'] = {
  format: 'chat',
  lead: 'balanced',
  humor: 'sparse',
  opening: 'question',
  minutes: 3,
  durationSeconds: 180,
  topics: ['kompost'],
  segmentCount: 3,
  toolCalls: 0,
  researchCalls: 0,
}

/** A finished 3-minute German episode as the room returns it. */
function episode(over: Partial<PodcastResult> = {}): PodcastResult {
  return {
    title: 'Kompost auf dem Balkon',
    description: DE_TEXT,
    chapters: [
      { title: 'Warum Kompost', startMs: 0 },
      { title: 'Die Würmer und das Material', startMs: 62_000 },
      { title: 'Wann die Erde fertig ist', startMs: 121_000 },
    ],
    profile,
    cost: {
      scriptUsd: 0.4,
      scriptUnpriced: 0,
      researchUsd: 0,
      researchUnpriced: 0,
      researchRuns: 0,
      researchPending: 0,
      produceUsd: 0.1,
      produceUnpriced: 0,
      totalUsd: 0.5,
      unpriced: 0,
      complete: true,
    },
    produce: { durationSeconds: 180, chapters: [{ title: 'x', startMs: 0 }] },
    ...over,
  }
}

const request = (over: object = {}) => ({ source: 'Notizen zum Kompost', language: 'de', minutes: 3, ...over })

const score = (output: unknown, reference?: { anchors: string[] }, input: object = request()) =>
  podcastScorer.score(PodcastInput.parse(input), output as never, {
    source: 'regression',
    signal: new AbortController().signal,
    ...(reference ? { reference } : {}),
  })

const ALL = ['valid', 'metadata', 'language', 'chapters', 'duration', 'cost', 'grounded']

describe('language check', () => {
  test('German and English text are told apart', () => {
    expect(languageOf(DE_TEXT)).toBe('de')
    expect(languageOf(EN_TEXT)).toBe('en')
  })

  test('too short a text, or neither language, is null', () => {
    expect(languageOf('Kompost auf dem Balkon')).toBeNull()
    expect(languageOf('zxq vlorp kekt brunt flimm dorp skree vant moop blit zarn quell')).toBeNull()
  })

  test('umlauts and digits are part of words', () => {
    expect(wordsOf('Würmer, 12 Äpfel!')).toEqual(['würmer', '12', 'äpfel'])
  })
})

describe('podcast scorer', () => {
  test('a good episode passes every score', async () => {
    const verdict = await score(episode(), { anchors: ['Kompost'] })
    expect(verdict.feedback).toBeUndefined()
    expect(verdict.pass).toBe(true)
    expect(Object.keys(verdict.scores).sort()).toEqual([...ALL].sort())
    expect(Object.values(verdict.scores).every((v) => v === 1)).toBe(true)
  })

  test('without a reference (drift) grounded is left out', async () => {
    const verdict = await score(episode())
    expect(verdict.pass).toBe(true)
    expect(Object.keys(verdict.scores).sort()).toEqual(ALL.filter((k) => k !== 'grounded').sort())
  })

  test('an English episode for a German request fails language, and only language', async () => {
    const verdict = await score(
      episode({
        title: 'Sourdough starters',
        description: EN_TEXT,
        chapters: [
          { title: 'Feeding the starter', startMs: 0 },
          { title: 'When it will not rise', startMs: 90_000 },
        ],
      }),
      {
        anchors: ['starter'],
      },
    )
    expect(verdict.scores).toMatchObject({ language: 0, metadata: 1, chapters: 1, duration: 1, cost: 1, grounded: 1 })
    expect(verdict.feedback).toContain('reads as en (want de)')
    expect(verdict.pass).toBe(false)
  })

  test('the request language is the input: an English request takes the English episode', async () => {
    const out = episode({
      title: 'Sourdough starters',
      description: EN_TEXT,
      chapters: [{ title: 'Feeding the starter', startMs: 0 }],
    })
    expect((await score(out, undefined, request({ language: 'en' }))).scores.language).toBe(1)
  })

  test('blank title or description fails metadata', async () => {
    expect((await score(episode({ title: '  ' }))).scores.metadata).toBe(0)
    expect((await score(episode({ description: '' }))).scores.metadata).toBe(0)
  })

  test('chapters: out of order, overlapping starts, past the end, untimed, untitled or missing fail', async () => {
    const chapters = (...starts: (number | undefined)[]) =>
      starts.map((startMs, i) => ({ title: `Kapitel ${i + 1}`, ...(startMs === undefined ? {} : { startMs }) }))
    const bad = [
      chapters(0, 100_000, 50_000),
      chapters(0, 60_000, 60_000),
      chapters(0, 60_000, 180_000),
      chapters(0, 60_000, 200_000),
      chapters(0, 60_000, undefined),
      chapters(30_000, 60_000, 90_000),
      chapters(),
      [{ title: ' ', startMs: 0 }],
    ]
    for (const list of bad) expect((await score(episode({ chapters: list }))).scores.chapters).toBe(0)
    expect((await score(episode({ chapters: chapters(0, 500, 179_000) }))).scores.chapters).toBe(1)
  })

  test('chapters without a produce result cannot be ordered', async () => {
    const verdict = await score(episode({ produce: null, chapters: [{ title: 'Kapitel' }] }))
    expect(verdict.scores).toMatchObject({ chapters: 0, duration: 0 })
    expect(verdict.feedback).toContain('produce stage did not run')
  })

  test('duration: inside the band passes, short or long fails', async () => {
    const at = (seconds: number) => episode({ produce: { durationSeconds: seconds } })
    expect((await score(at(3 * 60 * DURATION_BAND.min))).scores.duration).toBe(1)
    expect((await score(at(3 * 60 * DURATION_BAND.max))).scores.duration).toBe(1)
    expect((await score(at(60))).scores.duration).toBe(0)
    expect((await score(at(600))).scores.duration).toBe(0)
  })

  test('the requested minutes are the clamped input: 1 minute is asked as 3', async () => {
    expect((await score(episode(), undefined, request({ minutes: 1 }))).scores.duration).toBe(1)
  })

  test('cost: zero, incomplete or not the sum of its parts fails', async () => {
    const cost = (over: Partial<PodcastResult['cost']>) => episode({ cost: { ...episode().cost, ...over } })
    expect((await score(cost({ totalUsd: 0, scriptUsd: 0, produceUsd: 0 }))).scores.cost).toBe(0)
    expect((await score(cost({ complete: false, unpriced: 1 }))).scores.cost).toBe(0)
    expect((await score(cost({ totalUsd: 0.9 }))).scores.cost).toBe(0)
    expect((await score(cost({ researchUsd: 0.05, totalUsd: 0.55 }))).scores.cost).toBe(1)
  })

  test('grounded: none of the anchors in the title, description or chapter titles fails', async () => {
    const verdict = await score(episode(), { anchors: ['Fahrrad', 'Kette'] })
    expect(verdict.scores.grounded).toBe(0)
    expect(verdict.feedback).toContain('holds none of Fahrrad, Kette')
    expect((await score(episode(), { anchors: ['würmer'] })).scores.grounded).toBe(1)
  })

  test('a failed run or a malformed output scores zero everywhere', async () => {
    for (const output of [null, {}, { title: 'x' }]) {
      const verdict = await score(output, { anchors: ['kompost'] })
      expect(verdict.pass).toBe(false)
      expect(Object.keys(verdict.scores).sort()).toEqual([...ALL].sort())
      expect(Object.values(verdict.scores).every((v) => v === 0)).toBe(true)
    }
    expect((await score(null)).feedback).toBe('the run failed')
  })
})

describe('podcast eval suite', () => {
  const cases = podcastSuite.read(podcastSuite.path?.({}) ?? CASES_PATH)

  test('five cases that publish nothing and spend little: 3 minutes, no research, no cover, no brain note', () => {
    expect(cases).toHaveLength(5)
    for (const c of cases) {
      const input = PodcastInput.parse(c.input('/unused', {}))
      expect(input).toMatchObject({
        publish: false,
        cover: false,
        research: false,
        brainNote: false,
        pinMinutes: true,
        minutes: 3,
      })
      expect(input.sourcePaths).toEqual([])
      expect(input.source.length).toBeGreaterThan(200)
      expect(() => PodcastReference.parse(c.reference)).not.toThrow()
      expect(c.tree).toBeNull()
    }
    expect(new Set(cases.map((c) => c.id)).size).toBe(5)
  })

  test('both languages are covered, and each series is the eval show, never the real one', () => {
    const inputs = cases.map((c) => PodcastInput.parse(c.input('/unused', {})))
    expect(new Set(inputs.map((i) => i.language))).toEqual(new Set(['de', 'en']))
    expect(inputs.every((i) => i.series === 'Eval Series')).toBe(true)
  })

  test('the anchors belong to the language and the brief: each is in the case source', () => {
    for (const c of cases) {
      const input = PodcastInput.parse(c.input('/unused', {}))
      const { anchors } = PodcastReference.parse(c.reference)
      expect(anchors.some((a) => input.source.toLowerCase().includes(a.toLowerCase()))).toBe(true)
    }
  })

  test('the source text of each case reads as its language', () => {
    for (const c of cases) {
      const input = PodcastInput.parse(c.input('/unused', {}))
      expect(languageOf(input.source)).toBe(input.language)
    }
  })

  test('the reader is the plain one over the committed file', () => {
    expect(plainSuite.read(CASES_PATH).map((c) => c.id)).toEqual(cases.map((c) => c.id))
  })
})

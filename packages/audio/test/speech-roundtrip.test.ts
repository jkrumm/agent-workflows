import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { audioRoutes } from '../src/routes.ts'
import { type FakeGateway, geminiAudio, startFakeGateway } from '@agent-workflows/testing/gateway'
import { fakeMedia, silentLog, testDeps } from '../src/testing/index.ts'
import { createSpeechRoundtrip } from '../src/workflows/speech-roundtrip/index.ts'
import speechRoundtripModule, { CASES_PATH } from '../src/workflows/speech-roundtrip/module.ts'
import { SpeechRoundtripInput, type SpeechRoundtripOutputValue } from '../src/workflows/speech-roundtrip/schema.ts'
import {
  DEFAULT_MAX_WER,
  editDistance,
  normalizeWords,
  SpeechReference,
  speechRoundtripScorer,
  wordErrorRate,
} from '../src/workflows/speech-roundtrip/scorer.ts'
import { plainSuite } from '../../host/src/workflows/suite.ts'
import { freshSchema, inspector, testRuntime } from '../../runtime/test/support/pg.ts'

const SENTENCE = 'The quick brown fox jumps over the lazy dog near the old stone bridge.'

const leg = (route: string, extra: Partial<SpeechRoundtripOutputValue['tts']> = {}) => ({
  route,
  model: 'm',
  calls: 1,
  unpricedCalls: 0,
  costUsd: 0.001,
  latencyMs: 400,
  ...extra,
})

/** A round trip as the workflow returns it: 14 words in 5 s, 0.36 s a word. */
const trip = (over: Partial<SpeechRoundtripOutputValue> = {}): SpeechRoundtripOutputValue => ({
  text: SENTENCE,
  audioSeconds: 5,
  audioBytes: 40_000,
  tts: leg('audio.tts.gemini-flash-lite'),
  stt: leg('audio.stt.voxtral-mini'),
  costUsd: 0.002,
  ...over,
})

const score = (output: unknown, reference?: { maxWer: number }, input: object = { text: SENTENCE, language: 'en' }) =>
  speechRoundtripScorer.score(SpeechRoundtripInput.parse(input), output as never, {
    source: 'regression',
    signal: new AbortController().signal,
    ...(reference ? { reference } : {}),
  })

describe('word error rate', () => {
  test('identical words are 0, case and punctuation do not count', () => {
    expect(wordErrorRate('Hello, World!', 'hello world', 'en').wer).toBe(0)
  })

  test('known pairs: one substitution, one deletion, one insertion, all wrong', () => {
    expect(wordErrorRate('the cat sat down', 'the cat sat up', 'en')).toEqual({ wer: 0.25, edits: 1, words: 4 })
    expect(wordErrorRate('the cat sat down', 'the cat down', 'en')).toEqual({ wer: 0.25, edits: 1, words: 4 })
    expect(wordErrorRate('the cat sat', 'the big cat sat', 'en')).toEqual({ wer: 1 / 3, edits: 1, words: 3 })
    expect(wordErrorRate('a b', 'c d', 'en').wer).toBe(1)
  })

  test('an empty transcript is a full miss (all deletions), more insertions than words can exceed 1', () => {
    expect(wordErrorRate('one two three', '', 'en').wer).toBe(1)
    expect(wordErrorRate('one', 'a b c', 'en').wer).toBe(3)
  })

  test('an empty reference: 0 against an empty transcript, 1 against any words', () => {
    expect(wordErrorRate('', '', 'en').wer).toBe(0)
    expect(wordErrorRate('', 'word', 'en').wer).toBe(1)
  })

  test('numbers are words: digits and spelled-out forms are the same, in both languages', () => {
    expect(wordErrorRate('platform 12 costs 23 euros', 'platform twelve costs twenty-three euros', 'en').wer).toBe(0)
    expect(wordErrorRate('leaves at 7:45', 'leaves at seven forty five', 'en').wer).toBe(0)
    expect(wordErrorRate('es sind 21 Bücher', 'Es sind einundzwanzig Bücher.', 'de').wer).toBe(0)
    expect(wordErrorRate('it costs 23', 'it costs 32', 'en').wer).toBeGreaterThan(0)
  })

  test('normalization: apostrophes, hyphens, umlauts and ß', () => {
    expect(normalizeWords("Don't stop — it's well-known", 'en')).toEqual(['dont', 'stop', 'its', 'well', 'known'])
    expect(normalizeWords('Die Größe der Äpfel', 'de')).toEqual(['die', 'größe', 'der', 'äpfel'])
    expect(normalizeWords('1234 and 0', 'en')).toEqual([
      'one',
      'thousand',
      'two',
      'hundred',
      'thirty',
      'four',
      'and',
      'zero',
    ])
    expect(normalizeWords('40 und 100', 'de')).toEqual(['vierzig', 'und', '100'])
  })

  test('only ASCII digits are numbers: fullwidth, superscript and fraction numerals stay as written and never hang', () => {
    for (const language of ['en', 'de'] as const) {
      expect(normalizeWords('２', language)).toEqual(['２'])
      expect(normalizeWords('²', language)).toEqual(['²'])
      expect(normalizeWords('½', language)).toEqual(['½'])
      expect(normalizeWords('x² und 12', language).slice(0, 3)).toEqual(['x', '²', 'und'])
    }
    expect(wordErrorRate('es sind ½ Liter', 'es sind ½ liter', 'de').wer).toBe(0)
    expect(wordErrorRate('page ２', 'page two', 'en').wer).toBe(0.5)
  })

  test('edit distance of word lists', () => {
    expect(editDistance(['a', 'b', 'c'], ['a', 'c'])).toBe(1)
    expect(editDistance([], ['a', 'b'])).toBe(2)
    expect(editDistance(['a'], [])).toBe(1)
  })
})

describe('speech-roundtrip scorer', () => {
  test('a perfect trip passes and reports wer 0 and the pace', async () => {
    const verdict = await score(trip(), { maxWer: 0.1 })
    expect(verdict.pass).toBe(true)
    expect(verdict.feedback).toBeUndefined()
    expect(verdict.scores).toMatchObject({ valid: 1, werOk: 1, pace: 1, recorded: 1, wer: 0 })
    expect(verdict.scores.secondsPerWord).toBeCloseTo(5 / 14, 5)
  })

  test('a partial trip: one wrong word of 14 passes at 0.1, fails at 0.05, and the verdict shows what was heard', async () => {
    const heard = trip({ text: 'The quick brown fox jumps over the lazy dog near the old stone fridge.' })
    const loose = await score(heard, { maxWer: 0.1 })
    expect(loose.pass).toBe(true)
    expect(loose.scores.wer).toBeCloseTo(1 / 14, 5)
    const strict = await score(heard, { maxWer: 0.05 })
    expect(strict.pass).toBe(false)
    expect(strict.scores.werOk).toBe(0)
    expect(strict.feedback).toContain('fridge')
  })

  test('without a reference the default tolerance applies', async () => {
    const half = trip({ text: 'The quick brown fox' })
    const verdict = await score(half)
    expect(verdict.pass).toBe(false)
    expect(verdict.feedback).toContain(`over ${DEFAULT_MAX_WER}`)
    expect((await score(trip())).pass).toBe(true)
  })

  test('pace: clipped audio and dragging audio fail, the rest of the trip still scores', async () => {
    const clipped = await score(trip({ audioSeconds: 1 }), { maxWer: 0.1 })
    expect(clipped.scores).toMatchObject({ pace: 0, werOk: 1 })
    expect((await score(trip({ audioSeconds: 20 }), { maxWer: 0.1 })).scores.pace).toBe(0)
    expect((await score(trip({ audioSeconds: 0 }), { maxWer: 0.1 })).scores.pace).toBe(0)
  })

  test('recorded: a leg with no call, an unpriced call or an unknown price fails', async () => {
    const noCall = trip({ stt: leg('audio.stt.voxtral-mini', { calls: 0 }) })
    expect((await score(noCall, { maxWer: 0.1 })).scores.recorded).toBe(0)
    const unpriced = trip({ tts: leg('audio.tts.gemini-flash-lite', { unpricedCalls: 1, costUsd: null }) })
    const verdict = await score(unpriced, { maxWer: 0.1 })
    expect(verdict.scores.recorded).toBe(0)
    expect(verdict.pass).toBe(false)
  })

  test('a failed run, a malformed output or an empty sentence scores zero on every gate', async () => {
    for (const output of [null, {}, { text: 5 }]) {
      const verdict = await score(output, { maxWer: 0.1 })
      expect(verdict.pass).toBe(false)
      expect(verdict.scores).toMatchObject({ valid: 0, werOk: 0, pace: 0, recorded: 0, wer: 1 })
    }
    expect((await score(null, { maxWer: 0.1 })).feedback).toBe('the run failed')
    const noWords = await speechRoundtripScorer.score({ text: '...', language: 'en' }, trip(), {
      source: 'regression',
      signal: new AbortController().signal,
    })
    expect(noWords.pass).toBe(false)
  })
})

describe('speech-roundtrip suite', () => {
  const cases = plainSuite.read(CASES_PATH)

  test('six cases, three English and three German, one with digits; every input and reference fits', () => {
    expect(cases).toHaveLength(6)
    const inputs = cases.map((c) => SpeechRoundtripInput.parse(c.input('/unused', {})))
    expect(inputs.filter((i) => i.language === 'en')).toHaveLength(3)
    expect(inputs.filter((i) => i.language === 'de')).toHaveLength(3)
    expect(inputs.filter((i) => /\d/.test(i.text))).toHaveLength(1)
    for (const c of cases) expect(() => SpeechReference.parse(c.reference)).not.toThrow()
    expect(new Set(cases.map((c) => c.id)).size).toBe(6)
  })

  test('the routes default to the door defaults and an arm swaps them as args', () => {
    const first = cases[0]
    expect(SpeechRoundtripInput.parse(first?.input('/unused', {})).ttsRoute).toBe('audio.tts.gemini-flash-lite')
    const swapped = SpeechRoundtripInput.parse(
      first?.input('/unused', { ttsRoute: 'audio.tts.gemini-flash', sttRoute: 'audio.stt.openai' }),
    )
    expect([swapped.ttsRoute, swapped.sttRoute]).toEqual(['audio.tts.gemini-flash', 'audio.stt.openai'])
    expect(SpeechRoundtripInput.safeParse({ text: 'x', language: 'en', sttRoute: 'audio.tts.prep' }).success).toBe(
      false,
    )
  })

  test('the module declares it, builds the internal workflow and refuses to build without the lanes', () => {
    expect(speechRoundtripModule.suite).toBeDefined()
    expect(() => speechRoundtripModule.create({} as never, { peers: [], suites: new Map() })).toThrow('audio')
  })
})

describe('speech-roundtrip workflow', () => {
  const db = freshSchema('speechrt')
  const root = mkdtempSync(join(tmpdir(), 'agw-speech-rt-'))
  let iu: FakeGateway | undefined
  afterEach(() => iu?.stop())
  afterAll(async () => {
    await db.drop()
    rmSync(root, { recursive: true, force: true })
  })

  const ROUTES = audioRoutes()

  async function run(input: object, transcript = SENTENCE) {
    iu = startFakeGateway({
      gemini: () => geminiAudio(new Uint8Array(48_000)),
      transcriptions: () =>
        Response.json({
          model: 'm',
          text: transcript,
          language: null,
          segments: [],
          usage: { prompt_audio_seconds: 2 },
        }),
    })
    const deps = testDeps(iu, {
      log: silentLog,
      media: { ...fakeMedia, duration: async () => 4.5, compressForStt: async (bytes) => bytes.slice().buffer },
    })
    const entry = createSpeechRoundtrip({ audio: deps, artifactRoot: root })
    const runtime = testRuntime({ schema: db.schema, workflows: [entry.workflow] })
    await runtime.open()
    try {
      const { runId } = await runtime.start(entry.workflow, input, { purpose: 'test' })
      const end = await runtime.wait(runId, { pollMs: 20 })
      const score =
        end.status === 'done'
          ? await runtime.scoreRun(runId, { source: 'regression', reference: { maxWer: 0.1 } })
          : null
      return { end, score, requests: iu.requests }
    } finally {
      await runtime.close()
    }
  }

  test('speaks the sentence, transcribes the audio and is scored: the routes are inputs, both calls are recorded', async () => {
    const { end, score: final, requests } = await run({ text: SENTENCE, language: 'en' })
    expect(end.status).toBe('done')
    const out = end.output as SpeechRoundtripOutputValue
    expect(out.text).toBe(SENTENCE)
    expect(out.audioSeconds).toBe(4.5)
    expect(out.tts).toMatchObject({ route: 'audio.tts.gemini-flash-lite', calls: 1, unpricedCalls: 0 })
    expect(out.stt).toMatchObject({ route: 'audio.stt.voxtral-mini', calls: 1, unpricedCalls: 0 })
    expect(out.costUsd).toBeGreaterThan(0)
    expect(requests.map((r) => r.route)).toEqual(['gemini', 'transcriptions'])
    expect(requests[1]?.form?.get('model')).toBe(ROUTES['audio.stt.voxtral-mini'].model)
    expect(requests[1]?.form?.get('language')).toBe('en')
    expect(final).toMatchObject({ pass: true, scores: { wer: 0, werOk: 1, pace: 1, recorded: 1 } })
  })

  test('an STT route in the input is the one asked, and a misheard word shows in the score', async () => {
    const {
      end,
      score: final,
      requests,
    } = await run(
      { text: SENTENCE, language: 'en', sttRoute: 'audio.stt.openai' },
      'The quick brown fox jumps over the lazy dog near the old stone fridge.',
    )
    expect(end.status).toBe('done')
    expect((end.output as SpeechRoundtripOutputValue).stt.route).toBe('audio.stt.openai')
    expect(requests[1]?.form?.get('model')).toBe(ROUTES['audio.stt.openai'].model)
    expect(final?.scores.wer).toBeCloseTo(1 / 14, 5)
  })

  test('a failing duration probe after the paid synthesis keeps the TTS result: its step is done and recorded', async () => {
    const sql = inspector(db.schema)
    iu = startFakeGateway({
      gemini: () => geminiAudio(new Uint8Array(48_000)),
      transcriptions: () => Response.json({ text: SENTENCE }),
    })
    const deps = testDeps(iu, {
      log: silentLog,
      media: {
        ...fakeMedia,
        duration: async () => {
          throw new Error('ffprobe is gone')
        },
      },
    })
    const entry = createSpeechRoundtrip({ audio: deps, artifactRoot: root })
    const runtime = testRuntime({ schema: db.schema, workflows: [entry.workflow] })
    await runtime.open()
    try {
      const { runId } = await runtime.start(entry.workflow, { text: SENTENCE, language: 'en' }, { purpose: 'test' })
      const end = await runtime.wait(runId, { pollMs: 20 })
      expect(end.status).toBe('failed')
      expect((await sql.step(runId, 'tts'))?.status).toBe('done')
      expect((await sql.step(runId, 'duration'))?.status).toBe('failed')
      expect(iu.requests.filter((r) => r.route === 'gemini')).toHaveLength(1)
    } finally {
      await runtime.close()
      await sql.close()
    }
  })

  test('the audio is kept in the run directory of the artifact store', async () => {
    const { end } = await run({ text: SENTENCE, language: 'en' })
    expect(end.status).toBe('done')
    const kept = [...new Bun.Glob('speech-roundtrip/*/speech.mp3').scanSync({ cwd: root })]
    expect(kept.length).toBeGreaterThan(0)
    expect(existsSync(join(root, kept[0] ?? ''))).toBe(true)
  })
})

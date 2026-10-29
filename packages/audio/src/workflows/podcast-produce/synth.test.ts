import { afterEach, describe, expect, test } from 'bun:test'
import { createAudioScope } from '../../scope.ts'
import { DELIVERY_STYLES } from '../../speech/core.ts'
import { ReplicateSynthError } from '../../speech/replicate.ts'
import { caught, type FakeIu, geminiAudio, startFakeIu, testDeps } from '../../testing/index.ts'
import type { CallEvent, UsageEvent } from '../../usage.ts'
import type { HostValue } from '../podcast/schema.ts'
import { setProduceLogger } from './log.ts'
import {
  DENSE_TURN_STYLE,
  multiSpeakerVoices,
  numberDensity,
  type SynthTurnInput,
  type TtsLane,
  synthesizeUnit,
  turnsForSynthesis,
  unitsForMultiSpeaker,
  unitsPerTurn,
} from './synth.ts'

type Segments = Parameters<typeof turnsForSynthesis>[0]

const HOSTS: [HostValue, HostValue] = [
  { id: 'A', name: 'Lena', voice: 'Rachel' },
  { id: 'B', name: 'Marco', voice: 'Roger' },
]

describe('turnsForSynthesis', () => {
  test("maps each turn to its host's voice, in flattened segment order", () => {
    const segments: Segments = [
      {
        title: 'S1',
        turns: [
          { speaker: 'A', text: 'Hallo.' },
          { speaker: 'B', text: 'Hi.' },
        ],
      },
      { title: 'S2', turns: [{ speaker: 'A', text: "Weiter geht's." }] },
    ]
    const turns = turnsForSynthesis(segments, HOSTS, 'de')
    expect(turns).toHaveLength(3)
    expect(turns.map((t) => t.text)).toEqual(['Hallo.', 'Hi.', "Weiter geht's."])
    expect(turns.map((t) => t.voice)).toEqual(['Rachel', 'Roger', 'Rachel'])
    expect(turns.map((t) => t.speakerName)).toEqual(['Lena', 'Marco', 'Lena'])
    expect(turns.every((t) => t.languageCode === 'de')).toBe(true)
  })

  test("previous/next text comes from the SAME speaker's neighbouring turn, not the other host's", () => {
    const segments: Segments = [
      {
        title: 'S1',
        turns: [
          { speaker: 'A', text: 'A1' },
          { speaker: 'B', text: 'B1' },
          { speaker: 'A', text: 'A2' },
          { speaker: 'B', text: 'B2' },
        ],
      },
    ]
    const turns = turnsForSynthesis(segments, HOSTS, 'en')
    // A2 (index 2): previous same-speaker turn is A1, next is undefined (no later A turn)
    expect(turns[2]?.previousText).toBe('A1')
    expect(turns[2]?.nextText).toBeUndefined()
    // B1 (index 1): previous is undefined, next same-speaker turn is B2
    expect(turns[1]?.previousText).toBeUndefined()
    expect(turns[1]?.nextText).toBe('B2')
  })

  test('caps previous/next context at 600 chars', () => {
    const segments: Segments = [
      {
        title: 'S1',
        turns: [
          { speaker: 'A', text: 'x'.repeat(1000) },
          { speaker: 'B', text: 'filler' },
          { speaker: 'A', text: 'short' },
        ],
      },
    ]
    const turns = turnsForSynthesis(segments, HOSTS, 'en')
    expect(turns[2]?.previousText?.length).toBe(600)
  })
})

/** The cold open of episode 5: the exact turn the pacing rule exists for. */
const DENSE_TURN =
  'Zwölf Euro fünfzig. Das ist die Differenz, und deshalb reden wir heute über eintausenddreihundertdreiundsiebzig Euro fünfundsiebzig … hundertfünfzigtausend Euro mal drei Komma neun neun Prozent.'

describe('numberDensity', () => {
  test('the Obermenzing cold open is dense', () => {
    expect(numberDensity(DENSE_TURN)).toBeGreaterThan(0.12)
  })

  test('a normal spoken sentence is not dense', () => {
    expect(
      numberDensity('Und dann stehst du da an der Mautstelle und fragst dich, ob das alles so klug war.'),
    ).toBeLessThanOrEqual(0.12)
  })

  test('the articles ein/eine/einer do not count as numbers', () => {
    expect(numberDensity('Ein Auto, eine Frage, einer von vielen Wegen dorthin.')).toBe(0)
  })

  test('digits, German compounds and English numerals all count', () => {
    expect(numberDensity('330')).toBe(1)
    expect(numberDensity('eintausenddreihundertdreiundsiebzig')).toBe(1)
    expect(numberDensity('dreißig')).toBe(1)
    expect(numberDensity('twenty seven percent')).toBe(1)
    expect(numberDensity('')).toBe(0)
  })

  test('words merely containing a numeral stem as a substring do not count', () => {
    expect(numberDensity('einzig')).toBe(0)
    expect(numberDensity('regelmäßig')).toBe(0)
    expect(numberDensity('witzige')).toBe(0)
    expect(numberDensity('jetzig')).toBe(0)
  })

  test("bare 'ein' and 'und' do not count on their own", () => {
    expect(numberDensity('ein')).toBe(0)
    expect(numberDensity('und')).toBe(0)
  })

  test("English 'one' and 'point' were dropped from the word set", () => {
    expect(numberDensity('one of the things I want to point out')).toBe(0)
  })

  test("German compound numerals built from 'ein'/'und' plus other stems still count", () => {
    expect(numberDensity('einundzwanzig')).toBe(1)
    expect(numberDensity('dreizehn')).toBe(1)
    expect(numberDensity('siebzehn')).toBe(1)
    expect(numberDensity('fünfzig')).toBe(1)
  })
})

describe('dense-turn pacing', () => {
  const dense: Segments = [
    {
      title: 'S1',
      turns: [
        { speaker: 'A', text: DENSE_TURN },
        { speaker: 'B', text: 'Das musst du mir noch einmal erklären, bitte.' },
      ],
    },
  ]

  test("a dense turn is slowed by the configured delta; a normal one keeps the host's speed", () => {
    const hosts: [HostValue, HostValue] = [
      { id: 'A', name: 'Lena', voice: 'Rachel', speed: 1.0 },
      { id: 'B', name: 'Marco', voice: 'Roger', speed: 1.05 },
    ]
    const turns = turnsForSynthesis(dense, hosts, 'de', { denseThreshold: 0.12, denseSlowdown: 0.06 })
    expect(turns[0]?.speed).toBeCloseTo(0.94, 5)
    expect(turns[0]?.dense).toBe(true)
    expect(turns[1]?.speed).toBe(1.05)
    expect(turns[1]?.dense).toBeUndefined()
  })

  test('a host with no speed of its own is slowed from 1.0', () => {
    const turns = turnsForSynthesis(dense, HOSTS, 'de', { denseThreshold: 0.12, denseSlowdown: 0.06 })
    expect(turns[0]?.speed).toBeCloseTo(0.94, 5)
    // The non-dense turn stays unset, so ElevenLabs keeps the model's own pace.
    expect(turns[1]?.speed).toBeUndefined()
  })

  test('the slowed speed is clamped to the 0.7 floor', () => {
    const slowHosts: [HostValue, HostValue] = [
      { id: 'A', name: 'Lena', voice: 'Rachel', speed: 0.72 },
      { id: 'B', name: 'Marco', voice: 'Roger' },
    ]
    const turns = turnsForSynthesis(dense, slowHosts, 'de', { denseThreshold: 0.12, denseSlowdown: 0.5 })
    expect(turns[0]?.speed).toBe(0.7)
  })

  test('defaults to 0.12 / 0.06 when no pacing is passed', () => {
    const turns = turnsForSynthesis(dense, HOSTS, 'de')
    expect(turns[0]?.speed).toBeCloseTo(0.94, 5)
    expect(turns[1]?.speed).toBeUndefined()
  })

  test('a writer-set delivery becomes the turn style; unknown keys get none', () => {
    const segments: Segments = [
      {
        title: 'S',
        turns: [
          { speaker: 'A', text: 'Das ist neu für mich.', delivery: 'curious' },
          { speaker: 'B', text: 'Wirklich? Erzähl.', delivery: 'furious' },
        ],
      },
    ]
    const turns = turnsForSynthesis(segments, HOSTS, 'de')
    expect(turns[0]?.style).toBe(DELIVERY_STYLES.curious)
    expect(turns[1]?.style).toBeUndefined()
  })
})

describe('multi-speaker units', () => {
  const turn = (speaker: 'A' | 'B', chars: number): SynthTurnInput => ({
    text: 'x'.repeat(chars),
    speaker,
    speakerName: speaker === 'A' ? 'Jonas' : 'Lena',
    voice: speaker === 'A' ? 'Charon' : 'Erinome',
    languageCode: 'de',
  })

  test('runs pack up to maxChars and never span a segment', () => {
    const turns = [turn('A', 400), turn('B', 400), turn('A', 400), turn('B', 400), turn('A', 400)]
    const units = unitsForMultiSpeaker(turns, [3, 2], 1000)
    expect(units.map((u) => u.turnIndexes)).toEqual([[0, 1], [2], [3, 4]])
  })

  test('a single over-long turn becomes its own run', () => {
    const units = unitsForMultiSpeaker([turn('A', 5000), turn('B', 100)], [2], 3000)
    expect(units.map((u) => u.turnIndexes)).toEqual([[0], [1]])
  })

  test('a cut never lands between a question and its answer', () => {
    const q = { ...turn('A', 400), text: `${'x'.repeat(399)}?` }
    const turns = [turn('A', 400), turn('B', 400), q, turn('B', 400), turn('A', 400)]
    expect(unitsForMultiSpeaker(turns, [5], 1300).map((u) => u.turnIndexes)).toEqual([
      [0, 1],
      [2, 3, 4],
    ])
    // a question that would overflow the next run with its follower stays where it is
    const tight = [turn('A', 400), { ...turn('B', 700), text: `${'x'.repeat(699)}?` }, turn('A', 700)]
    expect(unitsForMultiSpeaker(tight, [3], 1100).map((u) => u.turnIndexes)).toEqual([[0, 1], [2]])
    // a lone question that would leave an empty run stays put
    const only = [{ ...turn('A', 900), text: `${'x'.repeat(899)}?` }, turn('B', 900)]
    expect(unitsForMultiSpeaker(only, [2], 1000).map((u) => u.turnIndexes)).toEqual([[0], [1]])
  })

  test('unitsPerTurn is the identity grouping', () => {
    expect(unitsPerTurn(3).map((u) => u.turnIndexes)).toEqual([[0], [1], [2]])
    expect(unitsPerTurn(0)).toEqual([])
  })
})

describe('multiSpeakerVoices', () => {
  const turn = (speaker: 'A' | 'B', name: string, voice: string): SynthTurnInput => ({
    text: 'Hallo.',
    speaker,
    speakerName: name,
    voice,
    languageCode: 'de',
  })

  test('labels are the host names, voices the host voices', () => {
    const turns = [turn('A', 'Jonas', 'Charon'), turn('B', 'Lena', 'Erinome')]
    const { voices, label } = multiSpeakerVoices(turns)
    expect(voices).toEqual([
      { speaker: 'Jonas', voiceName: 'Charon' },
      { speaker: 'Lena', voiceName: 'Erinome' },
    ])
    expect(label(turns[1] as SynthTurnInput)).toBe('Lena')
  })

  test('a repeated name falls back to the host ids', () => {
    const turns = [turn('A', 'Sam', 'Charon'), turn('B', 'Sam', 'Erinome')]
    const { voices, label } = multiSpeakerVoices(turns)
    expect(voices.map((v) => v.speaker)).toEqual(['A', 'B'])
    expect(turns.map(label)).toEqual(['A', 'B'])
  })

  test('a single-host script pads the missing host with its id and the default voice', () => {
    const { voices } = multiSpeakerVoices([turn('A', 'Jonas', 'Erinome')])
    expect(voices).toEqual([
      { speaker: 'Jonas', voiceName: 'Erinome' },
      { speaker: 'B', voiceName: 'Charon' },
    ])
  })
})

// ---------------------------------------------------------------------------
// synthesizeUnit over the fake IU
// ---------------------------------------------------------------------------

// The retry paths log a warning; keep the test output clean.
setProduceLogger({ warn: () => {}, error: () => {} })

let iu: FakeIu
afterEach(() => iu?.stop())

const calls = (events: UsageEvent[]) => events.filter((e): e is CallEvent => e.kind === 'call')

function scopeOf(handlers: Parameters<typeof startFakeIu>[0]) {
  iu = startFakeIu(handlers)
  const deps = testDeps(iu)
  return { deps, scope: createAudioScope(deps, { requestId: 'job-1', caller: 'podcast' }) }
}

interface GeminiBody {
  contents: Array<{ parts: Array<{ text: string; speechMetadata: { speaker: string; style?: string } }> }>
}
const geminiBodies = () => iu.requests.filter((r) => r.route === 'gemini').map((r) => r.json as unknown as GeminiBody)

describe('synthesizeUnit: gemini lane', () => {
  const lane: Extract<TtsLane, { kind: 'gemini' }> = {
    kind: 'gemini',
    routeId: 'audio.tts.gemini-flash',
    hostStyles: ['warm', 'calm'],
  }
  const gemini = () => geminiAudio(new Uint8Array(4800), { promptTokenCount: 20, candidatesTokenCount: 25 })

  test('one request per unit, per-host style, dense turn slowed, delivery style mapped', async () => {
    const { deps, scope } = scopeOf({ gemini })
    const segments: Segments = [
      {
        title: 'S1',
        turns: [
          { speaker: 'A', text: 'Hallo zusammen.' },
          { speaker: 'B', text: DENSE_TURN },
        ],
      },
      {
        title: 'S2',
        turns: [
          { speaker: 'A', text: 'Das ist neu für mich.', delivery: 'curious' },
          { speaker: 'B', text: 'Wirklich? Erzähl.', delivery: 'furious' },
          { speaker: 'A', text: 'Zwölf Euro fünfzig, drei Komma neun Prozent, hundert Euro.', delivery: 'serious' },
        ],
      },
    ]
    const turns = turnsForSynthesis(
      segments,
      [
        { id: 'A', name: 'Jonas', voice: 'Charon' },
        { id: 'B', name: 'Lena', voice: 'Erinome' },
      ],
      'de',
    )
    const units = unitsForMultiSpeaker(turns, [2, 3], 3000)
    expect(units).toHaveLength(2)

    const out = []
    for (const unit of units) out.push(await synthesizeUnit(scope, lane, turns, unit))

    expect(iu.requests.filter((r) => r.route === 'gemini')).toHaveLength(2)
    const [first, second] = geminiBodies()
    expect(first?.contents[0]?.parts.map((p) => p.speechMetadata)).toEqual([
      { speaker: 'Jonas', style: 'warm' },
      { speaker: 'Lena', style: DENSE_TURN_STYLE },
    ])
    expect(second?.contents[0]?.parts.map((p) => p.speechMetadata)).toEqual([
      { speaker: 'Jonas', style: DELIVERY_STYLES.curious },
      { speaker: 'Lena', style: 'calm' },
      { speaker: 'Jonas', style: DENSE_TURN_STYLE },
    ])
    expect(out[0]).toMatchObject({ sampleRate: 24_000, audioSeconds: 4800 / (2 * 24_000) })
    expect(out[0]?.pcm.byteLength).toBe(4800)
    expect(out[0]?.inputChars).toBe('Hallo zusammen.'.length + DENSE_TURN.length)
    expect(calls(deps.usage.events)).toHaveLength(2)
    expect(calls(deps.usage.events)[0]).toMatchObject({ requestId: 'job-1', routeId: 'audio.tts.gemini-flash' })
  })

  test('a 4xx is deterministic: not retried', async () => {
    const { scope } = scopeOf({ gemini: () => new Response('bad voice', { status: 400 }) })
    const turns = turnsForSynthesis([{ title: 'S', turns: [{ speaker: 'A', text: 'Hallo.' }] }], HOSTS, 'de')
    const error = await caught(synthesizeUnit(scope, lane, turns, { turnIndexes: [0] }))
    expect(error.message).toMatch(/HTTP 400/)
    expect(iu.requests.filter((r) => r.route === 'gemini')).toHaveLength(1)
    expect(scope.meta.retries).toBe(0)
  })

  test('a 5xx is retried once and the second answer wins', async () => {
    const { scope } = scopeOf({
      gemini: (_request, attempt) => (attempt === 1 ? new Response('boom', { status: 500 }) : gemini()),
    })
    const turns = turnsForSynthesis([{ title: 'S', turns: [{ speaker: 'A', text: 'Hallo.' }] }], HOSTS, 'de')
    const out = await synthesizeUnit(scope, lane, turns, { turnIndexes: [0] })
    expect(out.pcm.byteLength).toBe(4800)
    expect(iu.requests.filter((r) => r.route === 'gemini')).toHaveLength(2)
    expect(scope.meta.retries).toBe(1)
  })

  test('a second 5xx propagates: one retry only', async () => {
    const { scope } = scopeOf({ gemini: () => new Response('boom', { status: 500 }) })
    const turns = turnsForSynthesis([{ title: 'S', turns: [{ speaker: 'A', text: 'Hallo.' }] }], HOSTS, 'de')
    const error = await caught(synthesizeUnit(scope, lane, turns, { turnIndexes: [0] }))
    expect(error.message).toMatch(/HTTP 500/)
    expect(iu.requests.filter((r) => r.route === 'gemini')).toHaveLength(2)
  })

  test('a unit pointing past the turns throws before any request', async () => {
    const { scope } = scopeOf({ gemini })
    const error = await caught(synthesizeUnit(scope, lane, [], { turnIndexes: [3] }))
    expect(error.message).toContain('no turn at index 3')
    expect(iu.requests).toHaveLength(0)
  })
})

describe('synthesizeUnit: replicate lane', () => {
  const DELIVERY_URL = 'https://abc.replicate.delivery/out.mp3'
  // The default test media hands the delivered bytes back as PCM: 4800 bytes = 0.1 s at 24 kHz.
  const delivered = new Uint8Array(4800).fill(3)
  const succeeded = () =>
    Response.json({ id: 'p1', status: 'succeeded', output: DELIVERY_URL, metrics: { predict_time: 1 } })
  const handlers = () => ({ replicateCreate: succeeded, delivery: () => new Response(delivered) })
  const lane: Extract<TtsLane, { kind: 'replicate' }> = {
    kind: 'replicate',
    routeId: 'audio.tts.elevenlabs-v3',
    stability: 0.4,
    similarityBoost: 0.6,
    style: 0.1,
  }
  const predictionInputs = () =>
    iu.requests
      .filter((r) => r.route === 'replicateCreate')
      .map((r) => (r.json as { input: Record<string, unknown> }).input)

  test('one prediction per turn with its voice, speed, language and lane settings', async () => {
    const { deps, scope } = scopeOf(handlers())
    const hosts: [HostValue, HostValue] = [
      { id: 'A', name: 'Lena', voice: 'Rachel', speed: 1.0 },
      { id: 'B', name: 'Marco', voice: 'Roger', speed: 1.05 },
    ]
    const turns = turnsForSynthesis(
      [
        {
          title: 'S1',
          turns: [
            { speaker: 'A', text: DENSE_TURN },
            { speaker: 'B', text: 'Und hallo zurück.' },
          ],
        },
      ],
      hosts,
      'de',
    )
    const units = unitsPerTurn(turns.length)
    const out = []
    for (const unit of units) out.push(await synthesizeUnit(scope, lane, turns, unit))

    const inputs = predictionInputs()
    expect(inputs).toHaveLength(2)
    expect(inputs[0]).toMatchObject({
      prompt: DENSE_TURN,
      voice: 'Rachel',
      language_code: 'de',
      stability: 0.4,
      style: 0.1,
      similarity_boost: 0.6,
    })
    expect(inputs[0]?.speed).toBeCloseTo(0.94, 5)
    expect(inputs[1]).toMatchObject({ prompt: 'Und hallo zurück.', voice: 'Roger', speed: 1.05 })
    expect(out[1]).toMatchObject({ sampleRate: 24_000, inputChars: 'Und hallo zurück.'.length })
    expect(out[1]?.audioSeconds).toBeCloseTo(0.1, 5)
    expect(out[1]?.pcm.byteLength).toBe(4800)
    expect(calls(deps.usage.events)).toHaveLength(2)
  })

  test('a host without a speed sends none', async () => {
    const { scope } = scopeOf(handlers())
    const turns = turnsForSynthesis([{ title: 'S', turns: [{ speaker: 'A', text: 'Hallo.' }] }], HOSTS, 'de')
    await synthesizeUnit(scope, lane, turns, { turnIndexes: [0] })
    expect(predictionInputs()[0]).not.toHaveProperty('speed')
  })

  test("the same speaker's neighbours travel as previous/next text on a continuity route", async () => {
    const { scope } = scopeOf(handlers())
    const turns = turnsForSynthesis(
      [
        {
          title: 'S',
          turns: [
            { speaker: 'A', text: 'Erstens.' },
            { speaker: 'B', text: 'Dazwischen.' },
            { speaker: 'A', text: 'Zweitens.' },
            { speaker: 'A', text: 'Drittens.' },
          ],
        },
      ],
      HOSTS,
      'de',
    )
    await synthesizeUnit(scope, { ...lane, routeId: 'audio.tts.elevenlabs-flash' }, turns, { turnIndexes: [2] })
    expect(predictionInputs()[0]).toMatchObject({ previous_text: 'Erstens.', next_text: 'Drittens.' })
  })

  test('a ReplicateSynthError is retried once', async () => {
    const { scope } = scopeOf({
      ...handlers(),
      replicateCreate: (_request, attempt) =>
        attempt === 1 ? Response.json({ id: 'pf', status: 'failed', error: 'voice busy' }) : succeeded(),
    })
    const turns = turnsForSynthesis([{ title: 'S', turns: [{ speaker: 'A', text: 'Hallo.' }] }], HOSTS, 'de')
    const out = await synthesizeUnit(scope, lane, turns, { turnIndexes: [0] })
    expect(out.pcm.byteLength).toBe(4800)
    expect(predictionInputs()).toHaveLength(2)
    expect(scope.meta.retries).toBe(1)
  })

  test('a second ReplicateSynthError propagates as itself', async () => {
    const { scope } = scopeOf({
      ...handlers(),
      replicateCreate: () => Response.json({ id: 'pf', status: 'failed', error: 'voice not available' }),
    })
    const turns = turnsForSynthesis([{ title: 'S', turns: [{ speaker: 'A', text: 'Hallo.' }] }], HOSTS, 'de')
    const error = await caught(synthesizeUnit(scope, lane, turns, { turnIndexes: [0] }))
    expect(error).toBeInstanceOf(ReplicateSynthError)
    expect(predictionInputs()).toHaveLength(2)
  })

  test('a replicate unit must be exactly one turn', async () => {
    const { scope } = scopeOf(handlers())
    const turns = turnsForSynthesis(
      [
        {
          title: 'S',
          turns: [
            { speaker: 'A', text: 'Eins.' },
            { speaker: 'B', text: 'Zwei.' },
          ],
        },
      ],
      HOSTS,
      'de',
    )
    const error = await caught(synthesizeUnit(scope, lane, turns, { turnIndexes: [0, 1] }))
    expect(error.message).toContain('exactly one turn')
    expect(iu.requests).toHaveLength(0)
  })
})

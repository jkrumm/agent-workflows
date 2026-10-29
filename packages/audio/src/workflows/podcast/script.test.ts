import { describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ResolvedRoute } from '../../../../routes/src/index.ts'
import { lintNotes, lintSegments } from './lint.ts'
import {
  type ChatCall,
  type ChatReply,
  Llm,
  type ModelPort,
  type OnWireUsage,
  type RoundCall,
  type RoundReply,
} from './llm.ts'
import { log } from './log.ts'
import { planOutline, reviewDraft, reviseSegment, writeSegment, type House, type WriterOptions } from './room.ts'
import { type PodcastRouteId, resolvePodcastRoute } from './routes.ts'
import {
  baseSystemPrompt,
  buildEpisodeProfile,
  buildOutlineUserContent,
  buildReviewUserContent,
  buildRevisionUserContent,
  buildSegmentUserContent,
  extractJsonObject,
  lengthNotes,
  loadShowBible,
  loadVoiceGuide,
  normalizeOutlineTargets,
  type Outline,
  openingFrameOf,
  outlineAsks,
  outlinePrompt,
  PODCAST_TAGS,
  type PodcastHost,
  type PodcastScript,
  type PodcastScriptRequest,
  parseEpisodeMetadata,
  parseOutline,
  parseSegmentTurns,
  planSegmentCount,
  pruneUnrequestedDevices,
  type ReviewNote,
  reviewPrompt,
  revisionPrompt,
  SEGMENT_TURNS_SCHEMA,
  type ScriptSegment,
  sanitizeTurns,
  segmentNotesFor,
  segmentPrompt,
  withAssignedAsks,
  writeEpisodeMetadata,
} from './script.ts'
import { type Dossier, EMPTY_DOSSIER, type EpisodeBrief } from './types.ts'

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a value')
  return value
}

/** The error a promise rejects with; fails the test when it resolves. */
async function rejected(promise: Promise<unknown>): Promise<Error> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  if (!(error instanceof Error)) throw new Error('expected a rejection')
  return error
}

// ---------------------------------------------------------------------------
// Fixtures and a scripted ModelPort
// ---------------------------------------------------------------------------

const HOSTS: [PodcastHost, PodcastHost] = [
  { id: 'A', name: 'Lena', voice: 'voice-a' },
  { id: 'B', name: 'Marco', voice: 'voice-b' },
]

const BASE_BRIEF: EpisodeBrief = {
  format: 'Erklärstück',
  rationale: 'Die letzten Folgen waren Streitgespräche.',
  minutes: 12,
  segments: 3,
  roles: { A: 'erklärt die Rechnung', B: 'fragt für den Hörer nach' },
  tone: 'ruhig, konkret',
  humor: 'sparse',
  opening: 'Direkt rein mit dem Thema, kein Cold Open.',
  closing: 'Aufhören, wenn das Argument fertig ist.',
  rhythm: 'Lange Turns bei A, kurze Einwürfe bei B.',
  devices: [],
  avoid: [],
  glossaryPolicy: 'Namen erst als das einführen, was sie sind.',
  loadBearingFacts: [],
}
const briefWith = (overrides: Partial<EpisodeBrief>): EpisodeBrief => ({ ...BASE_BRIEF, ...overrides })

const BASE_REQUEST: PodcastScriptRequest = {
  source: 'Der Van kostet dreihundert Euro pro Nacht.',
  brief: 'Für einen Freund, der einen Roadtrip plant.',
  language: 'de',
  minutes: 12,
  hosts: HOSTS,
  series: 'Roadtrip Radio',
  dossier: EMPTY_DOSSIER,
  episodeBrief: BASE_BRIEF,
}
const reqWith = (over: Partial<PodcastScriptRequest>): PodcastScriptRequest => ({ ...BASE_REQUEST, ...over })

const RICH_DOSSIER: Dossier = {
  summary: 'Es geht um die Maut.',
  additions: [{ source: 'brain: Areas/Travel/Maut.md', text: 'Die Vignette gilt zehn Tage.' }],
  glossary: [{ term: 'ASFINAG', plain: 'die Firma, die Österreichs Autobahnen betreibt' }],
  priorCoverage: [{ episodeId: 'e1', title: 'Folge eins', covered: 'die Route über den Brenner' }],
  openQuestions: ['Gilt die Vignette auch für den Anhänger?'],
  toolCalls: [],
}

const OUTLINE_SEGMENTS = [
  { title: 'Cold open', goal: 'hook the listener', key_facts: ['fact A'], target_words: 100, tension: 'will it work' },
  { title: 'Middle', goal: 'explain the plan', key_facts: ['fact B'], target_words: 100, tension: 'is it enough time' },
  {
    title: 'Wrap-up',
    goal: 'close the episode',
    key_facts: ['fact C'],
    target_words: 100,
    tension: "what's left open",
  },
]
const outlineJson = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    title: 'Der Roadtrip-Plan',
    description: 'Eine kurze Beschreibung.',
    cover_prompt: 'A camper van on a coastal road at golden hour',
    genres: ['Travel'],
    segments: OUTLINE_SEGMENTS,
    ...extra,
  })

const PLAIN_OUTLINE: Outline = {
  title: 't',
  description: '',
  coverPrompt: '',
  genres: [],
  motif: '',
  throughLine: '',
  hook: '',
  reveals: [],
  digressions: [],
  segments: [{ title: 'S1', goal: 'g', keyFacts: ['f'], targetWords: 100, tension: 't' }],
}
const THREE_SEGMENT_OUTLINE = parseOutline(outlineJson())

const words = (n: number, word = 'wort'): string => Array.from({ length: n }, () => word).join(' ')
const turnsJson = (...texts: string[]) =>
  JSON.stringify({ turns: texts.map((text, i) => ({ speaker: i % 2 === 0 ? 'A' : 'B', text })) })

const reply = (text: string, stop: ChatReply['stop'] = 'complete'): ChatReply => ({ text, stop })

type ChatHandler = (call: ChatCall, n: number) => ChatReply | Error
type RoundHandler = (call: RoundCall, n: number) => RoundReply | Error

class FakePort implements ModelPort {
  readonly chats: ChatCall[] = []
  readonly rounds: RoundCall[] = []
  constructor(
    private readonly onChat: ChatHandler = () => new Error('FakePort: chat not expected'),
    private readonly onRound: RoundHandler = () => new Error('FakePort: round not expected'),
  ) {}

  async chat(call: ChatCall, _signal: AbortSignal, onUsage: OnWireUsage): Promise<ChatReply> {
    this.chats.push(structuredClone(call))
    const out = this.onChat(call, this.chats.length)
    onUsage({ model: 'fake-model', tokens: { input: 10, output: 5, cacheRead: 0, reasoning: 0 }, cost: 0.001 })
    if (out instanceof Error) throw out
    return out
  }

  async round(call: RoundCall, _signal: AbortSignal, onUsage: OnWireUsage): Promise<RoundReply> {
    this.rounds.push(structuredClone(call))
    const out = this.onRound(call, this.rounds.length)
    onUsage({ model: 'fake-model', tokens: { input: 10, output: 5, cacheRead: 0, reasoning: 0 }, cost: 0.001 })
    if (out instanceof Error) throw out
    return out
  }
}

const chatRoute =
  (over: Partial<Record<PodcastRouteId, Partial<ResolvedRoute>>> = {}) =>
  (id: PodcastRouteId): ResolvedRoute => ({
    id,
    wire: 'iu-openai',
    model: 'fake-model',
    effort: 'high',
    ...over[id],
  })

const llmFor = (port: ModelPort, resolve = chatRoute(), signal = new AbortController().signal) =>
  new Llm(port, { addUsage: () => {}, signal, progress: () => {} }, resolve)

/** Scripted replies in order; once empty, the last one repeats. */
const sequence =
  (...replies: Array<ChatReply | Error>): ChatHandler =>
  (_call, n) =>
    replies[Math.min(n, replies.length) - 1] ?? new Error('empty script')

const HOUSE: House = { showBible: '', voice: '' }
const AGENTIC: WriterOptions = { agentic: true, maxUnitChars: 3000 }
const SINGLE_SHOT: WriterOptions = { agentic: false, maxUnitChars: 3000 }

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('planSegmentCount', () => {
  test('clamps to the 3..9 range around ~4 minutes per segment', () => {
    expect(planSegmentCount(1)).toBe(3)
    expect(planSegmentCount(12)).toBe(3)
    expect(planSegmentCount(20)).toBe(5)
    expect(planSegmentCount(100)).toBe(9)
  })
})

describe('buildEpisodeProfile', () => {
  const scriptWith = (segments: ScriptSegment[], extra: Partial<PodcastScript> = {}): PodcastScript => ({
    title: 't',
    description: 'd',
    coverPrompt: 'c',
    genres: [],
    language: 'de',
    segments,
    wordCount: 0,
    topics: ['Maut', 'Van'],
    ...extra,
  })

  test('computes lead from the word share and copies the brief decisions', () => {
    const profile = buildEpisodeProfile({
      brief: briefWith({ format: 'Erklärstück', humor: 'none', opening: 'Direkt rein.', minutes: 9 }),
      script: scriptWith([
        {
          title: 'S1',
          turns: [
            { speaker: 'A', text: words(80) },
            { speaker: 'B', text: words(20) },
          ],
        },
      ]),
      dossier: EMPTY_DOSSIER,
    })
    expect(profile.lead).toBe('A')
    expect(profile.format).toBe('Erklärstück')
    expect(profile.humor).toBe('none')
    expect(profile.opening).toBe('Direkt rein.')
    expect(profile.minutes).toBe(9)
    expect(profile.segmentCount).toBe(1)
    expect(profile.topics).toEqual(['Maut', 'Van'])
    expect(profile.durationSeconds).toBeNull()
  })

  test('a share within 10 percentage points is balanced, beyond it is not', () => {
    const turns = (a: number, b: number): ScriptSegment[] => [
      {
        title: 'S1',
        turns: [
          { speaker: 'A', text: words(a) },
          { speaker: 'B', text: words(b) },
        ],
      },
    ]
    expect(
      buildEpisodeProfile({ brief: BASE_BRIEF, script: scriptWith(turns(55, 45)), dossier: EMPTY_DOSSIER }).lead,
    ).toBe('balanced')
    expect(
      buildEpisodeProfile({ brief: BASE_BRIEF, script: scriptWith(turns(44, 56)), dossier: EMPTY_DOSSIER }).lead,
    ).toBe('B')
  })

  test('an empty script is balanced rather than a division by zero', () => {
    const profile = buildEpisodeProfile({ brief: BASE_BRIEF, script: scriptWith([]), dossier: EMPTY_DOSSIER })
    expect(profile.lead).toBe('balanced')
    expect(profile.segmentCount).toBe(0)
  })

  test("counts the dossier's tool calls, research calls separately, and carries the research spend", () => {
    const dossier: Dossier = {
      ...EMPTY_DOSSIER,
      researchUsd: 0.12345,
      toolCalls: [
        { tool: 'brain_search', args: {}, ok: true, ms: 5 },
        { tool: 'research', args: {}, ok: true, ms: 900 },
        { tool: 'research', args: {}, ok: false, ms: 900 },
      ],
    }
    const profile = buildEpisodeProfile({ brief: BASE_BRIEF, script: scriptWith([]), dossier })
    expect(profile.toolCalls).toBe(3)
    expect(profile.researchCalls).toBe(2)
    expect(profile.researchUsd).toBe(0.123)
  })

  describe('length and asks', () => {
    const ASK = 'Darf ich rohe Karotten ungewaschen essen?'
    const brief = briefWith({ asks: [ASK] })
    const dossier = { ...EMPTY_DOSSIER }
    const oneSegment = (wordCount: number, extra: Partial<PodcastScript> = {}) =>
      scriptWith([{ title: 'S', turns: [{ speaker: 'A', text: words(wordCount, 'kiwi') }] }], extra)

    test('an episode under 80% of the requested length is flagged short, one near it is not', () => {
      // 15 minutes at 145 words per minute plan for 2175 words.
      const short = buildEpisodeProfile({ brief, script: oneSegment(1500), dossier, requestedMinutes: 15 })
      expect(short.lengthShort).toBe(true)
      expect(short.lengthVsRequested).toBeLessThan(0.8)
      const fine = buildEpisodeProfile({ brief, script: oneSegment(2300), dossier, requestedMinutes: 15 })
      expect(fine.lengthShort).toBe(false)
      expect(fine.requestedMinutes).toBe(15)
    })

    test('the profile counts uncovered asks and whether the opening framed the question', () => {
      const profile = buildEpisodeProfile({
        brief,
        script: oneSegment(40, { asks: [{ ask: ASK, segmentIndex: 0 }] }),
        dossier,
        requestedMinutes: 15,
      })
      expect(profile.asks).toEqual({ total: 1, uncovered: 1, openingFramed: false })
    })

    test('an answered, framed ask counts as covered', () => {
      const answered = scriptWith([
        {
          title: 'S',
          turns: [
            { speaker: 'A', text: 'Rohe Karotten ungewaschen essen? Ja, das geht, solange die Erde ab ist.' },
            { speaker: 'B', text: 'Und die Schale?' },
          ],
        },
      ])
      const profile = buildEpisodeProfile({
        brief,
        script: { ...answered, asks: [{ ask: ASK, segmentIndex: 0 }] },
        dossier,
      })
      expect(profile.asks).toEqual({ total: 1, uncovered: 0, openingFramed: true })
    })

    test('a script without ask assignments is reported unchecked, not clean', () => {
      const profile = buildEpisodeProfile({ brief, script: oneSegment(40), dossier, requestedMinutes: 15 })
      expect(profile.asks).toEqual({ total: 1, uncovered: null, openingFramed: null })
    })

    test('no asks → no asks field; no requested minutes → no length verdict', () => {
      const profile = buildEpisodeProfile({ brief: briefWith({ asks: [] }), script: oneSegment(40), dossier })
      expect(profile.lengthShort).toBeUndefined()
      expect(profile.asks).toBeUndefined()
    })
  })
})

describe('parseOutline', () => {
  test('parses a clean JSON object', () => {
    const outline = parseOutline(
      outlineJson({ motif: 'the broken coffee machine', segments: [{ ...OUTLINE_SEGMENTS[0] }] }),
    )
    expect(outline.title).toBe('Der Roadtrip-Plan')
    expect(outline.motif).toBe('the broken coffee machine')
    expect(outline.segments).toHaveLength(1)
    expect(outline.segments[0]?.keyFacts).toEqual(['fact A'])
  })

  test('tolerates a fenced JSON block with leading prose', () => {
    const outline = parseOutline(
      `Sure, here is the outline:\n\`\`\`json\n${outlineJson()}\n\`\`\`\nLet me know if you need changes.`,
    )
    expect(outline.title).toBe('Der Roadtrip-Plan')
    expect(outline.segments).toHaveLength(3)
  })

  test('throws when segments are missing', () => {
    expect(() => parseOutline(JSON.stringify({ title: 'T' }))).toThrow()
  })

  test('parses the dramaturgy fields when present', () => {
    const outline = parseOutline(
      outlineJson({
        through_line: 'Will the van actually make the mountain pass?',
        hook: "The mechanic just said the word 'maybe'.",
        reveals: [{ text: 'The pass has a weight limit.', segment: 1 }],
        digressions: [
          { beat: 'A story about a flat tyre in Portugal.', segment: 0, return_hook: 'Anyway, back to the van.' },
        ],
      }),
    )
    expect(outline.throughLine).toBe('Will the van actually make the mountain pass?')
    expect(outline.hook).toBe("The mechanic just said the word 'maybe'.")
    expect(outline.reveals).toEqual([{ text: 'The pass has a weight limit.', segmentIndex: 1 }])
    expect(outline.digressions).toEqual([
      { beat: 'A story about a flat tyre in Portugal.', segmentIndex: 0, returnHook: 'Anyway, back to the van.' },
    ])
  })

  test('defaults the dramaturgy fields to empty when absent', () => {
    const outline = parseOutline(outlineJson())
    expect(outline.throughLine).toBe('')
    expect(outline.hook).toBe('')
    expect(outline.reveals).toEqual([])
    expect(outline.digressions).toEqual([])
  })

  test('accepts an outline that deliberately declines every dramaturgy device', () => {
    const outline = parseOutline(
      outlineJson({
        motif: '',
        through_line: '',
        hook: '',
        reveals: [],
        digressions: [],
        segments: [{ title: 'S1', goal: 'g', key_facts: [], target_words: 700, tension: '' }],
      }),
    )
    expect(outline.motif).toBe('')
    expect(outline.hook).toBe('')
    expect(outline.throughLine).toBe('')
    expect(outline.reveals).toEqual([])
    expect(outline.digressions).toEqual([])
    expect(outline.segments).toHaveLength(1)
  })

  test('clamps a reveal/digression segment index onto a real segment', () => {
    const outline = parseOutline(
      outlineJson({
        reveals: [{ text: 'Out of range reveal', segment: 99 }],
        digressions: [{ beat: 'Out of range digression', segment: -5, return_hook: 'back' }],
        segments: [{ title: 'S1', goal: 'g', key_facts: [], target_words: 100, tension: 't' }],
      }),
    )
    expect(outline.reveals).toEqual([{ text: 'Out of range reveal', segmentIndex: 0 }])
    expect(outline.digressions).toEqual([{ beat: 'Out of range digression', segmentIndex: 0, returnHook: 'back' }])
  })

  test('reads `answers` per segment', () => {
    const outline = parseOutline(
      outlineJson({ segments: [{ ...OUTLINE_SEGMENTS[0], answers: ['Frage eins?'] }, { ...OUTLINE_SEGMENTS[1] }] }),
    )
    expect(outline.segments[0]?.answers).toEqual(['Frage eins?'])
  })
})

describe('pruneUnrequestedDevices', () => {
  const withAllDevices: Outline = {
    title: 'T',
    description: 'D',
    coverPrompt: 'P',
    genres: [],
    motif: 'the broken coffee machine',
    throughLine: 'Will the van make the pass?',
    hook: "The mechanic just said the word 'maybe'.",
    reveals: [{ text: 'The pass has a weight limit.', segmentIndex: 1 }],
    digressions: [
      { beat: 'A story about a flat tyre in Portugal.', segmentIndex: 0, returnHook: 'Anyway, back to the van.' },
    ],
    segments: [{ title: 'S1', goal: 'g', keyFacts: [], targetWords: 100, tension: 't' }],
  }

  test('blanks hook, motif, reveals and digressions when the brief lists no devices', () => {
    const pruned = pruneUnrequestedDevices(withAllDevices, briefWith({ devices: [] }))
    expect(pruned.hook).toBe('')
    expect(pruned.motif).toBe('')
    expect(pruned.reveals).toEqual([])
    expect(pruned.digressions).toEqual([])
    expect(pruned.throughLine).toBe(withAllDevices.throughLine)
    expect(pruned.title).toBe(withAllDevices.title)
  })

  test('keeps only the devices the brief actually asked for', () => {
    const pruned = pruneUnrequestedDevices(
      withAllDevices,
      briefWith({
        devices: ['One genuine live disagreement between the hosts', 'Withheld: the total cost until the end'],
      }),
    )
    expect(pruned.reveals).toEqual(withAllDevices.reveals)
    expect(pruned.hook).toBe('')
    expect(pruned.motif).toBe('')
    expect(pruned.digressions).toEqual([])
  })
})

describe('parseSegmentTurns', () => {
  test('parses clean turns', () => {
    expect(parseSegmentTurns(turnsJson('Hallo.', 'Hi.'))).toEqual([
      { speaker: 'A', text: 'Hallo.' },
      { speaker: 'B', text: 'Hi.' },
    ])
  })

  test("strips a leaked 'Lena:' style label the model repeated in the text", () => {
    const turns = parseSegmentTurns(JSON.stringify({ turns: [{ speaker: 'A', text: 'Lena: Das ist spannend.' }] }))
    expect(turns).toEqual([{ speaker: 'A', text: 'Das ist spannend.' }])
  })

  test('tolerates fenced JSON with leading prose and drops empty turns', () => {
    const raw = `Here you go:\n\`\`\`json\n${JSON.stringify({
      turns: [
        { speaker: 'A', text: '' },
        { speaker: 'B', text: 'Echt jetzt?' },
      ],
    })}\n\`\`\``
    expect(parseSegmentTurns(raw)).toEqual([{ speaker: 'B', text: 'Echt jetzt?' }])
  })

  test('keeps a normalized delivery and omits an empty one', () => {
    const turns = parseSegmentTurns(
      JSON.stringify({
        turns: [
          { speaker: 'A', text: 'Hallo.', delivery: ' Curious ' },
          { speaker: 'B', text: 'Hi.', delivery: '' },
        ],
      }),
    )
    expect(turns).toEqual([
      { speaker: 'A', text: 'Hallo.', delivery: 'curious' },
      { speaker: 'B', text: 'Hi.' },
    ])
  })
})

describe('sanitizeTurns', () => {
  test('removes a disallowed tag but keeps an allowed one', () => {
    const [t1, t2] = sanitizeTurns([
      { speaker: 'A', text: '[not-a-real-tag] Hallo da.' },
      {
        speaker: 'B',
        text: `Na klar, das ist genau der Punkt. ${PODCAST_TAGS[0]} Und deshalb rechnen wir das jetzt einmal komplett durch, Schritt für Schritt.`,
      },
    ])
    expect(t1?.text).toBe('Hallo da.')
    expect(t2?.text).toContain(PODCAST_TAGS[0] ?? '')
  })

  test('strips markdown and bullets, leaves digits untouched', () => {
    const [t1] = sanitizeTurns([{ speaker: 'A', text: '- **330** Euro pro Nacht, klar?' }])
    expect(t1?.text).toBe('330 Euro pro Nacht, klar?')
  })

  test('splits a long turn at sentence boundaries, keeping the same speaker', () => {
    const sentence = 'Das ist ein Satz mit genug Inhalt, um Platz zu brauchen.'
    const out = sanitizeTurns(
      [{ speaker: 'A', text: `${sentence} ${sentence} ${sentence} ${sentence} ${sentence}` }],
      100,
    )
    expect(out.length).toBeGreaterThan(1)
    for (const t of out) {
      expect(t.speaker).toBe('A')
      expect(t.text.length).toBeLessThanOrEqual(100 + sentence.length)
    }
    expect(out.map((t) => t.text).join(' ')).toContain('Das ist ein Satz')
  })

  test('a split turn carries its delivery on the first piece only', () => {
    const long = Array.from({ length: 6 }, (_, i) => `Das ist Satz Nummer ${i} mit etwas Länge dabei.`).join(' ')
    const out = sanitizeTurns([{ speaker: 'A', text: long, delivery: 'serious' }], 80)
    expect(out.length).toBeGreaterThan(1)
    expect(out[0]?.delivery).toBe('serious')
    expect(out.slice(1).every((t) => t.delivery === undefined)).toBe(true)
  })

  test('merges a short fragment into its same-speaker predecessor', () => {
    const out = sanitizeTurns([
      { speaker: 'A', text: 'Echt?' },
      { speaker: 'A', text: 'Das habe ich nicht erwartet.' },
    ])
    expect(out).toHaveLength(1)
    expect(out[0]?.text).toBe('Echt? Das habe ich nicht erwartet.')
  })

  test('does not merge across a speaker change', () => {
    const out = sanitizeTurns([
      { speaker: 'A', text: 'Echt?' },
      { speaker: 'B', text: 'Ja, wirklich.' },
    ])
    expect(out).toHaveLength(2)
  })

  test('does not merge a short fragment when the merge would exceed maxChars', () => {
    const almostFull = 'x'.repeat(38)
    const out = sanitizeTurns(
      [
        { speaker: 'A', text: almostFull },
        { speaker: 'A', text: 'Echt?' },
      ],
      40,
    )
    expect(out).toHaveLength(2)
    expect(out[0]?.text).toBe(almostFull)
    expect(out[1]?.text).toBe('Echt?')
  })

  test('removes a bracketed stage direction longer than the old 30-char cap', () => {
    const direction = '[a very long stage direction that runs well past thirty characters]'
    const [turn] = sanitizeTurns([{ speaker: 'A', text: `${direction} Hallo da.` }])
    expect(turn?.text).toBe('Hallo da.')
  })

  test('a tag on a short interjection is dropped, on a long turn it stays', () => {
    const short = sanitizeTurns([{ speaker: 'B', text: '<laugh> Da ist sie.' }])
    expect(short[0]?.text).toBe('Da ist sie.')
    const long = sanitizeTurns([
      {
        speaker: 'A',
        text: 'Das ist der Punkt, den fast jeder übersieht. <sigh> Diesel kostet ungefähr das Dreifache von dem, was du an Maut zahlst, und genau das dreht die Planung um.',
      },
    ])
    expect(long[0]?.text).toContain('<sigh>')
  })
})

describe('German quote repair', () => {
  test('a „…" quote closed with an unescaped ASCII quote still parses', () => {
    const raw =
      '```json\n{"turns":[{"speaker":"B","text":"Und dann: „Er ist halt nicht witzig.""},{"speaker":"A","text":"Den nehme ich so."}]}\n```'
    expect(parseSegmentTurns(raw).map((t) => t.text)).toEqual([
      'Und dann: „Er ist halt nicht witzig.“',
      'Den nehme ich so.',
    ])
  })

  test('a repaired parse logs a warn with an excerpt', () => {
    const warn = spyOn(log, 'warn').mockImplementation(() => {})
    try {
      parseSegmentTurns('{"turns":[{"speaker":"B","text":"Und dann: „Er ist halt nicht witzig.""}]}')
      expect(warn).toHaveBeenCalledTimes(1)
      const fields = warn.mock.calls[0]?.[1] as { excerpt: string }
      expect(fields.excerpt).toContain('nicht witzig.“')
    } finally {
      warn.mockRestore()
    }
  })

  test('valid JSON does not log a repair warn', () => {
    const warn = spyOn(log, 'warn').mockImplementation(() => {})
    try {
      parseSegmentTurns('{"turns":[{"speaker":"A","text":"Er sagte „hallo"}]}')
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  test('invalid JSON the repair cannot fix is returned as-is, and the error comes from parsing it', () => {
    const warn = spyOn(log, 'warn').mockImplementation(() => {})
    try {
      const raw = '{"turns":[{"speaker":"B","text":"Und dann: „Er ist halt nicht witzig.""},'
      expect(extractJsonObject(raw)).toBe(raw.slice(0, raw.lastIndexOf('}') + 1))
      expect(() => parseSegmentTurns(raw)).toThrow(SyntaxError)
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  test('„ text with no ASCII quote to repair is untouched', () => {
    const raw = '{"turns":[{"speaker":"A","text":"Er sagte „hallo“ und ging"}'
    expect(extractJsonObject(raw)).toBe(raw)
  })

  test('valid JSON with a dangling „ is left untouched', () => {
    const raw = '{"turns":[{"speaker":"A","text":"Er sagte „hallo"},{"speaker":"B","text":"Ja."}]}'
    expect(parseSegmentTurns(raw).map((t) => t.text)).toEqual(['Er sagte „hallo', 'Ja.'])
  })

  test('extractJsonObject throws when there is no object at all', () => {
    expect(() => extractJsonObject('no braces here')).toThrow('expected a JSON object')
  })
})

describe('length governor', () => {
  test('normalizeOutlineTargets scales segment targets to the episode budget', () => {
    const outline: Outline = {
      ...PLAIN_OUTLINE,
      segments: [
        { title: 'a', goal: '', keyFacts: [], targetWords: 1000, tension: '' },
        { title: 'b', goal: '', keyFacts: [], targetWords: 3000, tension: '' },
      ],
    }
    expect(normalizeOutlineTargets(outline, 2000).segments.map((s) => s.targetWords)).toEqual([500, 1500])
  })

  test('lengthNotes flags only segments more than 20% over target', () => {
    const outline: Outline = {
      ...PLAIN_OUTLINE,
      segments: [
        { title: 'a', goal: '', keyFacts: [], targetWords: 100, tension: '' },
        { title: 'b', goal: '', keyFacts: [], targetWords: 100, tension: '' },
      ],
    }
    const notes = lengthNotes(
      [
        { title: 'ok', turns: [{ speaker: 'A', text: words(110) }] },
        {
          title: 'long',
          turns: [
            { speaker: 'A', text: words(90) },
            { speaker: 'B', text: words(60) },
          ],
        },
      ],
      outline,
    )
    expect(notes.map((n) => n.segmentIndex)).toEqual([1])
    expect(notes[0]?.note).toContain('150 words against a target of 100')
  })

  test('segmentNotesFor returns a segment’s own notes plus the episode-wide ones, or nothing', () => {
    const notes: ReviewNote[] = [
      { segmentIndex: 1, turnIndex: null, reviewer: 'r', note: 'own' },
      { segmentIndex: null, turnIndex: null, reviewer: 'r', note: 'global' },
      { segmentIndex: 2, turnIndex: null, reviewer: 'r', note: 'other' },
    ]
    expect(segmentNotesFor(notes, 1).map((n) => n.note)).toEqual(['own', 'global'])
    expect(segmentNotesFor(notes, 0)).toEqual([])
  })
})

describe('metadata parsing', () => {
  test('a blank field stays blank so the outline draft is kept for it', () => {
    const parsed = parseEpisodeMetadata('{"description":"Neu.","chapters":[{"segment":0,"title":"Kalt"}]}', 2)
    expect(parsed.title).toBe('')
    expect(parsed.description).toBe('Neu.')
    expect(parsed.chapters).toEqual([{ segmentIndex: 0, title: 'Kalt' }])
    expect(parsed.topics).toEqual([])
  })

  test('topics are trimmed and blanks dropped', () => {
    expect(parseEpisodeMetadata('{"topics":["  Maut ","", "Vignette", 7]}', 1).topics).toEqual(['Maut', 'Vignette'])
  })
})

describe('house texts', () => {
  test('loadShowBible reads a file, and resolves to "" with a warning when it is missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'podcast-show-bible-test-'))
    const path = join(dir, 'show-bible.md')
    writeFileSync(path, 'House style rules.')
    expect(await loadShowBible(path)).toBe('House style rules.')
    const warn = spyOn(log, 'warn').mockImplementation(() => {})
    try {
      expect(await loadShowBible(join(dir, 'missing.md'))).toBe('')
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  test('loadVoiceGuide reads a file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'podcast-voice-test-'))
    const path = join(dir, 'voice.md')
    writeFileSync(path, 'Verdict first.')
    expect(await loadVoiceGuide(path)).toBe('Verdict first.')
  })

  test('a missing voice guide resolves to "" and warns once per path', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'podcast-voice-missing-')), 'voice.md')
    const warn = spyOn(log, 'warn').mockImplementation(() => {})
    try {
      expect(await loadVoiceGuide(path)).toBe('')
      expect(await loadVoiceGuide(path)).toBe('')
      expect(warn.mock.calls.filter(([message]) => String(message).includes('voice guide not found'))).toHaveLength(1)
    } finally {
      warn.mockRestore()
    }
  })

  test('a non-ENOENT read error is logged as unreadable with its code, once per path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'podcast-voice-dir-'))
    const warn = spyOn(log, 'warn').mockImplementation(() => {})
    try {
      expect(await loadVoiceGuide(dir)).toBe('')
      expect(await loadVoiceGuide(dir)).toBe('')
      const lines = warn.mock.calls.filter(([message]) => String(message).includes('voice guide'))
      expect(lines).toHaveLength(1)
      expect(String(lines[0]?.[0])).toContain('unreadable')
      expect((lines[0]?.[1] as { code?: string } | undefined)?.code).toBe('EISDIR')
    } finally {
      warn.mockRestore()
    }
  })
})

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

describe('prompts', () => {
  test('the show bible is injected verbatim into the outline prompt; without one there is no section', () => {
    const withBible = outlinePrompt(BASE_REQUEST, 3, 1000, "# House Style\n\nHosts never say 'als KI'.")
    expect(withBible).toContain('SHOW BIBLE (house style — binding)')
    expect(withBible).toContain("Hosts never say 'als KI'.")
    expect(outlinePrompt(BASE_REQUEST, 3, 1000, '')).not.toContain('SHOW BIBLE')
  })

  test('the voice guide precedes the show bible in the outline and segment prompts, with the audio-override framing', () => {
    const prompts = [
      outlinePrompt(BASE_REQUEST, 3, 1000, "# House Style\n\nHosts never say 'als KI'.", '# Voice\n\nVerdict first.'),
      segmentPrompt({
        req: BASE_REQUEST,
        outline: PLAIN_OUTLINE,
        segment: must(PLAIN_OUTLINE.segments[0]),
        index: 0,
        total: 1,
        showBible: "# House Style\n\nHosts never say 'als KI'.",
        voice: '# Voice\n\nVerdict first.',
      }),
    ]
    for (const prompt of prompts) {
      expect(prompt).toContain("OWNER'S VOICE GUIDE")
      expect(prompt).toContain('overrides it for spoken audio')
      expect(prompt).toContain('ignore its markdown, layout, table, visual and image guidance')
      expect(prompt).toContain('Verdict first.')
      expect(prompt.indexOf('Verdict first.')).toBeLessThan(prompt.indexOf('SHOW BIBLE (house style — binding)'))
    }
  })

  test('a blank voice guide leaves the show bible alone', () => {
    const prompt = outlinePrompt(BASE_REQUEST, 3, 1000, '# House Style')
    expect(prompt).not.toContain('VOICE GUIDE')
    expect(prompt).toContain('SHOW BIBLE (house style — binding)')
  })

  test('the outline prompt takes segment count and word target from its arguments, not from the minutes', () => {
    const prompt = outlinePrompt(reqWith({ episodeBrief: briefWith({ segments: 1, minutes: 5 }) }), 1, 725, '')
    expect(prompt).toContain('Produce exactly 1 segments')
    expect(prompt).toContain('about 5 minutes')
    expect(prompt).toContain('about 725 words in total')
  })

  test("the brief's opening and closing replace the hardcoded cold open and takeaways", () => {
    const req = reqWith({
      episodeBrief: briefWith({
        opening: 'Straight in with the number nobody expected, no station intro.',
        closing: 'Stop when the argument is finished.',
      }),
    })
    const outline = THREE_SEGMENT_OUTLINE
    const segmentFor = (index: number) =>
      segmentPrompt({ req, outline, segment: must(outline.segments[index]), index, total: 3, showBible: '' })
    const prompts = [outlinePrompt(req, 3, 1000, ''), segmentFor(0), segmentFor(1), segmentFor(2)]
    for (const prompt of prompts) {
      expect(prompt).not.toContain('cold open plus a short intro')
      expect(prompt).not.toContain('three concrete takeaways')
      expect(prompt).not.toContain('one running joke or motif across the episode')
    }
    expect(prompts[0]).toContain('Straight in with the number nobody expected')
    expect(prompts[0]).toContain('Stop when the argument is finished.')
    expect(segmentFor(0)).toContain("the brief's OPENING is binding: Straight in with the number nobody expected")
    expect(segmentFor(0)).toContain('Do not add a cold open')
    expect(segmentFor(2)).toContain("the brief's CLOSING is binding: Stop when the argument is finished.")
    expect(segmentFor(2)).toContain('Do not add takeaways')
  })

  test('devices, avoid and the humor level are rendered only when the brief sets them', () => {
    const bare = outlinePrompt(
      reqWith({ episodeBrief: briefWith({ devices: [], avoid: [], humor: 'none' }) }),
      3,
      1000,
      '',
    )
    expect(bare).not.toContain('Devices to use')
    expect(bare).not.toContain('Avoid (patterns from recent episodes')
    expect(bare).toContain('Humor: none — write no jokes at all.')

    const rich = outlinePrompt(
      reqWith({
        episodeBrief: briefWith({
          devices: ['a motif: the broken coffee machine'],
          avoid: ['the number-then-Warte cold open'],
          humor: 'natural',
        }),
      }),
      3,
      1000,
      '',
    )
    expect(rich).toContain('Devices to use (and only these): a motif: the broken coffee machine')
    expect(rich).toContain('Avoid (patterns from recent episodes, do not repeat them): the number-then-Warte cold open')
    expect(rich).toContain('Humor: natural — let humor happen')
  })

  test("the dossier's additions, glossary, prior coverage and open questions reach the outline, segment and revision user content", () => {
    const req = reqWith({ dossier: RICH_DOSSIER })
    const outline = THREE_SEGMENT_OUTLINE
    const contents = [
      buildOutlineUserContent(req),
      buildSegmentUserContent({ req, outline, index: 0 }),
      buildRevisionUserContent({
        req,
        outline,
        segments: [{ title: 'S', turns: [{ speaker: 'A', text: 'Revised line.' }] }],
        index: 0,
        notes: [{ segmentIndex: 0, turnIndex: 0, reviewer: 'r', note: 'Tighten the opening line.' }],
      }),
    ]
    for (const content of contents) {
      expect(content).toContain('[brain: Areas/Travel/Maut.md]\nDie Vignette gilt zehn Tage.')
      expect(content).toContain('ASFINAG — die Firma, die Österreichs Autobahnen betreibt')
      expect(content).toContain('PRIOR COVERAGE (do not repeat')
      expect(content).toContain('Folge eins: die Route über den Brenner')
      expect(content).toContain('Gilt die Vignette auch für den Anhänger?')
    }
  })

  test('an empty dossier renders no ADDITIONS/GLOSSARY headings at all', () => {
    const content = buildOutlineUserContent(BASE_REQUEST)
    expect(content).not.toContain('ADDITIONS')
    expect(content).not.toContain('GLOSSARY')
    expect(content).not.toContain('PRIOR COVERAGE')
    expect(content).not.toContain('OPEN QUESTIONS')
  })

  test('the segment prompt leads with the base prompt the Anthropic wire caches', () => {
    const base = baseSystemPrompt(BASE_REQUEST, 'SHOW BIBLE', 'VOICE')
    const segment = segmentPrompt({
      req: BASE_REQUEST,
      outline: PLAIN_OUTLINE,
      segment: must(PLAIN_OUTLINE.segments[0]),
      index: 0,
      total: 1,
      showBible: 'SHOW BIBLE',
      voice: 'VOICE',
    })
    expect(segment.startsWith(base)).toBe(true)
    expect(segment.length).toBeGreaterThan(base.length)
  })

  test('the numbers-and-names non-negotiable is in every writer prompt', () => {
    const segment = must(PLAIN_OUTLINE.segments[0])
    const prompts = [
      outlinePrompt(BASE_REQUEST, 3, 1000, ''),
      segmentPrompt({ req: BASE_REQUEST, outline: PLAIN_OUTLINE, segment, index: 0, total: 1, showBible: '' }),
      revisionPrompt({ req: BASE_REQUEST, outline: PLAIN_OUTLINE, segment, index: 0, total: 1, showBible: '' }),
    ]
    for (const prompt of prompts) {
      expect(prompt).toContain('One figure per sentence')
      expect(prompt).toContain('Round, unless the precision IS the point')
      expect(prompt).toContain('WHAT IT IS before WHAT IT IS CALLED')
      expect(prompt).toContain('A genuine evidence gap is never admitted in the body of the episode')
      expect(prompt).not.toContain('the curious co-host')
      expect(prompt).toContain('comes from the EPISODE BRIEF below')
      expect(prompt).toContain('EVERY proper name, place, person, company, project, tool')
      expect(prompt).toContain('KNOWLEDGE SHARING')
      expect(prompt).toContain('Sharing is not chatter')
    }
  })

  test('an outline device the brief did not ask for never reaches the segment writers', async () => {
    const port = new FakePort(
      sequence(
        reply(
          outlineJson({
            hook: 'A concrete cold-open beat nobody asked for.',
            motif: 'an invented running joke',
            reveals: [{ text: 'A twist nobody asked for.', segment: 1 }],
            digressions: [{ beat: 'An anecdote nobody asked for.', segment: 0, return_hook: 'back to it' }],
          }),
        ),
      ),
    )
    const outline = await planOutline(llmFor(port), {
      req: reqWith({ episodeBrief: briefWith({ devices: [] }) }),
      house: HOUSE,
      segmentCount: 3,
      targetWords: 300,
      maxSegments: 9,
    })
    for (const index of [0, 1, 2]) {
      const system = segmentPrompt({
        req: BASE_REQUEST,
        outline,
        segment: must(outline.segments[index]),
        index,
        total: 3,
        showBible: '',
      })
      const user = buildSegmentUserContent({ req: BASE_REQUEST, outline, index })
      expect(system).not.toContain('Running motif of the episode')
      expect(user).not.toContain('HOOK (open this segment')
      expect(user).not.toContain('REVEALS TO LAND IN THIS SEGMENT')
      expect(user).not.toContain('DO NOT REVEAL YET')
      expect(user).not.toContain('DIGRESSION FOR THIS SEGMENT')
    }
  })

  test('the dramaturge reviews against the brief; the fact editor flags figure clusters and unintroduced names', () => {
    const req = reqWith({ episodeBrief: briefWith({ format: 'Kurzbriefing' }) })
    const dramaturge = reviewPrompt({ req, outline: PLAIN_OUTLINE, role: 'dramaturge', showBible: '' })
    const factEditor = reviewPrompt({ req, outline: PLAIN_OUTLINE, role: 'fact-editor', showBible: '' })
    expect(dramaturge).toContain('AGAINST ITS EPISODE BRIEF')
    expect(dramaturge).toContain('THE BRIEF THIS EPISODE OWES:')
    expect(dramaturge).toContain('Format: Kurzbriefing')
    expect(dramaturge).toContain('devices NOBODY asked for')
    expect(dramaturge).toContain('MANUFACTURED ARGUMENT')
    expect(factEditor).toContain('FIGURE CLUSTERS and UNINTRODUCED NAMES')
    expect(factEditor).toContain('before a host said what it IS in plain words')
    expect(factEditor).toContain('Judge as a STRANGER to these notes would')
  })

  test('the deterministic lint reaches the reviewers, and its stock-phrase findings reach the writer as notes', () => {
    const segments: ScriptSegment[] = [
      {
        title: 'S',
        turns: [
          { speaker: 'A', text: 'Nicht zuletzt zählt der Preis.' },
          { speaker: 'B', text: 'Und wer zahlt ihn?' },
        ],
      },
    ]
    const report = lintSegments(segments)
    const reviewContent = buildReviewUserContent({
      req: BASE_REQUEST,
      outline: PLAIN_OUTLINE,
      segments,
      lintReport: 'DETERMINISTIC LINT\nwords/turn',
    })
    expect(reviewContent).toContain('DETERMINISTIC LINT')
    expect(reviewContent).toContain('words/turn')
    const revision = buildRevisionUserContent({
      req: BASE_REQUEST,
      outline: PLAIN_OUTLINE,
      segments,
      index: 0,
      notes: lintNotes(report),
    })
    expect(revision).toContain('[lint]')
    expect(revision).toContain('Nicht zuletzt')
  })
})

describe('asks in the outline and prompts', () => {
  const ASK = 'Darf ich rohe Karotten ungewaschen essen?'
  const OTHER = 'Kann ich Kiwi mit Schale essen?'
  const askBrief = briefWith({ asks: [ASK, OTHER] })
  const askReq = reqWith({ episodeBrief: askBrief, source: 's' })

  test('openingFrameOf is empty when the brief has no asks, even with a through-line', () => {
    const outline = { ...PLAIN_OUTLINE, throughLine: 'Was ist mit der Schale?' }
    expect(openingFrameOf(briefWith({ asks: [] }), outline)).toEqual([])
    expect(openingFrameOf(briefWith({ asks: [ASK] }), outline)).toEqual([ASK, 'Was ist mit der Schale?'])
  })

  test('withAssignedAsks guarantees every ask a segment; outlineAsks reads the assignment back', () => {
    const outline = parseOutline(
      JSON.stringify({
        title: 'T',
        segments: [
          {
            title: 'Karotte roh',
            goal: 'Rohe Karotten ungewaschen',
            key_facts: [],
            target_words: 400,
            tension: '',
            answers: [ASK],
          },
          { title: 'Kiwi-Schale', goal: 'Schale', key_facts: [], target_words: 300, tension: '' },
        ],
      }),
    )
    const assigned = withAssignedAsks(outline, [ASK, OTHER])
    expect(assigned.segments.flatMap((s) => s.answers ?? [])).toEqual([ASK, OTHER])
    expect(outlineAsks(assigned)).toEqual([
      { ask: ASK, segmentIndex: 0 },
      { ask: OTHER, segmentIndex: 1 },
    ])
  })

  test('the owning segment lists its asks and the first segment frames the question', () => {
    const seg = { title: 'Karotte', goal: 'g', keyFacts: ['f'], targetWords: 300, tension: 't', answers: [ASK] }
    const outline: Outline = { ...PLAIN_OUTLINE, segments: [seg, { ...seg, answers: [] }] }
    const first = segmentPrompt({ req: askReq, outline, segment: seg, index: 0, total: 2, showBible: '' })
    expect(first).toContain('The listener ASKED these')
    expect(first).toContain(ASK)
    expect(first).toContain('Within the first 3 turns the hosts say plainly what this episode answers')
    const second = segmentPrompt({
      req: askReq,
      outline,
      segment: must(outline.segments[1]),
      index: 1,
      total: 2,
      previous: seg,
      showBible: '',
    })
    expect(second).not.toContain('The listener ASKED these')
  })

  test("the outline prompt carries the asks and the 'answers' field", () => {
    const prompt = outlinePrompt(askReq, 4, 1500, '')
    expect(prompt).toContain('LISTENER ASKS')
    expect(prompt).toContain(ASK)
    expect(prompt).toContain('"answers"')
  })
})

// ---------------------------------------------------------------------------
// Stages on a fake ModelPort (room.ts)
// ---------------------------------------------------------------------------

const hasSystem = (call: ChatCall, text: string) => call.system.includes(text)

describe('planOutline', () => {
  const params = { req: BASE_REQUEST, house: HOUSE, segmentCount: 3, targetWords: 300, maxSegments: 9 }

  test('writes the outline in one call on the outline route, with show bible and voice guide in the prompt', async () => {
    const port = new FakePort(sequence(reply(outlineJson())))
    const llm = llmFor(port)
    const outline = await planOutline(llm, { ...params, house: { showBible: 'Bible text.', voice: 'Voice text.' } })
    expect(outline.title).toBe('Der Roadtrip-Plan')
    expect(outline.segments.map((s) => s.title)).toEqual(['Cold open', 'Middle', 'Wrap-up'])
    expect(port.chats).toHaveLength(1)
    expect(hasSystem(must(port.chats[0]), 'You are writing the OUTLINE')).toBe(true)
    expect(hasSystem(must(port.chats[0]), 'Bible text.')).toBe(true)
    expect(hasSystem(must(port.chats[0]), 'Voice text.')).toBe(true)
    expect(port.chats[0]?.user).toContain('Der Van kostet dreihundert Euro pro Nacht.')
  })

  test('normalises the segment targets to the episode budget and assigns the brief’s asks', async () => {
    const ask = 'Darf ich den Van nachts abstellen?'
    const port = new FakePort(sequence(reply(outlineJson())))
    const outline = await planOutline(llmFor(port), {
      ...params,
      req: reqWith({ episodeBrief: briefWith({ asks: [ask] }) }),
      targetWords: 600,
    })
    expect(outline.segments.map((s) => s.targetWords)).toEqual([200, 200, 200])
    expect(outline.segments.flatMap((s) => s.answers ?? [])).toEqual([ask])
  })

  test('a truncated reply (stop = length) is retried with a larger budget, never parsed half-way', async () => {
    const port = new FakePort(sequence(reply('{"title":"Der Roadtrip', 'length'), reply(outlineJson())))
    const outline = await planOutline(llmFor(port), params)
    expect(outline.title).toBe('Der Roadtrip-Plan')
    expect(port.chats).toHaveLength(2)
    // writerBudget(8000, attempt): attempt 2 is strictly larger.
    expect(port.chats[1]?.maxTokens).toBeGreaterThan(port.chats[0]?.maxTokens ?? 0)
  })

  test('more segments than the room writes: cut first, then targets normalised and asks assigned to kept ones', async () => {
    const ask = 'Darf ich den Van nachts abstellen?'
    const port = new FakePort(sequence(reply(outlineJson())))
    const outline = await planOutline(llmFor(port), {
      ...params,
      maxSegments: 2,
      req: reqWith({ episodeBrief: briefWith({ asks: [ask] }) }),
      targetWords: 600,
    })
    expect(outline.segments).toHaveLength(2)
    // The whole budget on the kept segments, and the ask on one of them.
    expect(outline.segments.map((s) => s.targetWords)).toEqual([300, 300])
    expect(outline.segments.flatMap((s) => s.answers ?? [])).toEqual([ask])
  })

  test('an unparseable reply is retried once, then the stage fails', async () => {
    const port = new FakePort(sequence(reply('not json'), reply('still not json')))
    expect((await rejected(planOutline(llmFor(port), params))).message).toContain('expected a JSON object')
    expect(port.chats).toHaveLength(2)
  })
})

describe('writeSegment', () => {
  const CLEAN = [
    {
      speaker: 'A',
      text: `Der Dienst heißt Warden, er ist ein Dienst, der den Arbeitszustand hält. ${words(8, 'alpha')}`,
    },
    { speaker: 'B', text: 'Und wo läuft er?' },
    { speaker: 'A', text: `Auf dem Mini. ${words(6, 'beta')}` },
  ]
  const agentReq = reqWith({
    source: 'Der Dienst heißt Warden und läuft auf dem Mini.',
    dossier: { ...EMPTY_DOSSIER, glossary: [{ term: 'Warden', plain: 'ein Dienst, der Arbeitszustand hält' }] },
  })
  const agentOutline: Outline = {
    ...PLAIN_OUTLINE,
    segments: [{ title: 'Seg', goal: 'g', keyFacts: ['Warden läuft auf dem Mini.'], targetWords: 30, tension: 't' }],
  }
  const submit = (): RoundReply => ({
    message: {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'c1',
          type: 'function',
          function: { name: 'submit_segment', arguments: JSON.stringify({ turns: CLEAN }) },
        },
      ],
    },
    finishReason: 'tool_calls',
  })
  const segmentReply = reply(turnsJson('Segment eins Zeile eins von Lena.', 'Segment eins Zeile zwei von Marco.'))

  test('single-shot: one call on the write route with the cached prefix and the segment schema, sanitized turns', async () => {
    const port = new FakePort(sequence(segmentReply))
    const written = await writeSegment(llmFor(port), {
      req: BASE_REQUEST,
      outline: THREE_SEGMENT_OUTLINE,
      index: 1,
      house: { showBible: 'Bible.', voice: '' },
      writer: SINGLE_SHOT,
    })
    expect(written.agent).toBeNull()
    expect(written.turns.map((t) => t.speaker)).toEqual(['A', 'B'])
    expect(port.rounds).toHaveLength(0)
    const call = must(port.chats[0])
    expect(call.system).toContain('You are writing ONE SEGMENT (2 of 3)')
    expect(call.system.startsWith(call.cacheablePrefix ?? '\0')).toBe(true)
    expect(call.cacheablePrefix).toBe(baseSystemPrompt(BASE_REQUEST, 'Bible.', ''))
    expect(call.jsonSchema).toEqual(SEGMENT_TURNS_SCHEMA)
  })

  test('single-shot: markdown the model sneaks in is sanitized away', async () => {
    const port = new FakePort(sequence(reply(turnsJson('- **330** Euro pro Nacht, klar?'))))
    const written = await writeSegment(llmFor(port), {
      req: BASE_REQUEST,
      outline: THREE_SEGMENT_OUTLINE,
      index: 0,
      house: HOUSE,
      writer: SINGLE_SHOT,
    })
    expect(written.turns[0]?.text).toBe('330 Euro pro Nacht, klar?')
  })

  test('on the Anthropic wire an incomplete stop returns "" and the retry gets a larger budget', async () => {
    const port = new FakePort(
      sequence(
        reply('{"turns":[{"speaker":"A","text":"abgeschn', 'length'),
        reply('{"turns":[{"speaker":"A","text":"ganz"}]}'),
      ),
    )
    const written = await writeSegment(llmFor(port, chatRoute({ 'podcast.write': { wire: 'iu-anthropic' } })), {
      req: BASE_REQUEST,
      outline: THREE_SEGMENT_OUTLINE,
      index: 0,
      house: HOUSE,
      writer: SINGLE_SHOT,
    })
    expect(written.turns).toEqual([{ speaker: 'A', text: 'ganz' }])
    expect(port.chats).toHaveLength(2)
    expect(port.chats.every((c) => c.wire === 'iu-anthropic')).toBe(true)
    expect(port.chats[1]?.maxTokens).toBeGreaterThan(port.chats[0]?.maxTokens ?? 0)
  })

  test('the agentic writer delivers the segment through submit_segment; the single-shot call is not used', async () => {
    const port = new FakePort(undefined, () => submit())
    const written = await writeSegment(llmFor(port), {
      req: agentReq,
      outline: agentOutline,
      index: 0,
      house: HOUSE,
      writer: AGENTIC,
    })
    expect(written.turns.map((t) => t.speaker)).toEqual(['A', 'B', 'A'])
    expect(written.agent).toMatchObject({ mode: 'draft', fellBack: false, submits: 1 })
    expect(port.chats).toHaveLength(0)
  })

  test('a failing agent falls back to the single-shot draft for that segment', async () => {
    const port = new FakePort(sequence(segmentReply), () => new Error('agent exploded'))
    const written = await writeSegment(llmFor(port), {
      req: BASE_REQUEST,
      outline: THREE_SEGMENT_OUTLINE,
      index: 0,
      house: HOUSE,
      writer: AGENTIC,
    })
    expect(written.turns[0]?.text).toContain('Segment eins Zeile eins')
    expect(written.agent).toBeNull()
    expect(port.rounds).toHaveLength(1)
    expect(port.chats).toHaveLength(1)
  })

  test('a cancelled step rethrows the agent failure instead of falling back', async () => {
    const abort = new AbortController()
    const port = new FakePort(sequence(segmentReply), () => {
      abort.abort()
      return new Error('aborted')
    })
    expect(
      (
        await rejected(
          writeSegment(llmFor(port, chatRoute(), abort.signal), {
            req: BASE_REQUEST,
            outline: THREE_SEGMENT_OUTLINE,
            index: 0,
            house: HOUSE,
            writer: AGENTIC,
          }),
        )
      ).message,
    ).toContain('aborted')
    expect(port.chats).toHaveLength(0)
  })

  test('an outline index out of range throws', async () => {
    expect(
      (
        await rejected(
          writeSegment(llmFor(new FakePort()), {
            req: BASE_REQUEST,
            outline: THREE_SEGMENT_OUTLINE,
            index: 7,
            house: HOUSE,
            writer: SINGLE_SHOT,
          }),
        )
      ).message,
    ).toContain('out of range')
  })
})

describe('reviewDraft', () => {
  const segments: ScriptSegment[] = [
    {
      title: 'S1',
      turns: [
        { speaker: 'A', text: 'Erste Zeile.' },
        { speaker: 'B', text: 'Zweite Zeile?' },
      ],
    },
  ]
  const params = {
    req: BASE_REQUEST,
    outline: PLAIN_OUTLINE,
    segments,
    role: 'dramaturge' as const,
    route: 'podcast.review.a' as const,
    house: HOUSE,
    lintReport: 'LINT-REPORT',
  }
  const notesReply = reply(
    JSON.stringify({
      notes: [{ segment: 0, turn: 0, note: 'Open with the hook, not a summary.' }],
      verdict: 'Needs one fix in the cold open.',
    }),
  )

  test('returns the reviewer label, targeted notes and the verdict, on the review route', async () => {
    const port = new FakePort(sequence(notesReply))
    const result = await reviewDraft(llmFor(port), params)
    expect(result).toEqual({
      reviewer: `dramaturge@${resolvePodcastRoute('podcast.review.a').model}`,
      notes: [
        {
          segmentIndex: 0,
          turnIndex: 0,
          reviewer: `dramaturge@${resolvePodcastRoute('podcast.review.a').model}`,
          note: 'Open with the hook, not a summary.',
        },
      ],
      verdict: 'Needs one fix in the cold open.',
    })
    expect(hasSystem(must(port.chats[0]), 'You are the DRAMATURGE')).toBe(true)
    expect(port.chats[0]?.user).toContain('LINT-REPORT')
  })

  test('an episode-wide note has no segment', async () => {
    const port = new FakePort(
      sequence(
        reply(JSON.stringify({ notes: [{ segment: null, turn: null, note: 'Spell out amounts.' }], verdict: 'ok' })),
      ),
    )
    const result = await reviewDraft(llmFor(port), { ...params, role: 'fact-editor' })
    expect(result?.notes[0]).toMatchObject({ segmentIndex: null, turnIndex: null })
  })

  test('a truncated reply is retried; a reviewer that fails twice is skipped, not thrown', async () => {
    const retried = new FakePort(sequence(reply('{"notes":[', 'length'), notesReply))
    expect((await reviewDraft(llmFor(retried), params))?.verdict).toBe('Needs one fix in the cold open.')
    expect(retried.chats).toHaveLength(2)

    const failing = new FakePort(sequence(reply('prose only'), new Error('upstream down')))
    expect(await reviewDraft(llmFor(failing), params)).toBeNull()
  })

  test('a cancelled step rethrows instead of skipping the reviewer', async () => {
    const abort = new AbortController()
    const port = new FakePort(() => {
      abort.abort()
      return new Error('aborted')
    })
    expect((await rejected(reviewDraft(llmFor(port, chatRoute(), abort.signal), params))).message).toContain('aborted')
  })
})

describe('reviseSegment', () => {
  const draftSegments: ScriptSegment[] = [
    {
      title: 'Cold open',
      turns: [
        { speaker: 'A', text: 'Erste Zeile, noch ungeschliffen.' },
        { speaker: 'B', text: 'Und dann?' },
      ],
    },
  ]
  const outline: Outline = {
    ...PLAIN_OUTLINE,
    segments: [{ title: 'Cold open', goal: 'g', keyFacts: ['f'], targetWords: 100, tension: 't' }],
  }
  const notes: ReviewNote[] = [
    { segmentIndex: 0, turnIndex: 0, reviewer: 'dramaturge@m', note: 'Mehr Humor an der richtigen Stelle.' },
    { segmentIndex: null, turnIndex: null, reviewer: 'fact-editor@m', note: 'Beträge ausschreiben.' },
    { segmentIndex: 4, turnIndex: null, reviewer: 'x@m', note: 'gehört zu einem anderen Segment' },
  ]
  const params = { req: BASE_REQUEST, outline, segments: draftSegments, index: 0, notes, house: HOUSE }
  const revised = reply(turnsJson('Überarbeitete Zeile eins.', 'Überarbeitete Zeile zwei?'))

  test('single-shot: the revision prompt carries this segment’s notes and the episode-wide ones', async () => {
    const port = new FakePort(sequence(revised))
    const result = await reviseSegment(llmFor(port), { ...params, writer: SINGLE_SHOT })
    expect(result?.turns.map((t) => t.text)).toEqual(['Überarbeitete Zeile eins.', 'Überarbeitete Zeile zwei?'])
    expect(result?.agent).toBeNull()
    const call = must(port.chats[0])
    expect(call.system).toContain('You are REVISING ONE SEGMENT')
    expect(call.user).toContain('Mehr Humor an der richtigen Stelle.')
    expect(call.user).toContain('Beträge ausschreiben.')
    expect(call.user).not.toContain('gehört zu einem anderen Segment')
    expect(call.jsonSchema).toEqual(SEGMENT_TURNS_SCHEMA)
  })

  test('a failing agentic revision falls back to the single-shot revision', async () => {
    const port = new FakePort(sequence(revised), () => new Error('agent exploded'))
    const result = await reviseSegment(llmFor(port), { ...params, writer: AGENTIC })
    expect(result?.turns).toHaveLength(2)
    expect(port.rounds).toHaveLength(1)
    expect(port.chats).toHaveLength(1)
  })

  test('a revision that fails twice or comes back empty is null: the draft stands', async () => {
    const failing = new FakePort(sequence(reply('prose'), new Error('down')))
    expect(await reviseSegment(llmFor(failing), { ...params, writer: SINGLE_SHOT })).toBeNull()

    const empty = new FakePort(sequence(reply('{"turns":[]}')))
    expect(await reviseSegment(llmFor(empty), { ...params, writer: SINGLE_SHOT })).toBeNull()
  })

  test('a cancelled step rethrows instead of keeping the draft', async () => {
    const abort = new AbortController()
    const port = new FakePort(() => {
      abort.abort()
      return new Error('aborted')
    })
    expect(
      (await rejected(reviseSegment(llmFor(port, chatRoute(), abort.signal), { ...params, writer: SINGLE_SHOT })))
        .message,
    ).toContain('aborted')
  })
})

describe('writeEpisodeMetadata', () => {
  const segments: ScriptSegment[] = [
    { title: 'S1', turns: [{ speaker: 'A', text: 'Zeile.' }] },
    { title: 'S2', turns: [{ speaker: 'B', text: 'Noch eine.' }] },
  ]
  const metadataReply = reply(
    JSON.stringify({
      title: 'Der finale Titel',
      description: 'Die finale Beschreibung fürs Publikum.',
      cover_prompt: 'A painterly camper van on a coastal road at dusk',
      genres: ['Travel', 'Planning'],
      topics: ['Maut', 'Vignette', 'Van'],
      chapters: [
        { segment: 0, title: 'Der Aufbruch' },
        { segment: 1, title: 'Die Route' },
      ],
    }),
  )

  test('returns the sharpened title, description, cover prompt, genres, topics and chapter titles', async () => {
    const port = new FakePort(sequence(metadataReply))
    const metadata = await writeEpisodeMetadata(llmFor(port), { req: BASE_REQUEST, outline: PLAIN_OUTLINE, segments })
    expect(metadata).toEqual({
      title: 'Der finale Titel',
      description: 'Die finale Beschreibung fürs Publikum.',
      coverPrompt: 'A painterly camper van on a coastal road at dusk',
      genres: ['Travel', 'Planning'],
      topics: ['Maut', 'Vignette', 'Van'],
      chapters: [
        { segmentIndex: 0, title: 'Der Aufbruch' },
        { segmentIndex: 1, title: 'Die Route' },
      ],
    })
    expect(hasSystem(must(port.chats[0]), 'You are the final METADATA EDITOR')).toBe(true)
  })

  test('a reply that never parses fails the stage after one retry (the workflow keeps the outline drafts)', async () => {
    const port = new FakePort(sequence(reply('not JSON at all'), reply('still not')))
    expect(
      (await rejected(writeEpisodeMetadata(llmFor(port), { req: BASE_REQUEST, outline: PLAIN_OUTLINE, segments })))
        .message,
    ).toMatch(/\S/)
    expect(port.chats).toHaveLength(2)
  })
})

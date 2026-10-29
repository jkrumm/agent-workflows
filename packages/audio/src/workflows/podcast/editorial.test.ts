import { describe, expect, test } from 'bun:test'
import {
  decideEpisodeBrief,
  defaultEpisodeBrief,
  type EditorialInput,
  editorialSystemPrompt,
  minutesFloor,
  parseEpisodeBrief,
  playfulAsk,
  renderHistoryTable,
} from './editorial.ts'
import {
  type ChatCall,
  type ChatReply,
  Llm,
  type ModelPort,
  ModelError,
  type OnWireUsage,
  type RoundReply,
} from './llm.ts'
import type { PodcastHost } from './script.ts'
import { EMPTY_DOSSIER, type EpisodeSummary } from './types.ts'

/** The error a promise rejects with; fails the test when it resolves. */
async function rejected(promise: Promise<unknown>): Promise<Error> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  if (!(error instanceof Error)) throw new Error('expected a rejection')
  return error
}

type ChatStep = ChatReply | Error | ((call: ChatCall) => ChatReply)

/** A scripted ModelPort: each `chat` consumes the next step; every call is recorded. */
class FakePort implements ModelPort {
  readonly chats: ChatCall[] = []
  constructor(private readonly steps: ChatStep[]) {}

  async chat(call: ChatCall, _signal: AbortSignal, onUsage: OnWireUsage): Promise<ChatReply> {
    this.chats.push(structuredClone(call))
    const step = this.steps.shift()
    if (!step) throw new Error('FakePort: no scripted reply left')
    onUsage({ model: 'fake-model', tokens: { input: 100, output: 50, cacheRead: 0, reasoning: 0 }, cost: 0.01 })
    if (step instanceof Error) throw step
    return typeof step === 'function' ? step(call) : step
  }

  async round(): Promise<RoundReply> {
    throw new Error('FakePort: round not expected')
  }
}

const reply = (text: string): ChatReply => ({ text, stop: 'complete' })

function llmFor(steps: ChatStep[]): { llm: Llm; port: FakePort; usages: unknown[] } {
  const port = new FakePort(steps)
  const usages: unknown[] = []
  const llm = new Llm(port, {
    addUsage: (u) => usages.push(u),
    signal: new AbortController().signal,
    progress: () => {},
  })
  return { llm, port, usages }
}

const HOSTS: [PodcastHost, PodcastHost] = [
  { id: 'A', name: 'Jonas', voice: 'Rachel' },
  { id: 'B', name: 'Lena', voice: 'Roger' },
]

const INPUT: EditorialInput = {
  dossier: EMPTY_DOSSIER,
  source: 'Die Maut in Österreich kostet zwölf Euro fünfzig für zehn Tage.',
  brief: 'Für jemanden, der im August fährt.',
  language: 'de',
  minutes: 20,
  pinMinutes: false,
  bounds: { minMinutes: 3, maxMinutes: 60 },
  series: 'Brain Sonderausgabe',
  hosts: HOSTS,
  history: [],
  showBible: 'Jonas ist ruhig und präzise. Lena rechnet nach.',
}

const FULL_BRIEF_JSON = JSON.stringify({
  format: 'Kurzbriefing',
  rationale: 'Das Material ist technisch und kurz.',
  minutes: 7,
  segments: 2,
  roles: { A: 'führt durch die Rechnung', B: 'hakt bei den Zahlen nach' },
  tone: 'sachlich, dicht',
  humor: 'none',
  opening: 'Direkt rein, kein Cold Open.',
  closing: 'Aufhören, wenn die Rechnung steht.',
  rhythm: 'Lange Turns, wenige Wechsel.',
  devices: [],
  avoid: ["Zahl, dann 'Warte —'"],
  glossary_policy: 'Erst was es IST, dann wie es HEISST.',
})

describe('renderHistoryTable', () => {
  test('renders one row per episode with the axes the editor varies on', () => {
    const history: EpisodeSummary[] = [
      {
        id: 'job-1',
        createdAt: '2026-09-02T10:00:00.000Z',
        title: 'Obermenzing',
        description: 'd',
        profile: {
          format: 'Erklärstück',
          lead: 'A',
          humor: 'natural',
          opening: "Zahl, dann 'Warte —'",
          minutes: 22,
          durationSeconds: 1500,
          topics: ['Maut'],
          segmentCount: 5,
          toolCalls: 0,
          researchCalls: 0,
        },
      },
    ]
    const table = renderHistoryTable(history)
    expect(table).toContain('| Date | Title | Format | Lead | Humor | Opening | Minutes |')
    expect(table).toContain('|-|-|-|-|-|-|-|')
    expect(table).toContain("| 2026-09-02 | Obermenzing | Erklärstück | A | natural | Zahl, dann 'Warte —' | 22 |")
  })

  test('an episode from before the profile existed still gets a row', () => {
    const table = renderHistoryTable([
      { id: 'old', createdAt: '2026-08-01T00:00:00.000Z', title: 'Alt', description: '', profile: null },
    ])
    expect(table).toContain('| 2026-08-01 | Alt | — | — | — | — | — |')
  })

  test('escapes a pipe in a title so the table survives it', () => {
    const table = renderHistoryTable([
      { id: 'x', createdAt: '2026-08-01T00:00:00.000Z', title: 'A | B', description: '', profile: null },
    ])
    expect(table).toContain('A \\| B')
  })

  test('says so when there is no history', () => {
    expect(renderHistoryTable([])).toBe('(no previous episodes)')
  })
})

describe('defaultEpisodeBrief', () => {
  test('is a neutral conversation at the requested length — never the old formula', () => {
    const brief = defaultEpisodeBrief({ minutes: 20, language: 'de', hosts: HOSTS })
    expect(brief.minutes).toBe(20)
    expect(brief.segments).toBe(5) // planSegmentCount(20)
    expect(brief.humor).toBe('sparse')
    expect(brief.devices).toEqual([])
    expect(brief.avoid).toEqual([])
    expect(brief.loadBearingFacts).toEqual([])
    expect(brief.opening).toContain('Straight in with the topic')
    expect(brief.roles.A).toContain('Jonas')
    expect(brief.roles.B).toContain('Lena')
    expect(brief.format).toBe('Gespräch')
    expect(defaultEpisodeBrief({ minutes: 20, language: 'en', hosts: HOSTS }).format).toBe('Conversation')
  })
})

describe('parseEpisodeBrief — length floor and asks', () => {
  test('the editor cannot shorten a request by more than 20% (10 minutes for a 15-minute ask is raised to 12)', () => {
    const input = { ...INPUT, minutes: 15 }
    expect(parseEpisodeBrief(JSON.stringify({ minutes: 10 }), input).minutes).toBe(12)
    expect(parseEpisodeBrief(JSON.stringify({ minutes: 13 }), input).minutes).toBe(13)
    expect(parseEpisodeBrief(JSON.stringify({ minutes: 25 }), input).minutes).toBe(25)
    expect(parseEpisodeBrief(JSON.stringify({ minutes: 10 }), { ...input, pinMinutes: true }).minutes).toBe(15)
    expect(minutesFloor(15)).toBe(12)
  })

  test('asks are read as a string list, absent means none', () => {
    const withAsks = parseEpisodeBrief(
      JSON.stringify({ minutes: 20, asks: ['Darf ich Rohkost ungewaschen essen?', '  ', 3, 'Kiwi mit Schale essen?'] }),
      INPUT,
    )
    expect(withAsks.asks).toEqual(['Darf ich Rohkost ungewaschen essen?', 'Kiwi mit Schale essen?'])
    expect(parseEpisodeBrief(JSON.stringify({ minutes: 20 }), INPUT).asks).toEqual([])
  })

  test('the editor prompt owes the listener a frame and extracts asks', () => {
    const prompt = editorialSystemPrompt(INPUT)
    expect(prompt).toContain('the first lines must still tell the listener what this episode answers')
    expect(prompt).toContain('- asks:')
    expect(prompt).toContain('never shorten by dropping something the listener asked about')
  })

  test('load-bearing facts are read as {question, open_question} objects, absent means none', () => {
    const withFacts = parseEpisodeBrief(
      JSON.stringify({
        minutes: 20,
        load_bearing_facts: [
          {
            question: 'Gilt der Rückruf auch für Chargen vor 2025?',
            open_question: 'Gilt der Rückruf für ältere Chargen?',
          },
          { question: '  ' },
          3,
        ],
      }),
      INPUT,
    )
    expect(withFacts.loadBearingFacts).toEqual([
      { question: 'Gilt der Rückruf auch für Chargen vor 2025?', openQuestion: 'Gilt der Rückruf für ältere Chargen?' },
    ])
    expect(parseEpisodeBrief(JSON.stringify({ minutes: 20 }), INPUT).loadBearingFacts).toEqual([])
  })

  test('at most three load-bearing facts are kept, in the editor’s order', () => {
    const facts = ['a', 'b', 'c', 'd', 'e'].map((q) => ({ question: `Frage ${q}?` }))
    const parsed = parseEpisodeBrief(JSON.stringify({ minutes: 20, load_bearing_facts: facts }), INPUT)
    expect(parsed.loadBearingFacts.map((f) => f.question)).toEqual(['Frage a?', 'Frage b?', 'Frage c?'])
  })

  test('the editor prompt names load-bearing facts as the only route to standard-depth research', () => {
    const prompt = editorialSystemPrompt(INPUT)
    expect(prompt).toContain('- load_bearing_facts:')
    expect(prompt).toContain('Almost always empty')
  })
})

describe('parseEpisodeBrief', () => {
  test('parses a full reply', () => {
    const brief = parseEpisodeBrief(FULL_BRIEF_JSON, { ...INPUT, minutes: 8 })
    expect(brief.format).toBe('Kurzbriefing')
    expect(brief.minutes).toBe(7)
    expect(brief.segments).toBe(2)
    expect(brief.humor).toBe('none')
    expect(brief.roles).toEqual({ A: 'führt durch die Rechnung', B: 'hakt bei den Zahlen nach' })
    expect(brief.avoid).toEqual(["Zahl, dann 'Warte —'"])
    expect(brief.glossaryPolicy).toBe('Erst was es IST, dann wie es HEISST.')
  })

  test('tolerates fences and leading prose, and accepts camelCase glossaryPolicy', () => {
    const raw = `Here is the brief:\n\`\`\`json\n${JSON.stringify({ format: 'Interview', glossaryPolicy: 'Langsam einführen.' })}\n\`\`\``
    const brief = parseEpisodeBrief(raw, INPUT)
    expect(brief.format).toBe('Interview')
    expect(brief.glossaryPolicy).toBe('Langsam einführen.')
  })

  test('clamps minutes to the bounds and segments to 1..9', () => {
    const long = parseEpisodeBrief(JSON.stringify({ minutes: 900, segments: 40 }), INPUT)
    expect(long.minutes).toBe(60)
    expect(long.segments).toBe(9)
    const short = parseEpisodeBrief(JSON.stringify({ minutes: 1, segments: 0 }), { ...INPUT, minutes: 3 })
    expect(short.minutes).toBe(3)
    expect(short.segments).toBe(1)
  })

  test('a pinned request wins over whatever the editor argued for', () => {
    const brief = parseEpisodeBrief(JSON.stringify({ minutes: 5 }), { ...INPUT, pinMinutes: true })
    expect(brief.minutes).toBe(20)
  })

  test("a missing segments field is recomputed against the brief's OWN minutes, not the requested minutes", () => {
    // Requested (INPUT.minutes) is 20 -> planSegmentCount(20) would be 5, the
    // old buggy fallback. The editor argues for 50 minutes instead; segments
    // must follow THAT number: planSegmentCount(50) = 9.
    const brief = parseEpisodeBrief(JSON.stringify({ minutes: 50 }), INPUT)
    expect(brief.minutes).toBe(50)
    expect(brief.segments).toBe(9)
  })

  test('a missing segments field on a PINNED request is recomputed against the pinned minutes', () => {
    // The editor's own (ignored) minutes must not leak into the segment count either.
    const brief = parseEpisodeBrief(JSON.stringify({ minutes: 999 }), { ...INPUT, minutes: 8, pinMinutes: true })
    expect(brief.minutes).toBe(8)
    expect(brief.segments).toBe(3) // planSegmentCount(8)
  })

  test('an unknown or missing humor level falls back to sparse', () => {
    expect(parseEpisodeBrief(JSON.stringify({ humor: 'hilarious' }), INPUT).humor).toBe('sparse')
    expect(parseEpisodeBrief('{}', INPUT).humor).toBe('sparse')
    expect(parseEpisodeBrief(JSON.stringify({ humor: 'None' }), INPUT).humor).toBe('none')
  })

  test('missing fields fall back to the neutral default, not to the old formula', () => {
    const brief = parseEpisodeBrief('{}', INPUT)
    const fallback = defaultEpisodeBrief(INPUT)
    expect(brief.minutes).toBe(20)
    expect(brief.segments).toBe(fallback.segments)
    expect(brief.opening).toBe(fallback.opening)
    expect(brief.roles).toEqual(fallback.roles)
    expect(brief.devices).toEqual([])
    expect(brief.rationale).toBe('')
  })

  test('drops non-string and blank entries from devices/avoid', () => {
    const brief = parseEpisodeBrief(
      JSON.stringify({ devices: [' ein Motiv ', '', 7, null], avoid: 'not an array' }),
      INPUT,
    )
    expect(brief.devices).toEqual(['ein Motiv'])
    expect(brief.avoid).toEqual([])
  })

  test('throws only when there is no JSON object at all', () => {
    expect(() => parseEpisodeBrief("I'd rather not.", INPUT)).toThrow()
  })
})

describe('decideEpisodeBrief', () => {
  test('sends the show bible, the history table and the source head on the editorial route, and returns the parsed brief', async () => {
    const { llm, port, usages } = llmFor([reply(FULL_BRIEF_JSON)])

    const brief = await decideEpisodeBrief(llm, {
      ...INPUT,
      history: [
        {
          id: 'job-1',
          createdAt: '2026-09-02T10:00:00.000Z',
          title: 'Obermenzing',
          description: 'd',
          profile: {
            format: 'Erklärstück',
            lead: 'A',
            humor: 'natural',
            opening: "Zahl, dann 'Warte —'",
            minutes: 22,
            durationSeconds: null,
            topics: [],
            segmentCount: 5,
            toolCalls: 0,
            researchCalls: 0,
          },
        },
      ],
    })

    expect(port.chats).toHaveLength(1)
    expect(port.chats[0]?.model).toBe(llm.route('podcast.editorial').model)
    expect(usages).toHaveLength(1)
    expect(brief.format).toBe('Kurzbriefing')
    // The reply asks for 7 minutes against a 20-minute request: raised to the 80% floor.
    expect(brief.minutes).toBe(16)

    const systemPrompt = port.chats[0]?.system ?? ''
    const userContent = port.chats[0]?.user ?? ''
    expect(systemPrompt).toContain('You are the editor of "Brain Sonderausgabe"')
    expect(systemPrompt).toContain('You do not write the episode')
    expect(systemPrompt).toContain('Do not invent drama')
    expect(systemPrompt).toContain('Five minutes is a valid episode.')
    // The default is knowledge sharing; a debate needs a genuinely contested source and is varied against recent formats.
    expect(systemPrompt).toContain("Choose the episode's MODE first")
    expect(systemPrompt).toContain('The default is knowledge SHARING')
    expect(systemPrompt).toContain('A live disagreement belongs here only if the source is genuinely contested')
    expect(systemPrompt).toContain('Hosts: A = Jonas, B = Lena')
    expect(systemPrompt).toContain('The requested 20 minutes are the default')
    expect(systemPrompt).toContain('between 16 and 60 minutes')

    expect(userContent).toContain('SHOW BIBLE')
    expect(userContent).toContain('Jonas ist ruhig und präzise.')
    expect(userContent).toContain('| 2026-09-02 | Obermenzing | Erklärstück | A | natural |')
    expect(userContent).toContain('LISTENER BRIEF')
    expect(userContent).toContain('Die Maut in Österreich kostet zwölf Euro fünfzig')
  })

  test('a pinned length is stated as pinned in the prompt', async () => {
    const { llm, port } = llmFor([reply(FULL_BRIEF_JSON)])
    const brief = await decideEpisodeBrief(llm, { ...INPUT, pinMinutes: true })
    expect(port.chats[0]?.system).toContain('The length is PINNED at 20 minutes')
    expect(brief.minutes).toBe(20)
  })

  test('only the source head reaches the prompt', async () => {
    const { llm, port } = llmFor([reply(FULL_BRIEF_JSON)])
    await decideEpisodeBrief(llm, { ...INPUT, source: `${'x'.repeat(6000)}NEEDLE` })
    expect(port.chats[0]?.user).not.toContain('NEEDLE')
  })

  test("the dossier's summary, glossary, prior coverage and open questions are in the user content; empty sections are omitted", async () => {
    const full = llmFor([reply(FULL_BRIEF_JSON)])
    await decideEpisodeBrief(full.llm, {
      ...INPUT,
      dossier: {
        summary: 'Es geht um die Maut.',
        additions: [],
        glossary: [{ term: 'ASFINAG', plain: 'die Firma hinter Österreichs Autobahnen' }],
        priorCoverage: [{ episodeId: 'e1', title: 'Folge eins', covered: 'die Brenner-Route' }],
        openQuestions: ['Gilt das auch für den Anhänger?'],
        toolCalls: [],
      },
    })
    const userContent = full.port.chats[0]?.user ?? ''
    expect(userContent).toContain('Es geht um die Maut.')
    expect(userContent).toContain('ASFINAG — die Firma hinter Österreichs Autobahnen')
    expect(userContent).toContain('Folge eins: die Brenner-Route')
    expect(userContent).toContain('Gilt das auch für den Anhänger?')

    const bare = llmFor([reply(FULL_BRIEF_JSON)])
    await decideEpisodeBrief(bare.llm, INPUT)
    const bareContent = bare.port.chats[0]?.user ?? ''
    expect(bareContent).not.toContain('GLOSSARY')
    expect(bareContent).not.toContain('PRIOR COVERAGE')
    expect(bareContent).not.toContain('OPEN QUESTIONS')
    expect(bareContent).toContain('(no previous episodes)')
  })

  test('retries an unparseable reply once with a larger budget, then succeeds', async () => {
    const { llm, port } = llmFor([reply("I'd rather not."), reply(FULL_BRIEF_JSON)])
    const brief = await decideEpisodeBrief(llm, INPUT)
    expect(port.chats).toHaveLength(2)
    expect(port.chats[1]?.maxTokens ?? 0).toBe((port.chats[0]?.maxTokens ?? 0) * 2)
    expect(brief.format).toBe('Kurzbriefing')
  })

  test('a truncated or empty answer counts as unparseable and is retried', async () => {
    const { llm, port } = llmFor([{ text: '', stop: 'length' }, reply(FULL_BRIEF_JSON)])
    const brief = await decideEpisodeBrief(llm, INPUT)
    expect(port.chats).toHaveLength(2)
    expect(brief.format).toBe('Kurzbriefing')
  })

  test('falls back to the neutral default brief when the reply never parses', async () => {
    const { llm, port } = llmFor([reply('no json here'), reply('still no json')])
    const brief = await decideEpisodeBrief(llm, INPUT)
    expect(port.chats).toHaveLength(2)
    expect(brief).toEqual(defaultEpisodeBrief(INPUT))
  })

  test('falls back to the neutral default brief when the upstream errors, and never throws', async () => {
    const { llm } = llmFor([new ModelError('upstream exploded')])
    const brief = await decideEpisodeBrief(llm, INPUT)
    expect(brief).toEqual(defaultEpisodeBrief(INPUT))
  })

  test('a cancelled step rethrows instead of falling back', async () => {
    const abort = new AbortController()
    const port = new FakePort([new ModelError('cancelled')])
    const llm = new Llm(port, { addUsage: () => {}, signal: abort.signal, progress: () => {} })
    abort.abort()
    expect((await rejected(decideEpisodeBrief(llm, INPUT))).message).toContain('cancelled')
  })
})

describe("the listener brief binds the editor's humor", () => {
  const listenerBrief = 'Bitte verspielter und witzig, aber neugierig.'
  const input = {
    minutes: 15,
    pinMinutes: false,
    bounds: { minMinutes: 5, maxMinutes: 30 },
    language: 'de' as const,
    hosts: HOSTS,
    brief: listenerBrief,
  }

  test("a brief that asks for playful/funny raises the editor's 'sparse' to 'natural'", () => {
    expect(playfulAsk(listenerBrief)).toEqual(expect.arrayContaining(['verspielter', 'witzig']))
    const brief = parseEpisodeBrief(
      JSON.stringify({ format: 'Erklärstück', tone: 'Calm and concrete.', humor: 'sparse' }),
      input,
    )
    expect(brief.humor).toBe('natural')
    expect(brief.tone).toContain('verspielter')
  })

  test("a brief with no tone ask leaves the editor's humor alone; an editor already at 'natural' is untouched", () => {
    expect(playfulAsk('Ein technisches Briefing über Datenbanken.')).toEqual([])
    expect(
      parseEpisodeBrief(JSON.stringify({ format: 'x', humor: 'none' }), {
        ...input,
        brief: 'Ein technisches Briefing.',
      }).humor,
    ).toBe('none')
    expect(parseEpisodeBrief(JSON.stringify({ format: 'x', tone: 'Warm.', humor: 'natural' }), input).tone).toBe(
      'Warm.',
    )
  })
})

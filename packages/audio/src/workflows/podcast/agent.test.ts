import { describe, expect, test } from 'bun:test'
import { type AgentRun, createSegmentAgent } from './agent.ts'
import {
  type ChatCall,
  type ChatReply,
  Llm,
  type ModelPort,
  type OnWireUsage,
  type RoundCall,
  type RoundReply,
} from './llm.ts'
import type { BrainPort } from './ports.ts'
import { resolvePodcastRoute, type PodcastRouteId } from './routes.pending.ts'
import type { Outline, PodcastHost, PodcastScriptRequest, ScriptTurn } from './script.ts'
import { EMPTY_DOSSIER } from './types.ts'
import type { ResolvedRoute } from '../../../../routes/src/index.ts'

/** The error a promise rejects with; fails the test when it resolves. */
async function rejected(promise: Promise<unknown>): Promise<Error> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  if (!(error instanceof Error)) throw new Error('expected a rejection')
  return error
}

const HOSTS: [PodcastHost, PodcastHost] = [
  { id: 'A', name: 'Jonas', voice: 'voice-a' },
  { id: 'B', name: 'Lena', voice: 'voice-b' },
]
const REQ: PodcastScriptRequest = {
  source: 'Der Dienst heißt Warden und läuft auf dem Mini.',
  language: 'de',
  minutes: 10,
  hosts: HOSTS,
  series: 'Test',
  dossier: { ...EMPTY_DOSSIER, glossary: [{ term: 'Warden', plain: 'ein Dienst, der Arbeitszustand hält' }] },
  episodeBrief: {
    format: 'Gespräch',
    rationale: 'r',
    roles: { A: 'erklärt', B: 'fragt' },
    tone: 'ruhig',
    humor: 'none',
    opening: 'direkt',
    closing: 'offen',
    rhythm: 'gemischt',
    minutes: 10,
    segments: 1,
    devices: [],
    avoid: [],
    glossaryPolicy: '',
    loadBearingFacts: [],
  },
}
const SPEC = {
  title: 'Seg',
  goal: 'g',
  keyFacts: ['Warden läuft auf dem Mini.'],
  targetWords: 30,
  tension: 't',
}
const OUTLINE: Outline = {
  title: 'T',
  description: 'd',
  coverPrompt: 'c',
  genres: [],
  motif: '',
  throughLine: '',
  hook: '',
  reveals: [],
  digressions: [],
  segments: [SPEC],
}

const words = (n: number, prefix: string): string => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(' ')
const CLEAN = [
  {
    speaker: 'A',
    text: `Der Dienst heißt Warden, er ist ein Dienst, der den Arbeitszustand hält. ${words(8, 'alpha')}`,
  },
  { speaker: 'B', text: 'Und wo läuft er?' },
  { speaker: 'A', text: `Auf dem Mini. ${words(6, 'beta')}` },
]

const toolCall = (name: string, args: unknown, id = `c-${name}`): RoundReply => ({
  message: {
    role: 'assistant',
    content: '',
    tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  },
  finishReason: 'tool_calls',
})
const plainReply = (content: string): RoundReply => ({ message: { role: 'assistant', content }, finishReason: 'stop' })

/** A scripted ModelPort; every round is recorded with a snapshot of the messages it received. */
class ScriptedPort implements ModelPort {
  readonly rounds: RoundCall[] = []
  constructor(private readonly steps: RoundReply[]) {}
  async chat(_call: ChatCall, _signal: AbortSignal, _onUsage: OnWireUsage): Promise<ChatReply> {
    throw new Error('chat not expected')
  }
  async round(call: RoundCall, _signal: AbortSignal, onUsage: OnWireUsage): Promise<RoundReply> {
    this.rounds.push(structuredClone(call))
    const step = this.steps.shift()
    if (!step) throw new Error(`ScriptedPort: no reply scripted for round ${this.rounds.length}`)
    onUsage({ model: 'fake-model', tokens: { input: 10, output: 5, cacheRead: 0, reasoning: 0 }, cost: 0.001 })
    return step
  }
}

/** Chat-API route on an invented model, so the tests do not depend on the table. */
const chatRoute = (id: PodcastRouteId): ResolvedRoute => ({
  id,
  wire: 'iu-openai',
  model: 'fake-model',
  effort: 'high',
})

const llmFor = (port: ModelPort, resolve: (id: PodcastRouteId) => ResolvedRoute = chatRoute) =>
  new Llm(port, { addUsage: () => {}, signal: new AbortController().signal, progress: () => {} }, resolve)

const toolResult = (port: ScriptedPort, round: number): string => {
  const message = port.rounds[round]?.messages.find((m) => m.role === 'tool')
  return String(message?.content ?? '')
}

const draftWith = (
  port: ScriptedPort,
  onRun?: (run: AgentRun) => void,
  extra: { brain?: BrainPort; resolve?: (id: PodcastRouteId) => ResolvedRoute } = {},
) =>
  createSegmentAgent(llmFor(port, extra.resolve), {
    maxUnitChars: 3000,
    ...(extra.brain ? { brain: extra.brain } : {}),
    ...(onRun ? { onRun } : {}),
  }).draft({ req: REQ, outline: OUTLINE, index: 0, total: 1, showBible: '', voice: '' })

describe('segment agent', () => {
  test('measures with lint_segment, fixes, and ends the loop on an accepted submit', async () => {
    const runs: AgentRun[] = []
    const port = new ScriptedPort([
      toolCall('lint_segment', { turns: [{ speaker: 'A', text: 'Nicht zuletzt zählt der Preis.' }] }),
      toolCall('submit_segment', { turns: CLEAN }),
    ])
    const turns = await draftWith(port, (r) => runs.push(r))
    expect(turns.map((t) => t.speaker)).toEqual(['A', 'B', 'A'])
    expect(port.rounds).toHaveLength(2) // no closing round after ACCEPTED
    const lintResult = toolResult(port, 1)
    expect(lintResult).toContain('METRICS:')
    expect(lintResult).toContain('Stock phrase')
    expect(runs[0]).toMatchObject({ mode: 'draft', rejections: 0, fellBack: false })
  })

  test('runs on the podcast.write route', async () => {
    const asked: string[] = []
    const port = new ScriptedPort([toolCall('submit_segment', { turns: CLEAN })])
    await draftWith(port, undefined, {
      resolve: (id) => {
        asked.push(id)
        return chatRoute(id)
      },
    })
    expect(new Set(asked)).toEqual(new Set(['podcast.write']))
  })

  test('hands the loop three tools without a brain, five with one', async () => {
    const without = new ScriptedPort([toolCall('submit_segment', { turns: CLEAN })])
    await draftWith(without)
    expect(without.rounds[0]?.tools.map((t) => t.name)).toEqual(['lint_segment', 'glossary_lookup', 'submit_segment'])
    expect(String(without.rounds[0]?.messages[0]?.content)).not.toContain('brain_search')

    const brain: BrainPort = {
      search: async () => ({ matches: [], warnings: [] }),
      read: async () => ({ found: false, reason: 'none' }),
    }
    const withBrain = new ScriptedPort([toolCall('submit_segment', { turns: CLEAN })])
    await draftWith(withBrain, undefined, { brain })
    expect(withBrain.rounds[0]?.tools.map((t) => t.name)).toEqual([
      'lint_segment',
      'glossary_lookup',
      'brain_search',
      'brain_read',
      'submit_segment',
    ])
    expect(String(withBrain.rounds[0]?.messages[0]?.content)).toContain('brain_search/brain_read')
  })

  test('a blocking finding is rejected on submit until fixed', async () => {
    const bad = [{ speaker: 'A', text: `Nicht zuletzt zählt der Preis. ${words(10, 'gamma')}` }, ...CLEAN.slice(1)]
    const runs: AgentRun[] = []
    const port = new ScriptedPort([
      toolCall('submit_segment', { turns: bad }),
      toolCall('submit_segment', { turns: CLEAN }),
    ])
    await draftWith(port, (r) => runs.push(r))
    expect(toolResult(port, 1)).toContain('REJECTED — blocking')
    expect(runs[0]).toMatchObject({ submits: 2, rejections: 1 })
  })

  test('advisory findings are rejected once; accepting them with a reason lets the submit through', async () => {
    const short = [
      {
        speaker: 'A',
        text: `Warden ist ein Dienst, der den Arbeitszustand hält und auf dem Mini läuft. ${words(4, 'kurz')}`,
      },
    ]
    const reason = 'alle Kernfakten stehen drin, mehr wäre Füllstoff'
    const runs: AgentRun[] = []
    const port = new ScriptedPort([
      toolCall('submit_segment', { turns: short }),
      toolCall('submit_segment', { turns: short, acceptAdvisory: [{ rule: 'length-under', reason }] }),
    ])
    const turns = await draftWith(port, (r) => runs.push(r))
    expect(turns).toHaveLength(1)
    expect(toolResult(port, 1)).toContain('REJECTED once')
    expect(runs[0]?.accepted).toEqual([{ rule: 'length-under', reason }])
  })

  test('an unchanged resubmit of the same advisory findings goes through', async () => {
    const short = [
      {
        speaker: 'A',
        text: `Warden ist ein Dienst, der den Arbeitszustand hält und auf dem Mini läuft. ${words(4, 'kurz')}`,
      },
    ]
    const port = new ScriptedPort([
      toolCall('submit_segment', { turns: short }),
      toolCall('submit_segment', { turns: short }),
    ])
    const turns = await draftWith(port)
    expect(turns).toHaveLength(1)
    expect(port.rounds).toHaveLength(2)
  })

  test('a reason shorter than the minimum does not accept an advisory finding', async () => {
    const short = [
      {
        speaker: 'A',
        text: `Warden ist ein Dienst, der den Arbeitszustand hält und auf dem Mini läuft. ${words(4, 'kurz')}`,
      },
    ]
    const runs: AgentRun[] = []
    const port = new ScriptedPort([
      toolCall('submit_segment', { turns: short }),
      toolCall('submit_segment', { turns: short, acceptAdvisory: [{ rule: 'length-under', reason: 'passt' }] }),
    ])
    await draftWith(port, (r) => runs.push(r))
    // Rejected once, then the unchanged resubmit passes without the (too short) reason being recorded.
    expect(runs[0]?.accepted).toEqual([])
  })

  test('a model that stops without submitting falls back to its last measured draft', async () => {
    const runs: AgentRun[] = []
    const port = new ScriptedPort([toolCall('lint_segment', { turns: CLEAN }), plainReply('Fertig.')])
    const turns = await draftWith(port, (r) => runs.push(r))
    expect(turns).toHaveLength(3)
    expect(runs[0]).toMatchObject({ fellBack: true, submits: 0 })
  })

  test('a tag the sanitizer would silently strip is still a blocking finding on submit', async () => {
    const withInvented = [
      {
        speaker: 'A',
        text: `Der Dienst heißt Warden, er ist ein Dienst, der den Arbeitszustand hält. <sniff> ${words(8, 'alpha')}`,
      },
      ...CLEAN.slice(1),
    ]
    const first = new ScriptedPort([
      toolCall('submit_segment', { turns: withInvented }),
      toolCall('submit_segment', { turns: CLEAN }),
    ])
    await draftWith(first)
    expect(toolResult(first, 1)).toContain('not in the allowed list')

    const leading = [{ speaker: 'A', text: '<laugh> Ja.' }, ...CLEAN.slice(1)]
    const second = new ScriptedPort([
      toolCall('submit_segment', { turns: leading }),
      toolCall('submit_segment', { turns: CLEAN }),
    ])
    await draftWith(second)
    expect(toolResult(second, 1)).toContain('first word of a short line')
  })

  test('a loop that ends on a draft the gate rejects throws, so the caller falls back to the single-shot writer', async () => {
    const bad = [{ speaker: 'A', text: `Nicht zuletzt zählt der Preis. ${words(10, 'gamma')}` }, ...CLEAN.slice(1)]
    const runs: AgentRun[] = []
    const port = new ScriptedPort([toolCall('lint_segment', { turns: bad }), plainReply('Fertig.')])
    expect((await rejected(draftWith(port, (r) => runs.push(r)))).message).toMatch(/blocking finding/)
    expect(runs[0]).toMatchObject({ fellBack: true })
  })

  test('a segment over its target is blocked on length, under-length is not', async () => {
    const long = [
      {
        speaker: 'A',
        text: `Der Dienst heißt Warden, er ist ein Dienst, der den Arbeitszustand hält. ${words(80, 'lang')}`,
      },
      { speaker: 'B', text: 'Und wo läuft er?' },
    ]
    const port = new ScriptedPort([
      toolCall('submit_segment', { turns: long }),
      toolCall('submit_segment', { turns: CLEAN }),
    ])
    await draftWith(port)
    expect(toolResult(port, 1)).toContain('LENGTH:')
  })

  test('a model that never measured anything throws, so the caller can fall back to the single-shot writer', async () => {
    const port = new ScriptedPort([plainReply('Hier ist kein Tool-Aufruf.')])
    expect((await rejected(draftWith(port))).message).toMatch(/without a measured draft/)
  })

  test('a tool call with unusable turns is an error result the model can act on, not a crash', async () => {
    const port = new ScriptedPort([
      toolCall('lint_segment', { turns: [{ speaker: 'C', text: 'x' }] }),
      toolCall('submit_segment', { turns: CLEAN }),
    ])
    await draftWith(port)
    expect(toolResult(port, 1)).toContain('speaker must be "A" or "B"')
  })

  test('glossary_lookup answers from the dossier; the system prompt carries the tool workflow', async () => {
    const port = new ScriptedPort([
      toolCall('glossary_lookup', { term: 'warden' }),
      toolCall('submit_segment', { turns: CLEAN }),
    ])
    await draftWith(port)
    expect(toolResult(port, 1)).toContain('ein Dienst, der Arbeitszustand hält')
    expect(String(port.rounds[0]?.messages[0]?.content)).toContain('submit_segment is the only way to finish')
  })

  test('glossary_lookup says so when the dossier has nothing', async () => {
    const port = new ScriptedPort([
      toolCall('glossary_lookup', { term: 'unbekannt' }),
      toolCall('submit_segment', { turns: CLEAN }),
    ])
    await draftWith(port)
    expect(toolResult(port, 1)).toContain('nothing in the dossier for "unbekannt"')
  })

  test('a revision runs the same loop with the notes in its prompt', async () => {
    const port = new ScriptedPort([toolCall('submit_segment', { turns: CLEAN })])
    const runs: AgentRun[] = []
    const turns = await createSegmentAgent(llmFor(port), { maxUnitChars: 3000, onRun: (r) => runs.push(r) }).revise({
      req: REQ,
      outline: OUTLINE,
      segments: [{ title: 'Seg', turns: CLEAN as ScriptTurn[] }],
      index: 0,
      total: 1,
      notes: [
        { segmentIndex: 0, turnIndex: null, reviewer: 'dramaturge@m', note: 'Mehr Humor an der richtigen Stelle.' },
      ],
      showBible: '',
      voice: '',
    })
    expect(turns).toHaveLength(3)
    expect(String(port.rounds[0]?.messages[1]?.content)).toContain('Mehr Humor an der richtigen Stelle.')
    expect(String(port.rounds[0]?.messages[0]?.content)).toContain('REVISING ONE SEGMENT')
    expect(runs[0]).toMatchObject({ mode: 'revise', index: 0 })
  })

  test('an outline index out of range throws', async () => {
    const port = new ScriptedPort([])
    expect(
      (
        await rejected(
          createSegmentAgent(llmFor(port), { maxUnitChars: 3000 }).draft({
            req: REQ,
            outline: OUTLINE,
            index: 4,
            total: 1,
            showBible: '',
            voice: '',
          }),
        )
      ).message,
    ).toContain('out of range')
  })

  test('the write route runs the agent loop on the responses API, not chat completions', async () => {
    const port = new ScriptedPort([plainReply('kein Tool')])
    expect((await rejected(draftWith(port, undefined, { resolve: resolvePodcastRoute }))).message).toMatch(
      /without a measured draft/,
    )
    expect(port.rounds[0]?.api).toBe('responses')
  })
})

import type { ChatCall, ChatReply, ModelPort, OnWireUsage, RoundCall, RoundReply, WireMessage } from './llm.ts'
import { ModelError } from './llm.ts'
import type { BrainPort, HistoryPort, ResearchPort } from './ports.ts'
import type { EpisodeSummary } from './types.ts'

// Fakes for the room's ports: a scripted writers' room that answers every stage the way a well-behaved model would,
// counts every call per stage, and lets a test fail a stage or hold a call on a latch. No network, no model ids.

export type Stage =
  | 'research'
  | 'editorial'
  | 'outline'
  | 'segment'
  | 'agent'
  | 'review'
  | 'revise'
  | 'metadata'
  | 'repair'

export interface FakeRoomOptions {
  /** Segments the outline returns (default 2). */
  segments?: number
  /** Make a stage's calls throw. */
  fail?: Partial<Record<Stage, boolean>>
  /** Hold a call until the returned promise settles (a latch for kill tests). `index` is the segment, else -1. */
  hold?: (stage: Stage, index: number) => Promise<void> | undefined
  /** Load-bearing facts the editor names (default none). */
  loadBearing?: { question: string; open_question: string }[]
  /** USD the fake provider reports per call (default 0.001). */
  costPerCall?: number
}

export interface FakeRoom extends ModelPort {
  /** Every call in order: stage, segment index (-1 when not a segment stage). */
  calls: { stage: Stage; index: number }[]
  /** The messages every tool round was sent, as sent. */
  rounds: WireMessage[][]
  count(stage: Stage, index?: number): number
}

/** Six plain turns of ~9 words: under a 60-word target, no stock phrase, no lecture, questions on both sides. */
export function fakeTurns(index: number, mark = 'draft') {
  const lines = [
    `Heute geht es im Abschnitt ${index + 1} um eine einfache Frage für dich?`,
    'Genau, und die Antwort ist kürzer als man zunächst denkt.',
    `Was bedeutet das konkret für den Alltag von Lena ${mark}?`,
    'Es heißt vor allem, dass man weniger planen muss als gedacht.',
    'Und wie merkt man das im Laufe einer normalen Woche dann?',
    'Man merkt es daran, dass am Freitag noch Zeit übrig bleibt.',
  ]
  return lines.map((text, i) => ({ speaker: i % 2 === 0 ? 'A' : 'B', text }))
}

const segmentIndex = (system: string) => {
  const match = /ONE SEGMENT \((\d+) of \d+\)/.exec(system)
  return match ? Number(match[1]) - 1 : -1
}

function stageOf(system: string): Stage {
  if (system.startsWith('You repair JSON')) return 'repair'
  if (system.includes('You are the researcher of')) return 'research'
  if (system.includes('HOW YOU WORK IN THIS SESSION')) return 'agent'
  if (system.startsWith('You are the editor of')) return 'editorial'
  if (system.includes('You are writing the OUTLINE')) return 'outline'
  if (system.includes('You are REVISING ONE SEGMENT')) return 'revise'
  if (system.includes('You are writing ONE SEGMENT')) return 'segment'
  if (system.includes('METADATA EDITOR')) return 'metadata'
  if (system.includes('You are a reviewer')) return 'review'
  throw new Error(`fake room: unknown stage for system prompt "${system.slice(0, 80)}"`)
}

export function fakeRoom(options: FakeRoomOptions = {}): FakeRoom {
  const calls: { stage: Stage; index: number }[] = []
  const rounds: WireMessage[][] = []
  const segments = options.segments ?? 2
  const cost = options.costPerCall ?? 0.001
  const usage = (model: string, onUsage: OnWireUsage) =>
    onUsage({ model, tokens: { input: 1000, output: 200, cacheRead: 100, reasoning: 50 }, cost })

  async function enter(stage: Stage, index: number) {
    calls.push({ stage, index })
    await options.hold?.(stage, index)
    if (options.fail?.[stage]) throw new ModelError(`fake ${stage} failure`)
  }

  function answer(stage: Stage, index: number): string {
    switch (stage) {
      case 'editorial':
        return JSON.stringify({
          format: 'Gespräch',
          rationale: 'An explainer: the material is settled.',
          minutes: 5,
          segments,
          roles: { A: 'explains', B: 'asks' },
          tone: 'calm',
          humor: 'sparse',
          opening: 'Straight in.',
          closing: 'Stop when done.',
          rhythm: 'quick',
          devices: [],
          avoid: [],
          glossary_policy: 'what before name',
          asks: [],
          load_bearing_facts: options.loadBearing ?? [],
        })
      case 'outline':
        return JSON.stringify({
          title: 'Outline title',
          description: 'Outline description.',
          cover_prompt: 'a calm desk',
          genres: ['Knowledge'],
          motif: '',
          through_line: '',
          hook: '',
          reveals: [],
          digressions: [],
          segments: Array.from({ length: segments }, (_, i) => ({
            title: `Working title ${i + 1}`,
            goal: 'explain',
            key_facts: [],
            target_words: 60,
            tension: '',
            answers: [],
          })),
        })
      case 'segment':
        return JSON.stringify({ turns: fakeTurns(index) })
      case 'revise':
        return JSON.stringify({ turns: fakeTurns(index, 'revised') })
      case 'review':
        return JSON.stringify({
          notes: [{ segment: 0, turn: 1, note: 'Make the answer concrete.' }],
          verdict: 'fine',
        })
      case 'metadata':
        return JSON.stringify({
          title: 'Final title',
          description: 'Final description.',
          cover_prompt: 'a desk at dawn',
          genres: ['Education'],
          topics: ['planning', 'weeks', 'time'],
          chapters: Array.from({ length: segments }, (_, i) => ({ segment: i, title: `Chapter ${i + 1}` })),
        })
      case 'research':
      case 'repair':
        return JSON.stringify({
          summary: 'About planning.',
          additions: [],
          glossary: [{ term: 'OKR', plain: 'a goal format' }],
          priorCoverage: [],
          openQuestions: ['Open one', 'Open two'],
        })
      default:
        throw new Error(`fake room: no single-shot answer for ${stage}`)
    }
  }

  return {
    calls,
    rounds,
    count: (stage, index) =>
      calls.filter((c) => c.stage === stage && (index === undefined || c.index === index)).length,
    async chat(call: ChatCall, _signal: AbortSignal, onUsage: OnWireUsage): Promise<ChatReply> {
      const stage = stageOf(call.system)
      const index = segmentIndex(call.system)
      await enter(stage, index)
      usage(call.model, onUsage)
      return { text: answer(stage, index), stop: 'complete' }
    },
    async round(call: RoundCall, _signal: AbortSignal, onUsage: OnWireUsage): Promise<RoundReply> {
      const system = String(call.messages[0]?.content ?? '')
      const stage = stageOf(system)
      const index = segmentIndex(system)
      rounds.push(structuredClone(call.messages))
      await enter(stage, index)
      usage(call.model, onUsage)
      const toolResults = call.messages.filter((m) => m.role === 'tool').length
      if (stage === 'research') {
        if (toolResults === 0) {
          const message: WireMessage = {
            role: 'assistant',
            content: null,
            reasoning_content: 'opaque provider state',
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'past_episodes', arguments: '{"limit":3}' } }],
          }
          return { message, finishReason: 'tool_calls' }
        }
        return { message: { role: 'assistant', content: answer('research', -1) }, finishReason: 'stop' }
      }
      if (stage === 'agent') {
        const revising = system.includes('You are REVISING ONE SEGMENT')
        const turns = fakeTurns(index, revising ? 'revised' : 'draft')
        const message: WireMessage = {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: `s${toolResults}`,
              type: 'function',
              function: { name: 'submit_segment', arguments: JSON.stringify({ turns }) },
            },
          ],
        }
        return { message, finishReason: 'tool_calls' }
      }
      if (stage === 'repair') return { message: { role: 'assistant', content: answer('repair', -1) } }
      throw new Error(`fake room: no tool round for ${stage}`)
    },
  }
}

export function fakeHistory(episodes: EpisodeSummary[] = [], transcripts: Record<string, string> = {}): HistoryPort {
  return {
    recent: async (_series, limit) => episodes.slice(0, limit),
    transcript: async (id) => transcripts[id] ?? null,
  }
}

export function fakeBrain(notes: Record<string, string>): BrainPort {
  return {
    async search(query) {
      const matches = Object.entries(notes)
        .filter(([, body]) => body.toLowerCase().includes(query.toLowerCase()))
        .map(([path]) => ({ path, line: 1, snippet: query }))
      return { matches, warnings: [] }
    },
    async read(path) {
      const body = notes[path]
      return body === undefined
        ? { found: false, reason: `no note at ${path}` }
        : { found: true, path, frontmatter: '', body, truncated: false }
    },
  }
}

export function fakeResearch(answer = 'A report.', usd: number | null = 0.05): ResearchPort & { queries: string[] } {
  const queries: string[] = []
  return {
    queries,
    async run(query, depth) {
      queries.push(`${depth}:${query}`)
      return { ok: true, report: answer, sources: ['https://example.com/a'], usd, runId: `research-${queries.length}` }
    },
  }
}

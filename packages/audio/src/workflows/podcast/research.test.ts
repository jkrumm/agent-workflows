import { describe, expect, test } from 'bun:test'
import {
  buildResearchTools,
  dropAnsweredOpenQuestions,
  parseDossier,
  readBrainNotes,
  runLoadBearingResearch,
  runPodcastResearch,
  SOURCE_NOTE_MAX_CHARS,
} from './research.ts'
import {
  type ChatCall,
  type ChatReply,
  Llm,
  type ModelPort,
  type OnWireUsage,
  type RoundCall,
  type RoundReply,
  type ToolDef,
} from './llm.ts'
import type { BrainNote, BrainPort, HistoryPort, ResearchAnswer, ResearchDepth, ResearchPort } from './ports.ts'
import type { EpisodeSummary, LoadBearingFact } from './types.ts'

/** The error a promise rejects with; fails the test when it resolves. */
async function rejected(promise: Promise<unknown>): Promise<Error> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  if (!(error instanceof Error)) throw new Error('expected a rejection')
  return error
}

const SIGNAL = new AbortController().signal
const progress = () => {}

function findTool(tools: ToolDef[], name: string): ToolDef {
  const tool = tools.find((t) => t.name === name)
  if (!tool) throw new Error(`tool "${name}" not found`)
  return tool
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeBrain implements BrainPort {
  readonly searches: Array<{ query: string; limit: number; signal: AbortSignal }> = []
  readonly reads: Array<{ path: string; maxChars: number }> = []
  constructor(private readonly notes: Record<string, BrainNote> = {}) {}

  async search(query: string, limit: number, signal: AbortSignal) {
    this.searches.push({ query, limit, signal })
    return { matches: [{ path: 'wiki/peptides.md', line: 3, snippet: `…${query}…` }], warnings: [] as string[] }
  }

  async read(path: string, maxChars: number): Promise<BrainNote> {
    this.reads.push({ path, maxChars })
    return this.notes[path] ?? { found: false, reason: `no such note: ${path}` }
  }
}

const EPISODE: EpisodeSummary = {
  id: 'ep-1',
  createdAt: '2026-01-01T00:00:00.000Z',
  title: 'Episode One',
  description: 'd',
  profile: null,
}

function fakeHistory(transcripts: Record<string, string> = { 'ep-1': '# Episode One\n\ntranscript body' }) {
  const recentCalls: Array<{ series: string; limit: number }> = []
  const history: HistoryPort = {
    recent: async (series, limit) => {
      recentCalls.push({ series, limit })
      return [EPISODE].slice(0, limit)
    },
    transcript: async (id) => transcripts[id] ?? null,
  }
  return { history, recentCalls }
}

const ok = (report: string, extra: Partial<Extract<ResearchAnswer, { ok: true }>> = {}): ResearchAnswer => ({
  ok: true,
  report,
  sources: [],
  usd: null,
  runId: 'run-1',
  ...extra,
})

/** A ResearchPort that answers from a script and records every run. */
function fakeResearch(answers: Array<ResearchAnswer | Error>) {
  const runs: Array<{ query: string; depth: ResearchDepth; signal: AbortSignal }> = []
  const port: ResearchPort = {
    run: async (query, depth, signal) => {
      runs.push({ query, depth, signal })
      const next = answers.shift()
      if (!next) throw new Error('fakeResearch: no answer scripted')
      if (next instanceof Error) throw next
      return next
    },
  }
  return { port, runs }
}

// ---------------------------------------------------------------------------
// brain_search / brain_read through a BrainPort
// ---------------------------------------------------------------------------

describe('brain tools', () => {
  const note: BrainNote = {
    found: true,
    path: 'wiki/peptides.md',
    frontmatter: 'title: Peptide',
    body: 'BPC-157 helps healing.',
    truncated: false,
  }

  test('brain_search forwards the query, the default limit and the signal, and returns the port result as JSON', async () => {
    const brain = new FakeBrain()
    const { history } = fakeHistory()
    const tool = findTool(buildResearchTools({ brain, history, series: 's', signal: SIGNAL, progress }), 'brain_search')
    const raw = await tool.execute({ query: 'peptide' })
    expect(JSON.parse(raw)).toEqual({
      matches: [{ path: 'wiki/peptides.md', line: 3, snippet: '…peptide…' }],
      warnings: [],
    })
    expect(brain.searches).toEqual([{ query: 'peptide', limit: 8, signal: SIGNAL }])
  })

  test('brain_search clamps the limit to 1..50 and ignores a non-number', async () => {
    const brain = new FakeBrain()
    const tool = findTool(
      buildResearchTools({ brain, history: fakeHistory().history, series: 's', signal: SIGNAL, progress }),
      'brain_search',
    )
    await tool.execute({ query: 'a', limit: 500 })
    await tool.execute({ query: 'a', limit: 0 })
    await tool.execute({ query: 'a', limit: 3.6 })
    await tool.execute({ query: 'a', limit: 'many' })
    expect(brain.searches.map((s) => s.limit)).toEqual([50, 1, 4, 8])
  })

  test('brain_search without a query is an error the model reads', async () => {
    const tool = findTool(
      buildResearchTools({
        brain: new FakeBrain(),
        history: fakeHistory().history,
        series: 's',
        signal: SIGNAL,
        progress,
      }),
      'brain_search',
    )
    expect((await rejected(tool.execute({ query: '   ' }))).message).toContain('give a query')
    expect((await rejected(tool.execute({}))).message).toContain('give a query')
  })

  test('brain_read returns path, frontmatter, body and the truncated flag, asking for the read cap', async () => {
    const brain = new FakeBrain({ 'wiki/peptides.md': note })
    const tool = findTool(
      buildResearchTools({ brain, history: fakeHistory().history, series: 's', signal: SIGNAL, progress }),
      'brain_read',
    )
    const result = JSON.parse(await tool.execute({ path: 'wiki/peptides.md' })) as Record<string, unknown>
    expect(result).toEqual({
      path: 'wiki/peptides.md',
      frontmatter: 'title: Peptide',
      body: 'BPC-157 helps healing.',
      truncated: false,
    })
    expect(brain.reads).toEqual([{ path: 'wiki/peptides.md', maxChars: 60_000 }])
  })

  test('brain_read surfaces the capability refusal (containment lives in the vault capability) as a tool error', async () => {
    const brain = new FakeBrain({ '../outside.md': { found: false, reason: 'path escapes the vault' } })
    const tool = findTool(
      buildResearchTools({ brain, history: fakeHistory().history, series: 's', signal: SIGNAL, progress }),
      'brain_read',
    )
    expect((await rejected(tool.execute({ path: '../outside.md' }))).message).toContain('path escapes the vault')
  })

  test('readBrainNotes reads each path up to the source cap, re-wrapping frontmatter, and rejects a missing note', async () => {
    const brain = new FakeBrain({
      'wiki/peptides.md': note,
      'wiki/plain.md': {
        found: true,
        path: 'wiki/plain.md',
        frontmatter: '',
        body: 'no frontmatter',
        truncated: false,
      },
    })
    const notes = await readBrainNotes(brain, ['wiki/peptides.md', 'wiki/plain.md'], SIGNAL)
    expect(notes).toEqual([
      { path: 'wiki/peptides.md', text: '---\ntitle: Peptide\n---\nBPC-157 helps healing.' },
      { path: 'wiki/plain.md', text: 'no frontmatter' },
    ])
    expect(brain.reads.every((r) => r.maxChars === SOURCE_NOTE_MAX_CHARS)).toBe(true)
    expect((await rejected(readBrainNotes(brain, ['wiki/missing.md'], SIGNAL))).message).toContain(
      'sourcePaths: "wiki/missing.md": no such note',
    )
  })
})

// ---------------------------------------------------------------------------
// tool set
// ---------------------------------------------------------------------------

describe('buildResearchTools', () => {
  const names = (tools: ToolDef[]) => tools.map((t) => t.name)
  const base = { history: fakeHistory().history, series: 's', signal: SIGNAL, progress }

  test('past-episode tools are always present; brain and research tools only when configured', () => {
    expect(names(buildResearchTools(base))).toEqual(['past_episodes', 'past_transcript'])
    expect(names(buildResearchTools({ ...base, brain: new FakeBrain() }))).toEqual([
      'brain_search',
      'brain_read',
      'past_episodes',
      'past_transcript',
    ])
    expect(names(buildResearchTools({ ...base, research: { port: fakeResearch([]).port } }))).toEqual([
      'past_episodes',
      'past_transcript',
      'research',
    ])
  })
})

// ---------------------------------------------------------------------------
// past_episodes / past_transcript
// ---------------------------------------------------------------------------

describe('past_episodes / past_transcript', () => {
  test('past_episodes returns history.recent for the series, default limit 10, clamped to 1..50', async () => {
    const { history, recentCalls } = fakeHistory()
    const tool = findTool(buildResearchTools({ history, series: 'My Show', signal: SIGNAL, progress }), 'past_episodes')
    expect(JSON.parse(await tool.execute({ limit: 5 }))).toEqual([EPISODE])
    await tool.execute({})
    await tool.execute({ limit: 999 })
    expect(recentCalls).toEqual([
      { series: 'My Show', limit: 5 },
      { series: 'My Show', limit: 10 },
      { series: 'My Show', limit: 50 },
    ])
  })

  test('past_transcript returns the transcript or an error string', async () => {
    const tool = findTool(
      buildResearchTools({ history: fakeHistory().history, series: 's', signal: SIGNAL, progress }),
      'past_transcript',
    )
    expect(await tool.execute({ id: 'ep-1' })).toContain('transcript body')
    expect(await tool.execute({ id: 'missing' })).toMatch(/no transcript found/)
  })

  test('a transcript over the cap is cut and says so', async () => {
    const { history } = fakeHistory({ long: 'x'.repeat(50_000) })
    const tool = findTool(buildResearchTools({ history, series: 's', signal: SIGNAL, progress }), 'past_transcript')
    const out = await tool.execute({ id: 'long' })
    expect(out.startsWith('x'.repeat(40_000))).toBe(true)
    expect(out.length).toBeLessThan(40_100)
    expect(out).toContain('[truncated at 40000 chars]')
  })
})

// ---------------------------------------------------------------------------
// research tool
// ---------------------------------------------------------------------------

describe('research tool', () => {
  const build = (
    research: ResearchPort,
    extra: { maxCalls?: number; spend?: { usd: number; unpriced: number } } = {},
  ) => {
    const { maxCalls, spend } = extra
    const tools = buildResearchTools({
      history: fakeHistory().history,
      series: 's',
      signal: SIGNAL,
      progress,
      research: { port: research, ...(maxCalls !== undefined ? { maxCalls } : {}) },
      ...(spend ? { spend } : {}),
    })
    return findTool(tools, 'research')
  }

  test('renders the report with its sources and runs on the step signal', async () => {
    const { port, runs } = fakeResearch([ok('the report', { sources: ['src-a', 'src-b'] })])
    const out = await build(port).execute({ query: 'q1' })
    expect(out).toBe('the report\n\nSources:\n- src-a\n- src-b')
    expect(runs[0]?.signal).toBe(SIGNAL)
  })

  test('a report over the cap is cut', async () => {
    const { port } = fakeResearch([ok('r'.repeat(25_000))])
    expect((await build(port).execute({ query: 'q' })).length).toBe(20_000)
  })

  test('is always quick depth — a depth the model passes is ignored', async () => {
    const { port, runs } = fakeResearch([ok('r1')])
    await build(port).execute({ query: 'explain BVL, BfR, CVUA in one plain sentence each', depth: 'standard' })
    expect(runs.map((r) => r.depth)).toEqual(['quick'])
  })

  test('enforces the per-episode budget without running again once exhausted', async () => {
    const { port, runs } = fakeResearch([ok('the report', { sources: ['src-a'] })])
    const tool = build(port, { maxCalls: 1 })
    const first = await tool.execute({ query: 'q1' })
    expect(first).toContain('Sources:\n- src-a')
    expect(await tool.execute({ query: 'q2' })).toBe('research budget exhausted (1 calls)')
    expect(runs).toHaveLength(1)
  })

  test('maxCalls 0 or absent means unlimited, not exhausted', async () => {
    const zero = fakeResearch([ok('one'), ok('two')])
    const toolZero = build(zero.port, { maxCalls: 0 })
    expect(await toolZero.execute({ query: 'a' })).toContain('one')
    expect(await toolZero.execute({ query: 'b' })).toContain('two')
    const none = fakeResearch([ok('one'), ok('two'), ok('three')])
    const toolNone = build(none.port)
    for (const q of ['a', 'b', 'c']) await toolNone.execute({ query: q })
    expect(none.runs).toHaveLength(3)
  })

  test('an identical query (case and whitespace aside) is answered from the first run — no second run, no second charge', async () => {
    const { port, runs } = fakeResearch([ok('the report', { usd: 0.03 })])
    const spend = { usd: 0, unpriced: 0 }
    const tool = build(port, { maxCalls: 5, spend })
    await tool.execute({ query: 'Was ist  DBOS?' })
    const again = await tool.execute({ query: 'was ist dbos?', depth: 'standard' })
    expect(again).toContain('this exact query was already run')
    expect(again).toContain('the report')
    expect(runs).toHaveLength(1)
    expect(spend.usd).toBeCloseTo(0.03)
  })

  test('a failed run returns its error and does not consume a budget slot or spend', async () => {
    const { port, runs } = fakeResearch([
      { ok: false, error: 'research failed: no sources found' },
      ok('recovered report'),
    ])
    const spend = { usd: 0, unpriced: 0 }
    const tool = build(port, { maxCalls: 1, spend })
    expect(await tool.execute({ query: 'q1' })).toBe('research failed: no sources found')
    expect(await tool.execute({ query: 'q2' })).toContain('recovered report')
    expect(runs).toHaveLength(2)
    expect(spend.unpriced).toBe(1)
  })

  test('a failed query is not cached: asking it again runs again', async () => {
    const { port, runs } = fakeResearch([{ ok: false, error: 'queue full' }, ok('now it works')])
    const tool = build(port)
    expect(await tool.execute({ query: 'q' })).toBe('queue full')
    expect(await tool.execute({ query: 'q' })).toBe('now it works')
    expect(runs).toHaveLength(2)
  })

  test('a thrown port error propagates and does not consume a budget slot', async () => {
    const { port } = fakeResearch([new Error('network down'), ok('recovered after transport error')])
    const tool = build(port, { maxCalls: 1 })
    expect((await rejected(tool.execute({ query: 'q1' }))).message).toContain('network down')
    expect(await tool.execute({ query: 'q2' })).toContain('recovered after transport error')
  })

  test('no spend ceiling: reported spend accumulates, unpriced runs are counted, nothing blocks a run', async () => {
    const { port, runs } = fakeResearch([ok('r1', { usd: 9 }), ok('r2', { usd: 9 }), ok('r3', { usd: null })])
    const spend = { usd: 0, unpriced: 0 }
    const tool = build(port, { spend })
    await tool.execute({ query: 'q1' })
    expect(await tool.execute({ query: 'q2' })).toContain('r2')
    await tool.execute({ query: 'q3' })
    expect(runs).toHaveLength(3)
    expect(spend).toEqual({ usd: 18, unpriced: 1 })
  })

  test('buildResearchTools creates the spend counter when the caller gave none', async () => {
    const { port } = fakeResearch([ok('r1', { usd: 0.5 })])
    const deps = {
      history: fakeHistory().history,
      series: 's',
      signal: SIGNAL,
      progress,
      research: { port },
    }
    await findTool(buildResearchTools(deps), 'research').execute({ query: 'q' })
    expect((deps as { spend?: { usd: number } }).spend?.usd).toBe(0.5)
  })

  test('the tool description expects web research for what notes and brain do not explain', () => {
    const description = build(fakeResearch([]).port, { maxCalls: 12 }).description
    expect(description).toContain('EXPECTED')
    expect(description).not.toContain('sparingly')
  })
})

// ---------------------------------------------------------------------------
// runLoadBearingResearch — the only place standard depth runs
// ---------------------------------------------------------------------------

function fact(question: string, openQuestion = ''): LoadBearingFact {
  return { question, openQuestion }
}

describe('runLoadBearingResearch', () => {
  test('runs each editor-named fact at standard depth and folds the answers into additions', async () => {
    const { port, runs } = fakeResearch([ok('answer one', { usd: 0.4 }), ok('answer two', { usd: 0.1 })])
    const result = await runLoadBearingResearch([fact('fact one'), fact('fact two')], {
      research: port,
      signal: SIGNAL,
      progress,
    })
    expect(runs.map((r) => [r.query, r.depth])).toEqual([
      ['fact one', 'standard'],
      ['fact two', 'standard'],
    ])
    expect(result.additions).toEqual([
      { source: 'research: fact one', text: 'answer one' },
      { source: 'research: fact two', text: 'answer two' },
    ])
    expect(result.usdSpent).toBeCloseTo(0.5)
    expect(result.unpriced).toBe(0)
    expect(result.toolCalls.map((c) => [c.tool, c.ok])).toEqual([
      ['research', true],
      ['research', true],
    ])
  })

  test('no research configured or no facts named → no calls, empty result', async () => {
    const empty = { additions: [], toolCalls: [], usdSpent: 0, unpriced: 0, answeredOpenQuestions: [] }
    expect(await runLoadBearingResearch([fact('fact')], { signal: SIGNAL, progress })).toEqual(empty)
    const { port, runs } = fakeResearch([])
    expect(await runLoadBearingResearch([], { research: port, signal: SIGNAL, progress })).toEqual(empty)
    expect(runs).toHaveLength(0)
  })

  test('a failed fact is skipped, not thrown — the rest still run; an unpriced run is counted', async () => {
    const { port } = fakeResearch([
      { ok: false, error: 'upstream error' },
      new Error('socket closed'),
      ok('answer three', { usd: null }),
    ])
    const result = await runLoadBearingResearch([fact('bad'), fact('worse'), fact('good')], {
      research: port,
      signal: SIGNAL,
      progress,
    })
    expect(result.additions).toEqual([{ source: 'research: good', text: 'answer three' }])
    expect(result.toolCalls.map((c) => c.ok)).toEqual([false, false, true])
    expect(result.unpriced).toBe(1)
  })

  test('a cancelled step rethrows instead of skipping the fact', async () => {
    const abort = new AbortController()
    const port: ResearchPort = {
      run: async () => {
        abort.abort()
        throw new Error('aborted')
      },
    }
    expect(
      (await rejected(runLoadBearingResearch([fact('f')], { research: port, signal: abort.signal, progress }))).message,
    ).toContain('aborted')
  })

  test('no cap — every editor-named fact is researched, however many there are', async () => {
    const { port, runs } = fakeResearch(['a', 'b', 'c', 'd', 'e'].map((r) => ok(r)))
    const result = await runLoadBearingResearch(
      ['f1', 'f2', 'f3', 'f4', 'f5'].map((q) => fact(q)),
      {
        research: port,
        signal: SIGNAL,
        progress,
      },
    )
    expect(result.additions).toHaveLength(5)
    expect(runs).toHaveLength(5)
  })

  test("answeredOpenQuestions carries the editor's openQuestion, not the (deliberately reworded) research question", async () => {
    const { port } = fakeResearch([ok('answer'), ok('answer')])
    const result = await runLoadBearingResearch(
      [
        fact('How recent is the official stance on long-term safety?', 'is it safe long-term?'),
        fact('glossary lookup, no open question behind it'),
      ],
      { research: port, signal: SIGNAL, progress },
    )
    expect(result.answeredOpenQuestions).toEqual(['is it safe long-term?'])
  })

  test('a failed fact does not answer its open question', async () => {
    const { port } = fakeResearch([{ ok: false, error: 'nope' }])
    const result = await runLoadBearingResearch([fact('q', 'open?')], { research: port, signal: SIGNAL, progress })
    expect(result.answeredOpenQuestions).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// dropAnsweredOpenQuestions
// ---------------------------------------------------------------------------

describe('dropAnsweredOpenQuestions', () => {
  test('removes answered facts, keeps unanswered ones', () => {
    const openQuestions = ['is it safe long-term?', 'what is the half-life?', 'who funded the trial?']
    expect(dropAnsweredOpenQuestions(openQuestions, ['what is the half-life?'])).toEqual([
      'is it safe long-term?',
      'who funded the trial?',
    ])
  })

  test('no answered facts → returns the same openQuestions', () => {
    const openQuestions = ['is it safe long-term?']
    expect(dropAnsweredOpenQuestions(openQuestions, [])).toEqual(openQuestions)
  })

  test("matches case/whitespace/punctuation drift between the editor's copy and the original entry", () => {
    const openQuestions = ['is it safe long-term?', 'what is the half-life?']
    expect(dropAnsweredOpenQuestions(openQuestions, ['  WHAT Is the   half-life ?'])).toEqual(['is it safe long-term?'])
  })

  test('only the editor’s verbatim copy matters: a paraphrase does not match a different entry', () => {
    const openQuestions = ['is it safe long-term?', 'who funded the trial?']
    expect(dropAnsweredOpenQuestions(openQuestions, ['is it safe long-term?'])).toEqual(['who funded the trial?'])
  })
})

// ---------------------------------------------------------------------------
// parseDossier
// ---------------------------------------------------------------------------

describe('parseDossier', () => {
  test('parses a well-formed dossier', () => {
    const raw = JSON.stringify({
      summary: 'the summary',
      additions: [{ source: 'brain: Areas/x.md', text: 'extra' }],
      glossary: [{ term: 'BPC-157', plain: 'a healing peptide' }],
      priorCoverage: [{ episodeId: 'ep-1', title: 'Episode One', covered: 'the basics' }],
      openQuestions: ['is it safe long-term?'],
    })
    const dossier = parseDossier(raw)
    expect(dossier.summary).toBe('the summary')
    expect(dossier.additions).toEqual([{ source: 'brain: Areas/x.md', text: 'extra' }])
    expect(dossier.glossary).toEqual([{ term: 'BPC-157', plain: 'a healing peptide' }])
    expect(dossier.priorCoverage).toEqual([{ episodeId: 'ep-1', title: 'Episode One', covered: 'the basics' }])
    expect(dossier.openQuestions).toEqual(['is it safe long-term?'])
    expect(dossier.toolCalls).toEqual([])
  })

  test('defaults missing arrays to [] and trims strings', () => {
    const dossier = parseDossier(JSON.stringify({ summary: '  trimmed  ' }))
    expect(dossier.summary).toBe('trimmed')
    expect(dossier.additions).toEqual([])
    expect(dossier.glossary).toEqual([])
    expect(dossier.priorCoverage).toEqual([])
    expect(dossier.openQuestions).toEqual([])
  })

  test('extracts JSON fenced in a markdown code block', () => {
    const raw = `Here is my answer:\n\`\`\`json\n${JSON.stringify({ summary: 'fenced' })}\n\`\`\`\nThanks.`
    expect(parseDossier(raw).summary).toBe('fenced')
  })

  test('throws when no JSON object is present at all', () => {
    expect(() => parseDossier('no json here at all')).toThrow(/no JSON object/)
  })

  test('a German quote closed with an ASCII quote still parses', () => {
    const raw =
      '{"summary":"s","additions":[],"glossary":[{"term":"Titel","plain":"Der Beitrag „A software factory is just a durable workflow\\" von Cortex"}],"priorCoverage":[],"openQuestions":[]}'
    expect(parseDossier(raw).glossary[0]?.plain).toContain('durable workflow')
  })
})

// ---------------------------------------------------------------------------
// runPodcastResearch — end to end against a scripted ModelPort
// ---------------------------------------------------------------------------

describe('runPodcastResearch', () => {
  class ScriptedPort implements ModelPort {
    readonly rounds: RoundCall[] = []
    constructor(private readonly steps: RoundReply[]) {}
    async chat(_call: ChatCall, _signal: AbortSignal, _onUsage: OnWireUsage): Promise<ChatReply> {
      throw new Error('chat not expected')
    }
    async round(call: RoundCall, _signal: AbortSignal, onUsage: OnWireUsage): Promise<RoundReply> {
      this.rounds.push(structuredClone(call))
      const step = this.steps.shift()
      if (!step) throw new Error('ScriptedPort: no round scripted')
      onUsage({ model: 'fake-model', tokens: { input: 10, output: 5, cacheRead: 0, reasoning: 0 }, cost: 0.001 })
      return step
    }
  }

  const llmFor = (port: ModelPort) => new Llm(port, { addUsage: () => {}, signal: SIGNAL, progress })

  const pastEpisodesCall = (id: string): RoundReply => ({
    message: {
      role: 'assistant',
      content: null,
      tool_calls: [{ id, type: 'function', function: { name: 'past_episodes', arguments: '{}' } }],
    },
    finishReason: 'tool_calls',
  })
  const answer = (content: string): RoundReply => ({ message: { role: 'assistant', content }, finishReason: 'stop' })
  const dossierJson = (summary: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ summary, additions: [], glossary: [], priorCoverage: [], openQuestions: [], ...extra })
  const input = { source: 'some notes about peptides', language: 'de' as const, series: 'My Show' }

  test('calls past_episodes once then returns the parsed dossier with the tool calls and research spend', async () => {
    const port = new ScriptedPort([
      pastEpisodesCall('call_1'),
      answer(
        dossierJson('an episode about peptides was already covered', {
          priorCoverage: [{ episodeId: 'ep-1', title: 'Episode One', covered: 'basics' }],
        }),
      ),
    ])
    const { history } = fakeHistory()
    const { dossier, researchUnpriced } = await runPodcastResearch(llmFor(port), input, {
      history,
      series: 'My Show',
      signal: SIGNAL,
      progress,
    })
    expect(dossier.summary).toBe('an episode about peptides was already covered')
    expect(dossier.priorCoverage).toEqual([{ episodeId: 'ep-1', title: 'Episode One', covered: 'basics' }])
    expect(dossier.toolCalls).toEqual([{ tool: 'past_episodes', args: {}, ok: true, ms: expect.any(Number) }])
    expect(dossier.researchUsd).toBe(0)
    expect(researchUnpriced).toBe(0)
    expect(port.rounds).toHaveLength(2)
    expect(port.rounds[0]?.model).toBe(llmFor(port).route('podcast.research').model)
    expect(port.rounds[0]?.messages[0]?.content).toContain('"My Show"')
    expect(port.rounds[0]?.messages[1]?.content).toContain('SOURCE:\nsome notes about peptides')
  })

  test('tells the model which tools are absent', async () => {
    const port = new ScriptedPort([answer(dossierJson('s'))])
    await runPodcastResearch(llmFor(port), input, {
      history: fakeHistory().history,
      series: 's',
      signal: SIGNAL,
      progress,
    })
    const system = String(port.rounds[0]?.messages[0]?.content)
    expect(system).toContain('brain_search/brain_read) is not configured')
    expect(system).toContain('`research` tool) is not configured')
    expect(port.rounds[0]?.tools.map((t) => t.name)).toEqual(['past_episodes', 'past_transcript'])
  })

  test('reports the research workflow spend of the tool runs it started', async () => {
    const research = fakeResearch([ok('r', { usd: 0.25 }), ok('r2', { usd: null })])
    const call = (id: string, query: string): RoundReply => ({
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{ id, type: 'function', function: { name: 'research', arguments: JSON.stringify({ query }) } }],
      },
      finishReason: 'tool_calls',
    })
    const port = new ScriptedPort([call('c1', 'one'), call('c2', 'two'), answer(dossierJson('done'))])
    const result = await runPodcastResearch(llmFor(port), input, {
      history: fakeHistory().history,
      series: 's',
      signal: SIGNAL,
      progress,
      research: { port: research.port },
    })
    expect(result.dossier.researchUsd).toBe(0.25)
    expect(result.researchUnpriced).toBe(1)
    expect(result.dossier.toolCalls.map((c) => c.tool)).toEqual(['research', 'research'])
  })

  test('is not capped in rounds — it keeps calling tools past twelve', async () => {
    const wanting = 14
    const port = new ScriptedPort([
      ...Array.from({ length: wanting }, (_, i) => pastEpisodesCall(`call_${i}`)),
      answer(dossierJson('concluded after many rounds')),
    ])
    const { dossier } = await runPodcastResearch(llmFor(port), input, {
      history: fakeHistory().history,
      series: 's',
      signal: SIGNAL,
      progress,
    })
    expect(dossier.summary).toBe('concluded after many rounds')
    expect(dossier.toolCalls).toHaveLength(wanting)
    expect(port.rounds).toHaveLength(wanting + 1)
  })

  test('asks once for a JSON repair when the dossier does not parse', async () => {
    const port = new ScriptedPort([answer('Sorry, here are my findings in prose.'), answer(dossierJson('repaired'))])
    const { dossier } = await runPodcastResearch(llmFor(port), input, {
      history: fakeHistory().history,
      series: 's',
      signal: SIGNAL,
      progress,
    })
    expect(dossier.summary).toBe('repaired')
    expect(port.rounds).toHaveLength(2)
    expect(port.rounds[1]?.tools).toEqual([])
    expect(port.rounds[1]?.messages[1]?.content).toBe('Sorry, here are my findings in prose.')
  })

  test('rethrows when the repair does not parse either', async () => {
    const port = new ScriptedPort([answer('prose'), answer('still prose')])
    expect(
      (
        await rejected(
          runPodcastResearch(llmFor(port), input, {
            history: fakeHistory().history,
            series: 's',
            signal: SIGNAL,
            progress,
          }),
        )
      ).message,
    ).toMatch(/no JSON object/)
  })
})

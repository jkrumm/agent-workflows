import type { Llm, ToolDef } from './llm.ts'
import { runToolLoop } from './llm.ts'
import { log } from './log.ts'
import type { BrainPort, HistoryPort, ResearchDepth, ResearchPort } from './ports.ts'
import { repairGermanQuotes } from './script.ts'
import type { Dossier, LoadBearingFact, ToolCallRecord } from './types.ts'

// The research stage (audio-gateway `podcast-research.ts`): a tool loop that reads the listener's own material, gives
// the writers' room eyes on the brain and past episodes, and runs the host's `research` workflow on what is genuinely
// missing. Best-effort: the workflow decides what a throw means (write from the source alone).
//
// Privacy: the brain notes the tools read go to the research model, as they did on legacy; they are the episode's
// source. The vault capabilities keep the reads inside `wiki/`, `Areas/` and `Projects/`.

export interface ResearchInput {
  source: string
  brief?: string
  title?: string
  language: 'de' | 'en'
  series: string
}

export interface ResearchDeps {
  /** Absent: no brain tools. */
  brain?: BrainPort
  /** Absent: no `research` tool. `maxCalls`: an optional emergency valve on runs per episode (absent: unlimited). */
  research?: { port: ResearchPort; maxCalls?: number }
  /** Running spend of the `research` workflow runs this stage started (their own run records hold the detail). */
  spend?: { usd: number; unpriced: number }
  history: HistoryPort
  series: string
  signal: AbortSignal
  /** Resets the step's idle timer while a research run is waited on. */
  progress: () => void
}

const BRAIN_READ_MAX_CHARS = 60_000
const PAST_TRANSCRIPT_MAX_CHARS = 40_000
const RESEARCH_REPORT_MAX_CHARS = 20_000
const DEFAULT_SEARCH_LIMIT = 8
/** The vault capability's ceiling per search. */
const MAX_SEARCH_LIMIT = 50
const DEFAULT_PAST_EPISODES_LIMIT = 10
/** A source note read through `sourcePaths`: the vault capability's ceiling. */
export const SOURCE_NOTE_MAX_CHARS = 100_000

const clampLimit = (value: unknown, fallback: number, max: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(1, Math.round(value))) : fallback

/** Read brain-relative note paths (`sourcePaths`) up front, frontmatter included, as legacy read the raw file. */
export async function readBrainNotes(
  brain: BrainPort,
  paths: string[],
  signal: AbortSignal,
): Promise<Array<{ path: string; text: string }>> {
  const out: Array<{ path: string; text: string }> = []
  for (const path of paths) {
    const note = await brain.read(path, SOURCE_NOTE_MAX_CHARS, signal)
    if (!note.found) throw new Error(`sourcePaths: "${path}": ${note.reason}`)
    const text = note.frontmatter ? `---\n${note.frontmatter}\n---\n${note.body}` : note.body
    out.push({ path, text })
  }
  return out
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export function brainSearchTool(brain: BrainPort, signal: AbortSignal): ToolDef {
  return {
    name: 'brain_search',
    description:
      "Search the listener's second-brain vault for notes matching a query. Returns matching lines with their note path; read a note with brain_read.",
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search terms.' },
        limit: { type: 'number', description: 'Max results, default 8.' },
      },
      required: ['query'],
    },
    execute: async (rawArgs) => {
      const args = rawArgs as { query?: unknown; limit?: unknown }
      const query = typeof args.query === 'string' ? args.query : ''
      if (!query.trim()) throw new Error('give a query')
      const result = await brain.search(query, clampLimit(args.limit, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT), signal)
      return JSON.stringify(result)
    },
  }
}

export function brainReadTool(brain: BrainPort, signal: AbortSignal): ToolDef {
  return {
    name: 'brain_read',
    description: "Read one note from the listener's vault by its vault-relative path (as returned by brain_search).",
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    execute: async (rawArgs) => {
      const path = String((rawArgs as { path?: unknown }).path ?? '')
      const note = await brain.read(path, BRAIN_READ_MAX_CHARS, signal)
      if (!note.found) throw new Error(note.reason)
      return JSON.stringify({
        path: note.path,
        frontmatter: note.frontmatter,
        body: note.body,
        truncated: note.truncated,
      })
    },
  }
}

function pastEpisodesTool(history: HistoryPort, series: string): ToolDef {
  return {
    name: 'past_episodes',
    description: 'List recent finished episodes of this podcast, newest first, with their editorial profile.',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Max episodes, default 10.' } },
    },
    execute: async (rawArgs) => {
      const limit = clampLimit((rawArgs as { limit?: unknown }).limit, DEFAULT_PAST_EPISODES_LIMIT, 50)
      return JSON.stringify(await history.recent(series, limit))
    },
  }
}

function pastTranscriptTool(history: HistoryPort): ToolDef {
  return {
    name: 'past_transcript',
    description: 'Read the full markdown transcript of a past episode by its id (from past_episodes).',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    execute: async (rawArgs) => {
      const id = String((rawArgs as { id?: unknown }).id ?? '')
      const transcript = await history.transcript(id)
      if (transcript == null) return `error: no transcript found for episode "${id}"`
      return transcript.length > PAST_TRANSCRIPT_MAX_CHARS
        ? `${transcript.slice(0, PAST_TRANSCRIPT_MAX_CHARS)}\n\n[truncated at ${PAST_TRANSCRIPT_MAX_CHARS} chars]`
        : transcript
    },
  }
}

/** A finished research run as the model reads it: the report, capped, and its sources. */
function renderAnswer(report: string, sources: string[]): string {
  const sourcesBlock = sources.length > 0 ? `\n\nSources:\n${sources.map((s) => `- ${s}`).join('\n')}` : ''
  return `${report.slice(0, RESEARCH_REPORT_MAX_CHARS)}${sourcesBlock}`
}

function addSpend(spend: { usd: number; unpriced: number }, usd: number | null) {
  if (usd === null) spend.unpriced++
  else spend.usd += usd
}

function researchTool(
  research: NonNullable<ResearchDeps['research']>,
  spend: { usd: number; unpriced: number },
  signal: AbortSignal,
  progress: () => void,
): ToolDef {
  let used = 0
  /** An identical query returns what it returned the first time: no second run, no second charge. */
  const answered = new Map<string, string>()
  const normalize = (q: string): string => q.toLowerCase().replace(/\s+/g, ' ').trim()
  return {
    name: 'research',
    description:
      "Web research through the platform's research workflow — EXPECTED, not a last resort, for anything the listener needs that the SOURCE and the brain do not explain: the external third-party names, projects, tools, companies and standards the notes take for granted (batch them in ONE query asking for one plain sentence each: what it is and what it is for here), facts the episode hinges on, current numbers, and the claims the notes make about the outside world. Several runs per episode are normal; keep each query specific and distinct (an identical query is not run twice). Every run here is quick depth — a name or term needing one plain sentence; it is not yours to request more than that (see the system prompt).",
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    execute: async (rawArgs) => {
      const query = String((rawArgs as { query?: unknown }).query ?? '')
      // Quick only: the researcher's own judgement on what deserves standard depth was the overspend failure on
      // legacy. Standard depth exists only in `runLoadBearingResearch`, on facts the editor named.
      const depth: ResearchDepth = 'quick'
      const key = normalize(query)
      const earlier = answered.get(key)
      if (earlier !== undefined) return `(this exact query was already run — same result)\n${earlier}`
      if (research.maxCalls !== undefined && research.maxCalls > 0 && used >= research.maxCalls) {
        return `research budget exhausted (${research.maxCalls} calls)`
      }
      const result = await research.port.run(query, depth, signal, progress)
      if (!result.ok) return result.error
      // Debited only once a run ended done: a refused or failed run does not consume a slot.
      used++
      addSpend(spend, result.usd)
      const answer = renderAnswer(result.report, result.sources)
      answered.set(key, answer)
      return answer
    },
  }
}

export interface LoadBearingResearchResult {
  additions: Dossier['additions']
  toolCalls: ToolCallRecord[]
  usdSpent: number
  unpriced: number
  /** The `openQuestion` of each resolved fact that named one (verbatim): the caller drops exactly these. */
  answeredOpenQuestions: string[]
}

/**
 * Standard-depth research for the facts the editor named load-bearing (`EpisodeBrief.loadBearingFacts`), the only
 * place `standard` depth runs. Code decides the query (`fact.question`); matching back to `dossier.openQuestions` uses
 * `fact.openQuestion`, the editor's verbatim copy. Best-effort per fact: a failed run is logged and skipped.
 */
export async function runLoadBearingResearch(
  facts: LoadBearingFact[],
  deps: { research?: ResearchPort; signal: AbortSignal; progress: () => void },
): Promise<LoadBearingResearchResult> {
  const out: LoadBearingResearchResult = {
    additions: [],
    toolCalls: [],
    usdSpent: 0,
    unpriced: 0,
    answeredOpenQuestions: [],
  }
  if (!deps.research || facts.length === 0) return out
  for (const fact of facts) {
    const startedAt = Date.now()
    const args = { query: fact.question, depth: 'standard' }
    try {
      const result = await deps.research.run(fact.question, 'standard', deps.signal, deps.progress)
      if (!result.ok) throw new Error(result.error)
      if (result.usd === null) out.unpriced++
      else out.usdSpent += result.usd
      out.additions.push({ source: `research: ${fact.question}`, text: renderAnswer(result.report, result.sources) })
      if (fact.openQuestion) out.answeredOpenQuestions.push(fact.openQuestion)
      out.toolCalls.push({ tool: 'research', args, ok: true, ms: Date.now() - startedAt })
    } catch (err) {
      if (deps.signal.aborted) throw err
      log.warn('podcast load-bearing research failed, skipping this fact', {
        fact: fact.question,
        error: err instanceof Error ? err.message : String(err),
      })
      out.toolCalls.push({ tool: 'research', args, ok: false, ms: Date.now() - startedAt })
    }
  }
  return out
}

export function buildResearchTools(deps: ResearchDeps): ToolDef[] {
  const tools: ToolDef[] = []
  if (deps.brain) tools.push(brainSearchTool(deps.brain, deps.signal), brainReadTool(deps.brain, deps.signal))
  tools.push(pastEpisodesTool(deps.history, deps.series), pastTranscriptTool(deps.history))
  if (deps.research) {
    deps.spend ??= { usd: 0, unpriced: 0 }
    tools.push(researchTool(deps.research, deps.spend, deps.signal, deps.progress))
  }
  return tools
}

// ---------------------------------------------------------------------------
// Dossier parsing
// ---------------------------------------------------------------------------

/** Pulls a JSON object out of a reply that may be fenced in a markdown code block or carry stray prose around it. */
function extractJsonObject(raw: string): string | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = (fenced ? fenced[1] : raw)?.trim() ?? ''
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  return candidate.slice(start, end + 1)
}

function stringField(obj: Record<string, unknown>, key: string): string {
  const value = obj[key]
  return typeof value === 'string' ? value.trim() : ''
}

/** Tolerant: missing arrays become `[]`, strings are trimmed. Throws only if no JSON object can be found at all. */
export function parseDossier(raw: string): Dossier {
  const jsonText = extractJsonObject(raw)
  if (!jsonText) throw new Error('no JSON object found in research dossier response')
  const parsed = JSON.parse(repairGermanQuotes(jsonText)) as Record<string, unknown>

  const additions = Array.isArray(parsed['additions'])
    ? (parsed['additions'] as unknown[]).map((item) => {
        const obj = (item ?? {}) as Record<string, unknown>
        return { source: stringField(obj, 'source'), text: stringField(obj, 'text') }
      })
    : []
  const glossary = Array.isArray(parsed['glossary'])
    ? (parsed['glossary'] as unknown[]).map((item) => {
        const obj = (item ?? {}) as Record<string, unknown>
        return { term: stringField(obj, 'term'), plain: stringField(obj, 'plain') }
      })
    : []
  const priorCoverage = Array.isArray(parsed['priorCoverage'])
    ? (parsed['priorCoverage'] as unknown[]).map((item) => {
        const obj = (item ?? {}) as Record<string, unknown>
        return {
          episodeId: stringField(obj, 'episodeId'),
          title: stringField(obj, 'title'),
          covered: stringField(obj, 'covered'),
        }
      })
    : []
  const openQuestions = Array.isArray(parsed['openQuestions'])
    ? (parsed['openQuestions'] as unknown[]).map((q) => (typeof q === 'string' ? q.trim() : String(q)))
    : []

  return {
    summary: stringField(parsed, 'summary'),
    additions,
    glossary,
    priorCoverage,
    openQuestions,
    toolCalls: [],
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

function buildSystemPrompt(input: ResearchInput, deps: ResearchDeps): string {
  const languageName = input.language === 'de' ? 'German' : 'English'
  const notes: string[] = []
  if (!deps.brain)
    notes.push(
      "The listener's brain (brain_search/brain_read) is not configured for this run — those tools are absent.",
    )
  if (!deps.research)
    notes.push('The research workflow (the `research` tool) is not configured for this run — it is absent.')
  const availability = notes.length > 0 ? `\n\n${notes.join('\n')}` : ''

  return `You are the researcher of "${input.series}", a two-host podcast in ${languageName} that turns the listener's own notes into an episode.

The SOURCE is the listener's material and stays verbatim for the writers — your job is to make the writers' room UNDERSTAND it and to bring what they lack: context from the listener's brain (search it for the topic and adjacent notes, read what matters), what previous episodes already covered (so they don't repeat it), and the outside world. The listener's recurring failure is EXTERNAL NAMES nobody explains — third-party projects, tools, companies, standards and acronyms the notes take for granted (the notes' author knows them, a listener does not). So: first list every such name in the SOURCE that neither the SOURCE itself nor the brain notes you read explain, then look them up with ONE batched \`research\` query (all names in one question, asking for one plain sentence each: what it is and what it is for here). Web research is expected, not a last resort: follow with further, distinct runs for every fact the episode hinges on, every claim the notes make about the outside world that you cannot confirm from the brain, and every name the first run left unclear. Every proper name, place or term a listener would not know goes into the glossary with a plain-words handle — the glossary is built from what the brain and the research found, never from your guess; a name you could not resolve is glossed with only what the SOURCE implies. There is no research budget to ration — quality first — but batch the names, never one call per name, never the same query twice. Every \`research\` run here is quick depth — good for a name or term needing one plain sentence; that is a fixed property of this stage, not your call. If quick's answer leaves a fact genuinely too thin to put on air, do not re-run it deeper — list it in \`openQuestions\` instead, in enough concrete words that the editor can tell it is load-bearing; a deeper look happens later, if the editor decides it is.

Finish with STRICT JSON and nothing else, matching exactly this shape:
{"summary":"…","additions":[{"source":"brain: <path>"|"research: <query>"|"episode: <id>","text":"…"}],"glossary":[{"term":"…","plain":"…"}],"priorCoverage":[{"episodeId":"…","title":"…","covered":"…"}],"openQuestions":["…"]}${availability}`
}

function buildUserContent(input: ResearchInput): string {
  const parts = [`SOURCE:\n${input.source}`]
  if (input.brief) parts.push(`BRIEF:\n${input.brief}`)
  if (input.title) parts.push(`TITLE HINT:\n${input.title}`)
  return parts.join('\n\n')
}

/** The dossier and what the stage's `research` runs cost (their own run records carry the detail). */
export interface ResearchStageResult {
  dossier: Dossier
  researchUnpriced: number
}

/** Run the research stage; rethrows on failure: the caller proceeds without a dossier. */
export async function runPodcastResearch(
  llm: Llm,
  input: ResearchInput,
  deps: ResearchDeps,
): Promise<ResearchStageResult> {
  deps.spend ??= { usd: 0, unpriced: 0 }
  const spend = deps.spend
  const result = await runToolLoop(llm, {
    route: 'podcast.research',
    systemPrompt: buildSystemPrompt(input, deps),
    userContent: buildUserContent(input),
    tools: buildResearchTools(deps),
    // Reasoning at high effort spends generously against the same budget; a starved round retries with double.
    maxCompletionTokens: 32000,
    stage: 'research',
  })
  let dossier: Dossier
  try {
    dossier = parseDossier(result.content)
  } catch (err) {
    // The research already ran (and cost money): ask once for the same content as valid JSON.
    log.warn('research dossier did not parse, asking for a JSON repair', {
      error: err instanceof Error ? err.message : String(err),
      chars: result.content.length,
    })
    const fixed = await runToolLoop(llm, {
      route: 'podcast.research',
      systemPrompt:
        'You repair JSON. The user message is a research dossier that should be ONE valid JSON object but is not (unescaped quotes inside strings, stray prose, a cut-off tail). Return the SAME content as a single valid JSON object — escape inner quotes, keep every entry, add nothing — and nothing else.',
      userContent: result.content,
      tools: [],
      maxCompletionTokens: 32000,
      stage: 'research',
    })
    dossier = parseDossier(fixed.content)
  }
  return {
    dossier: { ...dossier, toolCalls: result.calls, researchUsd: spend.usd },
    researchUnpriced: spend.unpriced,
  }
}

/** Case/whitespace/punctuation-insensitive key, so a trivial slip in the editor's verbatim copy still matches. */
function normalizeOpenQuestion(question: string): string {
  return question
    .trim()
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .replace(/[.,;:!?]+$/u, '')
    .trim()
}

/**
 * Drops answered open questions so the outro cannot reopen a gap the follow-up research just closed. Matches on
 * `LoadBearingFact.openQuestion` (the editor's own copy of the entry), never on the reworded research question.
 */
export function dropAnsweredOpenQuestions(openQuestions: string[], answeredOpenQuestions: string[]): string[] {
  if (answeredOpenQuestions.length === 0) return openQuestions
  const answered = new Set(answeredOpenQuestions.map(normalizeOpenQuestion))
  return openQuestions.filter((q) => !answered.has(normalizeOpenQuestion(q)))
}

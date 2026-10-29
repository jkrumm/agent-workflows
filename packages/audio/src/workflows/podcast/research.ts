import { fenced, fenceErrors, fenceRule, fenceToken } from './fence.ts'
import type { Llm, ToolDef } from './llm.ts'
import { runToolLoop } from './llm.ts'
import { log } from './log.ts'
import type { BrainPort, HistoryPort, ResearchDepth, ResearchPort } from './ports.ts'
import { researchAnswered, researchKey, researchRunKey } from './ports.ts'
import { repairGermanQuotes } from './script.ts'
import type { Dossier, LoadBearingFact, ToolCallRecord } from './types.ts'

// The research stage (audio-gateway `podcast-research.ts`): a tool loop that reads the listener's own material, gives
// the writers' room eyes on the brain and past episodes, and runs the host's `research` workflow on what is genuinely
// missing. Best-effort: the workflow decides what a throw means (write from the source alone).
//
// Privacy: the brain notes the tools read go to the research model, as they did on legacy; they are the episode's
// source. The vault capabilities keep the agent's reads inside `wiki/`, `Areas/` and `Projects/`, and every tool result
// reaches the model fenced as untrusted data (`fence.ts`), so a note cannot steer the loop into reading other notes
// and sending them out in a research query.

export interface ResearchInput {
  source: string
  brief?: string
  title?: string
  language: 'de' | 'en'
  series: string
}

/** Where a host research run comes from: its idempotency key is this run, this step and the query. */
export interface ResearchOrigin {
  runId: string
  stepId: string
}

export interface ResearchDeps {
  /** Absent: no brain tools. */
  brain?: BrainPort
  /** Absent: no `research` tool. `maxCalls`: an optional emergency valve on runs per episode (absent: unlimited). */
  research?: {
    port: ResearchPort
    origin: ResearchOrigin
    /** The runs this step already started, by key and status (`startedByKey` over the journal). */
    started: ReadonlyMap<string, string>
    maxCalls?: number
  }
  history: HistoryPort
  series: string
  signal: AbortSignal
  /** Resets the step's idle timer while a research run is waited on. */
  progress: () => void
  /** The fence token of this loop's tool results; default a fresh one. */
  token?: string
}

const BRAIN_READ_MAX_CHARS = 60_000
const PAST_TRANSCRIPT_MAX_CHARS = 40_000
const RESEARCH_REPORT_MAX_CHARS = 20_000
const DEFAULT_SEARCH_LIMIT = 8
/** The vault capability's ceiling per search. */
const MAX_SEARCH_LIMIT = 50
const DEFAULT_PAST_EPISODES_LIMIT = 10
/** The editor names at most this many load-bearing facts; each is one standard-depth run and one step. */
export const MAX_LOAD_BEARING_FACTS = 3

const clampLimit = (value: unknown, fallback: number, max: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(1, Math.round(value))) : fallback

// ---------------------------------------------------------------------------
// Tools: every result that carries outside text goes back fenced.
// ---------------------------------------------------------------------------

export function brainSearchTool(brain: BrainPort, signal: AbortSignal, token: string): ToolDef {
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
      return fenced(JSON.stringify(result), token)
    },
  }
}

export function brainReadTool(brain: BrainPort, signal: AbortSignal, token: string): ToolDef {
  return {
    name: 'brain_read',
    description: "Read one note from the listener's vault by its vault-relative path (as returned by brain_search).",
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    execute: async (rawArgs) => {
      const path = String((rawArgs as { path?: unknown }).path ?? '')
      const note = await brain.read(path, BRAIN_READ_MAX_CHARS, signal)
      if (!note.found) throw new Error(note.reason)
      const { frontmatter, body, truncated } = note
      return fenced(JSON.stringify({ path: note.path, frontmatter, body, truncated }), token)
    },
  }
}

function pastEpisodesTool(history: HistoryPort, series: string, token: string): ToolDef {
  return {
    name: 'past_episodes',
    description: 'List recent finished episodes of this podcast, newest first, with their editorial profile.',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Max episodes, default 10.' } },
    },
    execute: async (rawArgs) => {
      const limit = clampLimit((rawArgs as { limit?: unknown }).limit, DEFAULT_PAST_EPISODES_LIMIT, 50)
      return fenced(JSON.stringify(await history.recent(series, limit)), token)
    },
  }
}

function pastTranscriptTool(history: HistoryPort, token: string): ToolDef {
  return {
    name: 'past_transcript',
    description: 'Read the full markdown transcript of a past episode by its id (from past_episodes).',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    execute: async (rawArgs) => {
      const id = String((rawArgs as { id?: unknown }).id ?? '')
      const transcript = await history.transcript(id)
      if (transcript == null) return `error: no transcript found for episode "${id}"`
      const capped =
        transcript.length > PAST_TRANSCRIPT_MAX_CHARS
          ? `${transcript.slice(0, PAST_TRANSCRIPT_MAX_CHARS)}\n\n[truncated at ${PAST_TRANSCRIPT_MAX_CHARS} chars]`
          : transcript
      return fenced(capped, token)
    },
  }
}

/** A finished research run as the model reads it: the report, capped, and its sources. */
function renderAnswer(report: string, sources: string[]): string {
  const sourcesBlock = sources.length > 0 ? `\n\nSources:\n${sources.map((s) => `- ${s}`).join('\n')}` : ''
  return `${report.slice(0, RESEARCH_REPORT_MAX_CHARS)}${sourcesBlock}`
}

/** A query as it is keyed and sent: trimmed, whitespace collapsed. The host keys the input too, so both must agree. */
const asAsked = (query: string): string => query.replace(/\s+/g, ' ').trim()

/** How many distinct questions already have a finished answer among a step's started runs. */
function answeredCount(started: ReadonlyMap<string, string>): number {
  const bases = new Set<string>()
  for (const [key, status] of started) if (status === 'done') bases.add(key.replace(/:2$/, ''))
  return bases.size
}

function researchTool(
  research: NonNullable<ResearchDeps['research']>,
  signal: AbortSignal,
  progress: () => void,
  token: string,
): ToolDef {
  // The step's own record, not this attempt's: runs an earlier attempt or a resumed run of this step started are in
  // `started` (from the journal), so the valve bounds the step and a repeated question re-attaches to its run.
  const started = new Map(research.started)
  let used = answeredCount(started)
  return {
    name: 'research',
    description:
      "Web research through the platform's research workflow — EXPECTED, not a last resort, for anything the listener needs that the SOURCE and the brain do not explain: the external third-party names, projects, tools, companies and standards the notes take for granted (batch them in ONE query asking for one plain sentence each: what it is and what it is for here), facts the episode hinges on, current numbers, and the claims the notes make about the outside world. Several runs per episode are normal; keep each query specific and distinct (an identical query is not run twice). Every run here is quick depth — a name or term needing one plain sentence; it is not yours to request more than that (see the system prompt).",
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    execute: async (rawArgs) => {
      const query = asAsked(String((rawArgs as { query?: unknown }).query ?? ''))
      if (!query) throw new Error('give a query')
      // Quick only: the researcher's own judgement on what deserves standard depth was the overspend failure on
      // legacy. Standard depth exists only in the follow-up, on facts the editor named.
      const depth: ResearchDepth = 'quick'
      const base = researchKey(research.origin.runId, research.origin.stepId, depth, query)
      // An identical query gets its finished run's answer back from the host: no second run, no second charge.
      const repeat = researchAnswered(base, started)
      if (!repeat && research.maxCalls !== undefined && research.maxCalls > 0 && used >= research.maxCalls) {
        return `research budget exhausted (${research.maxCalls} calls)`
      }
      const key = researchRunKey(base, started)
      const result = await research.port.run(query, depth, { key, signal, progress })
      started.set(key, result.ok ? 'done' : 'failed')
      if (!result.ok) return fenced(result.error, token)
      // Debited only once a run ended done: a refused or failed run does not consume a slot.
      if (!repeat) used++
      const answer = fenced(renderAnswer(result.report, result.sources), token)
      return repeat ? `(this exact query was already run — same result)\n${answer}` : answer
    },
  }
}

export interface LoadBearingAnswer {
  addition: Dossier['additions'][number] | null
  toolCall: ToolCallRecord
  /** The fact's `openQuestion` when it was answered and named one: the caller drops exactly that entry. */
  answeredOpenQuestion: string | null
}

/**
 * One editor-named load-bearing fact at standard depth: the only place `standard` runs. Code decides the query
 * (`fact.question`); the answer closes `fact.openQuestion`, the editor's verbatim copy. Best-effort: a failed run is
 * logged and comes back without an addition. One call per workflow step (`research:fact:<i>`), keyed to that step:
 * a resume never repeats a finished fact and re-attaches to an unfinished one (`started`, the step's journal record).
 */
export async function researchLoadBearingFact(
  fact: LoadBearingFact,
  deps: {
    research: ResearchPort
    origin: ResearchOrigin
    started: ReadonlyMap<string, string>
    signal: AbortSignal
    progress: () => void
  },
): Promise<LoadBearingAnswer> {
  const startedAt = Date.now()
  const question = asAsked(fact.question)
  const args = { query: question, depth: 'standard' }
  const key = researchRunKey(researchKey(deps.origin.runId, deps.origin.stepId, 'standard', question), deps.started)
  const result = await deps.research.run(question, 'standard', { key, signal: deps.signal, progress: deps.progress })
  if (!result.ok) {
    log.warn('podcast load-bearing research failed, skipping this fact', { fact: question, error: result.error })
    return {
      addition: null,
      toolCall: { tool: 'research', args, ok: false, ms: Date.now() - startedAt },
      answeredOpenQuestion: null,
    }
  }
  return {
    addition: { source: `research: ${question}`, text: renderAnswer(result.report, result.sources) },
    toolCall: { tool: 'research', args, ok: true, ms: Date.now() - startedAt },
    answeredOpenQuestion: fact.openQuestion || null,
  }
}

/**
 * The editor's facts as they run: duplicates (by normalised question) once, at most `MAX_LOAD_BEARING_FACTS`. A fact
 * the quick pass already asked is still run at standard depth, as on legacy: the editor names a fact exactly because
 * the quick answer was too thin to put on air, and the two depths are different runs under different keys.
 */
export function loadBearingToRun(facts: LoadBearingFact[]): LoadBearingFact[] {
  const seen = new Set<string>()
  return facts
    .filter((fact) => {
      const normalized = asAsked(fact.question).toLowerCase()
      if (!normalized || seen.has(normalized)) return false
      seen.add(normalized)
      return true
    })
    .slice(0, MAX_LOAD_BEARING_FACTS)
}

export function buildResearchTools(deps: ResearchDeps & { token: string }): ToolDef[] {
  const { token } = deps
  const tools: ToolDef[] = []
  if (deps.brain) {
    tools.push(brainSearchTool(deps.brain, deps.signal, token), brainReadTool(deps.brain, deps.signal, token))
  }
  tools.push(pastEpisodesTool(deps.history, deps.series, token), pastTranscriptTool(deps.history, token))
  if (deps.research) tools.push(researchTool(deps.research, deps.signal, deps.progress, token))
  // A thrown error carries outside text too (a vault refusal names the note, a host error quotes the host).
  return tools.map((tool) => fenceErrors(tool, token))
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

function buildSystemPrompt(input: ResearchInput, deps: ResearchDeps, token: string): string {
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
{"summary":"…","additions":[{"source":"brain: <path>"|"research: <query>"|"episode: <id>","text":"…"}],"glossary":[{"term":"…","plain":"…"}],"priorCoverage":[{"episodeId":"…","title":"…","covered":"…"}],"openQuestions":["…"]}${availability}${fenceRule(token)}`
}

function buildUserContent(input: ResearchInput, token: string): string {
  // The source is the owner's notes and pasted text: material to research, read as data like any tool result.
  const parts = [`SOURCE:\n${fenced(input.source, token)}`]
  if (input.brief) parts.push(`BRIEF:\n${input.brief}`)
  if (input.title) parts.push(`TITLE HINT:\n${input.title}`)
  return parts.join('\n\n')
}

/** Run the research stage; rethrows on failure: the caller proceeds without a dossier. */
export async function runPodcastResearch(llm: Llm, input: ResearchInput, deps: ResearchDeps): Promise<Dossier> {
  const token = deps.token ?? fenceToken()
  const result = await runToolLoop(llm, {
    route: 'podcast.research',
    systemPrompt: buildSystemPrompt(input, deps, token),
    userContent: buildUserContent(input, token),
    tools: buildResearchTools({ ...deps, token }),
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
  return { ...dossier, toolCalls: result.calls }
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

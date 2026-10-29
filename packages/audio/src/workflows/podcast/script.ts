import { assignAsks } from './asks.ts'
import { expressionSummary, lintSegments, OPENING_FRAME_TURNS } from './lint.ts'
import { callAndParse, type Llm, writerBudget } from './llm.ts'
import { log } from './log.ts'
import type { Dossier, EpisodeBrief, EpisodeProfile } from './types.ts'
import { DELIVERY_KEYS, SPEECH_TAGS, stripDisallowedTags, TAG_PATTERN } from './vocab.ts'

// The writers' room's prompts and pure helpers (audio-gateway `podcast-script.ts`; the orchestration moved to
// `room.ts` and the workflow's steps). It writes the episode the EDITORIAL BRIEF decided on (`editorial.ts`): format,
// roles, tone, humor, opening, closing, rhythm and length are the brief's call; there is no house formula in these
// prompts, only hard limits (tag vocabulary, turn ceilings, segment bounds) and the ear-writing rules. The outline
// route plans the story; the write route is the sole voice owner (every segment and every revision); every reviewer
// role runs on every reviewer route, advisory only; the metadata route writes the locked episode's metadata. The show
// bible and the owner's voice guide are injected verbatim into the writing prompts.

export interface PodcastHost {
  id: 'A' | 'B'
  name: string
  voice: string
  /** ElevenLabs-fallback speed (0.7–1.2); omitted = the model's own pace. The 3.8 lane paces through the host style string instead. */
  speed?: number
}

export interface PodcastScriptRequest {
  /** Raw notes/markdown the episode is about (may be 5-100k chars). */
  source: string
  /** What the listener wants from this episode / who they are. */
  brief?: string
  /** Optional episode title hint — the outline still decides the final title. */
  title?: string
  language: 'de' | 'en'
  /** Target length as REQUESTED; the episode is actually planned against `episodeBrief.minutes`. */
  minutes: number
  hosts: [PodcastHost, PodcastHost]
  /** Show name, for the intro. */
  series: string
  /** What the research stage found — additions, glossary, prior coverage, open questions. May be `EMPTY_DOSSIER`. */
  dossier: Dossier
  /** The editor's decision for THIS episode: shape, roles, tone, humor, rhythm, length. Binding. */
  episodeBrief: EpisodeBrief
}

export interface ScriptTurn {
  speaker: 'A' | 'B'
  text: string
  /** A key of `DELIVERY_STYLES` where the moment changes; absent = the host's baseline. Unknown keys are kept so the lint can flag them — the synth ignores them. */
  delivery?: string
}

export interface ScriptSegment {
  title: string
  turns: ScriptTurn[]
}

export interface PodcastScript {
  title: string
  /** 2-4 sentences, show-notes style, in `language`. */
  description: string
  /** English, for an image model. */
  coverPrompt: string
  genres: string[]
  language: 'de' | 'en'
  segments: ScriptSegment[]
  wordCount: number
  /** 3–6 short archive labels from the metadata pass; `[]` when that pass was skipped or failed. */
  topics: string[]
  /** The listener asks and the segment that owns each (outline assignment); absent on older scripts. */
  asks?: Array<{ ask: string; segmentIndex: number }>
  /** What the opening was checked against (the asks, the through-line). */
  openingFrame?: string[]
}

/** One segment spec from the outline pass — the brief for its own segment-writing call. */
export interface OutlineSegmentSpec {
  title: string
  goal: string
  /** Verbatim facts/numbers from the source that MUST be spoken in this segment. */
  keyFacts: string[]
  targetWords: number
  /** The question/disagreement this segment turns on. */
  tension: string
  /** Listener asks (from the brief's `asks`) this segment owes an explicit verdict. */
  answers?: string[]
}

/** A fact/twist/decision deliberately withheld until a specific later segment. */
export interface OutlineReveal {
  text: string
  /** 0-based index of the segment this reveal lands in. */
  segmentIndex: number
}

/** A planned side-trip (joke, anecdote, example, "what if") assigned to one segment. */
export interface OutlineDigression {
  beat: string
  /** 0-based index of the segment that hosts this digression. */
  segmentIndex: number
  /** The line that pulls the conversation back to the main thread afterward. */
  returnHook: string
}

export interface Outline {
  title: string
  description: string
  coverPrompt: string
  genres: string[]
  /** The running joke or motif the hosts return to. Empty unless the brief's devices asked for one. */
  motif: string
  /** The one question the episode is really answering. Empty when the material has no single question. */
  throughLine: string
  /** The opening beat, when the brief's opening/devices call for one — must not summarize the episode. Often empty. */
  hook: string
  reveals: OutlineReveal[]
  digressions: OutlineDigression[]
  segments: OutlineSegmentSpec[]
}

/** A note from one reviewer pass, targeting a segment/turn or the whole episode (`segmentIndex: null`). */
export interface ReviewNote {
  segmentIndex: number | null
  turnIndex: number | null
  /** `<role>@<model>` — who said this, so the writer (and the reader of a log) can weigh it. */
  reviewer: string
  note: string
}

export const PODCAST_TAGS = SPEECH_TAGS

/** The segment/revision reply shape — `delivery` is optional (baseline turns omit it). Sent to Claude as `output_config.format`. */
export const SEGMENT_TURNS_SCHEMA = {
  type: 'object',
  properties: {
    turns: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          speaker: { type: 'string', enum: ['A', 'B'] },
          text: { type: 'string' },
          delivery: { type: 'string', enum: DELIVERY_KEYS },
        },
        required: ['speaker', 'text'],
        additionalProperties: false,
      },
    },
  },
  required: ['turns'],
  additionalProperties: false,
} as const satisfies Record<string, unknown>

/** Below this many words a tag is the whole delivery — v3 then tends to speak it; strip instead. */
const TAG_MIN_TURN_WORDS = 12

/** Planning rate, German two hosts, gaps included. Measured on 3.8 (2026-10-25): test episode 10a620e1 = 455 words in 187 s = 146 wpm; raw chunk renders run 155–170 wpm before gaps. v3 episodes measured 135–149 (150 planned 22 minutes and delivered 25–36), so plan low. */
export const WORDS_PER_MINUTE = 145
const MIN_SEGMENTS = 3
export const MAX_SEGMENTS = 9
const MINUTES_PER_SEGMENT = 4
const DEFAULT_SPLIT_MAX_CHARS = 1400
/** Safety ceiling on turn length — enforced here, not preached in the prompt (the writer decides rhythm). */
const MAX_TURN_WORDS = 180
/** A turn shorter than this is a fragment ("Echt?", "Mhm.") worth folding into its neighbour. */
const MERGE_SHORT_TURN_CHARS = 40

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * ~4 minutes per segment, clamped to a sane 3..9 range regardless of episode
 * length. Only the FALLBACK now (`defaultEpisodeBrief`) — a real episode's
 * segment count comes from the editor's brief, which may go as low as 1.
 */
export function planSegmentCount(minutes: number): number {
  return Math.min(MAX_SEGMENTS, Math.max(MIN_SEGMENTS, Math.round(minutes / MINUTES_PER_SEGMENT)))
}

/** One in-flight/loaded read per path — a missing file logs its warning exactly once, not once per prompt. */
/**
 * Load the show bible (house style, binding) from disk. Read on every call —
 * it is a few KB, a job builds a dozen prompts, and not caching keeps this
 * module free of process-wide state (a test or a mounted volume can change
 * the file between jobs). A missing file is not fatal — the show bible is
 * polish, not the episode — so it resolves to an empty string with a warning.
 * Exported for tests.
 */
export async function loadShowBible(path: string): Promise<string> {
  try {
    return await Bun.file(path).text()
  } catch (err) {
    log.warn('podcast show bible not found, continuing without it', {
      path,
      error: err instanceof Error ? err.message : String(err),
    })
    return ''
  }
}

/** Voice-guide paths already reported (missing or unreadable) — the warning is logged once per path, not once per prompt. */
const warnedVoicePaths = new Set<string>()

/**
 * Load the owner's general voice guide (brain/voice.md). Optional: a missing
 * file (ENOENT) logs ONE "not found" warning per path; any other read error
 * (permissions, EISDIR, …) is logged once per path as unreadable, with its
 * error code. Either way it resolves to an empty string, so the show bible alone
 * carries the episode — a voice guide must never fail an episode. Read on every
 * call, like `loadShowBible`. Exported for tests.
 */
export async function loadVoiceGuide(path: string): Promise<string> {
  try {
    return await Bun.file(path).text()
  } catch (err) {
    if (warnedVoicePaths.has(path)) return ''
    warnedVoicePaths.add(path)
    const code = (err as NodeJS.ErrnoException).code
    const error = err instanceof Error ? err.message : String(err)
    if (code === 'ENOENT') {
      log.warn('podcast voice guide not found, continuing without it', { path, error })
    } else {
      log.warn('podcast voice guide unreadable, continuing without it', { path, code: code ?? 'unknown', error })
    }
    return ''
  }
}

/**
 * Render the voice guide ahead of the show bible in the writing prompts; omitted
 * entirely when blank. It is the owner's GENERAL voice for text — the output here
 * is spoken dialogue, so the show bible wins and the guide's visual/layout advice
 * does not apply.
 */
function voiceSection(voice: string): string {
  if (!voice.trim()) return ''
  return `\n\nOWNER'S VOICE GUIDE (the owner's general voice; the SHOW BIBLE below overrides it for spoken audio; ignore its markdown, layout, table, visual and image guidance — the output is spoken dialogue):\n${voice.trim()}`
}

/** Render the show bible as a binding section appended to a system prompt; omitted entirely when blank. */
function showBibleSection(showBible: string): string {
  if (!showBible.trim()) return ''
  return `\n\nSHOW BIBLE (house style — binding):\n${showBible.trim()}`
}

/** Strip ```json fences and leading/trailing prose, returning the first balanced-looking `{...}` slice. Shared with `podcast-editorial.ts`. */
export function extractJsonObject(raw: string): string {
  const fenced = raw.replace(/```(?:json)?/gi, '').trim()
  const start = fenced.indexOf('{')
  const end = fenced.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`expected a JSON object, got: ${raw.slice(0, 200)}`)
  }
  return repairGermanQuotes(fenced.slice(start, end + 1))
}

/** A German „…" quote closed with an unescaped ASCII `"` instead of `“` — Opus did this twice in a row
 *  on one segment (2026-10-19) and the JSON broke. `„` never occurs in JSON syntax, so closing it with
 *  `“` is safe; the repair is only used when the original fails to parse and the repaired one parses. */
export function repairGermanQuotes(json: string): string {
  if (!json.includes('„') || parses(json)) return json
  const repaired = json.replace(/„([^"„“\n\\]*)"/g, '„$1“')
  if (!parses(repaired)) return json
  log.warn('podcast JSON repaired: German quote closed with an ASCII quote', { excerpt: repairExcerpt(json, repaired) })
  return repaired
}

/** A short slice of the repaired text around the first changed character, for the warn log. */
function repairExcerpt(original: string, repaired: string): string {
  let at = 0
  while (at < original.length && original[at] === repaired[at]) at++
  return repaired.slice(Math.max(0, at - 40), at + 40)
}

function parses(json: string): boolean {
  try {
    JSON.parse(json)
    return true
  } catch {
    return false
  }
}

/**
 * Blank the dramaturgy devices the episode brief did not ask for, so a writer
 * model's tendency to invent a hook/motif/reveal/digression regardless of the
 * brief (the single most common failure of this show, per the outline/segment
 * prompts above) is enforced in code rather than only asked for. Exported for
 * tests; called right after `parseOutline` in `planOutline` (room.ts), before
 * `buildSegmentUserContent` ever reads `outline.hook`.
 */
export function pruneUnrequestedDevices(outline: Outline, brief: EpisodeBrief): Outline {
  const devices = brief.devices.join(' ').toLowerCase()
  const wants = (...keywords: string[]): boolean => keywords.some((keyword) => devices.includes(keyword))
  return {
    ...outline,
    hook: wants('hook', 'cold open', 'opening beat', 'einstieg') ? outline.hook : '',
    motif: wants('motif', 'running', 'leitmotiv') ? outline.motif : '',
    reveals: wants('reveal', 'withheld', 'withhold') ? outline.reveals : [],
    digressions: wants('digression', 'side-trip', 'anecdote', 'abschweif') ? outline.digressions : [],
  }
}

/** Clamp a reveal/digression's 0-based segment index onto a real segment, defensively. */
function clampSegmentIndex(value: number, segmentCount: number): number {
  return Math.min(Math.max(Math.round(value), 0), Math.max(segmentCount - 1, 0))
}

function parseReveals(raw: unknown, segmentCount: number): OutlineReveal[] {
  if (!Array.isArray(raw)) return []
  const out: OutlineReveal[] = []
  for (const item of raw) {
    const obj = (item ?? {}) as Record<string, unknown>
    const text = typeof obj['text'] === 'string' ? obj['text'].trim() : ''
    if (!text || typeof obj['segment'] !== 'number') continue
    out.push({ text, segmentIndex: clampSegmentIndex(obj['segment'], segmentCount) })
  }
  return out
}

function parseDigressions(raw: unknown, segmentCount: number): OutlineDigression[] {
  if (!Array.isArray(raw)) return []
  const out: OutlineDigression[] = []
  for (const item of raw) {
    const obj = (item ?? {}) as Record<string, unknown>
    const beat = typeof obj['beat'] === 'string' ? obj['beat'].trim() : ''
    if (!beat || typeof obj['segment'] !== 'number') continue
    out.push({
      beat,
      segmentIndex: clampSegmentIndex(obj['segment'], segmentCount),
      returnHook: typeof obj['return_hook'] === 'string' ? obj['return_hook'].trim() : '',
    })
  }
  return out
}

/**
 * Parse the outline LLM's reply into an {@link Outline}. Tolerant of markdown
 * fences and leading prose (see `extractJsonObject`); missing/malformed
 * per-segment fields fall back to safe defaults rather than throwing, since a
 * partially-broken outline is still usable — only a wholly missing
 * `segments` array is fatal. The dramaturgy fields (`through_line`, `hook`,
 * `reveals`, `digressions`) default to empty/blank so older fixtures and a
 * writer reply that omits them still parse.
 */
export function parseOutline(raw: string): Outline {
  const parsed = JSON.parse(extractJsonObject(raw)) as {
    title?: unknown
    description?: unknown
    cover_prompt?: unknown
    genres?: unknown
    motif?: unknown
    through_line?: unknown
    hook?: unknown
    reveals?: unknown
    digressions?: unknown
    segments?: unknown
  }
  if (!Array.isArray(parsed.segments) || parsed.segments.length === 0) {
    throw new Error(`outline returned no segments: ${raw.slice(0, 200)}`)
  }

  const segments: OutlineSegmentSpec[] = parsed.segments.map((raw, i) => {
    const obj = (raw ?? {}) as Record<string, unknown>
    const keyFacts = Array.isArray(obj['key_facts'])
      ? obj['key_facts'].filter((f): f is string => typeof f === 'string' && f.trim().length > 0)
      : []
    return {
      title: typeof obj['title'] === 'string' && obj['title'].trim() ? obj['title'].trim() : `Segment ${i + 1}`,
      goal: typeof obj['goal'] === 'string' ? obj['goal'].trim() : '',
      keyFacts,
      targetWords:
        typeof obj['target_words'] === 'number' && obj['target_words'] > 0 ? Math.round(obj['target_words']) : 200,
      tension: typeof obj['tension'] === 'string' ? obj['tension'].trim() : '',
      answers: Array.isArray(obj['answers'])
        ? obj['answers'].filter((a): a is string => typeof a === 'string' && a.trim().length > 0)
        : [],
    }
  })

  return {
    title: typeof parsed.title === 'string' ? parsed.title.trim() : '',
    description: typeof parsed.description === 'string' ? parsed.description.trim() : '',
    coverPrompt: typeof parsed.cover_prompt === 'string' ? parsed.cover_prompt.trim() : '',
    genres: Array.isArray(parsed.genres) ? parsed.genres.filter((g): g is string => typeof g === 'string') : [],
    motif: typeof parsed.motif === 'string' ? parsed.motif.trim() : '',
    throughLine: typeof parsed.through_line === 'string' ? parsed.through_line.trim() : '',
    hook: typeof parsed.hook === 'string' ? parsed.hook.trim() : '',
    reveals: parseReveals(parsed.reveals, segments.length),
    digressions: parseDigressions(parsed.digressions, segments.length),
    segments,
  }
}

/**
 * Parse a reviewer LLM's reply into its notes + one-line verdict. Same
 * fence/prose tolerance as {@link parseOutline}; a note missing its `note`
 * text is dropped, `segment`/`turn` default to `null` (episode-wide). Every
 * note is stamped with `reviewer` (`<role>@<model>`) so the revision pass
 * (and the logs) can see who said what.
 */
export function parseReviewNotes(raw: string, reviewer: string): { notes: ReviewNote[]; verdict: string } {
  const parsed = JSON.parse(extractJsonObject(raw)) as { notes?: unknown; verdict?: unknown }
  const notesRaw = Array.isArray(parsed.notes) ? parsed.notes : []
  const notes: ReviewNote[] = []
  for (const item of notesRaw) {
    const obj = (item ?? {}) as Record<string, unknown>
    const note = typeof obj['note'] === 'string' ? obj['note'].trim() : ''
    if (!note) continue
    notes.push({
      segmentIndex: typeof obj['segment'] === 'number' ? Math.round(obj['segment']) : null,
      turnIndex: typeof obj['turn'] === 'number' ? Math.round(obj['turn']) : null,
      reviewer,
      note,
    })
  }
  return { notes, verdict: typeof parsed.verdict === 'string' ? parsed.verdict.trim() : '' }
}

/** A short "Name:" / "A:" label the model leaked at the start of a turn's text, despite the JSON `speaker` field. */
const LEAKED_LABEL = /^[A-ZÄÖÜ][\wÄÖÜäöüß'-]{0,20}:\s+/

/**
 * Parse a segment LLM's reply into {@link ScriptTurn}s. Same fence/prose
 * tolerance as {@link parseOutline}; drops turns with no usable speaker/text,
 * and strips a leaked speaker label the model sometimes repeats inside the
 * text itself even though the JSON already carries `speaker`.
 */
export function parseSegmentTurns(raw: string): ScriptTurn[] {
  const parsed = JSON.parse(extractJsonObject(raw)) as { turns?: unknown }
  if (!Array.isArray(parsed.turns)) {
    throw new Error(`segment reply returned no turns: ${raw.slice(0, 200)}`)
  }

  const turns: ScriptTurn[] = []
  for (const raw of parsed.turns) {
    const obj = (raw ?? {}) as Record<string, unknown>
    const speakerRaw = typeof obj['speaker'] === 'string' ? obj['speaker'].trim().toUpperCase() : ''
    const speaker: 'A' | 'B' | null = speakerRaw === 'A' || speakerRaw === 'B' ? speakerRaw : null
    const text = typeof obj['text'] === 'string' ? obj['text'].trim().replace(LEAKED_LABEL, '') : ''
    if (!speaker || !text) continue
    const delivery = typeof obj['delivery'] === 'string' ? obj['delivery'].trim().toLowerCase() : ''
    turns.push({ speaker, text, ...(delivery && { delivery }) })
  }
  return turns
}

/** A tag as the whole delivery of a short line ("<laugh> Da ist sie.") sounds staged — drop every tag below the word floor. */
function stripTagsOnShortTurn(text: string): string {
  const words = text.replace(TAG_PATTERN, '').trim().split(/\s+/).filter(Boolean).length
  if (words >= TAG_MIN_TURN_WORDS) return text
  return collapseWhitespace(text.replace(TAG_PATTERN, ''))
}

/** Strip markdown decoration, bullets and emoji left over from the LLM's reply — numbers/digits are left alone. */
function stripMarkdown(text: string): string {
  return text
    .replace(/^[\s]*>+[ \t]?/gm, '') // blockquote markers only — a `>` also closes a <tag>
    .replace(/[*_`#]+/g, '')
    .replace(/^[\s]*[-•●▪◦*]\s+/gm, '')
    .replace(/\p{Extended_Pictographic}️?/gu, '')
}

const collapseWhitespace = (text: string): string =>
  text
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** Split terminal-punctuated sentences, keeping the punctuation — good enough for spoken-turn seams. */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * Break one over-long turn into consecutive turns by the SAME speaker, at
 * sentence boundaries. Splits on whichever safety ceiling is hit first —
 * chars or words — since the writer prompt no longer preaches a word quota.
 */
function splitLongTurn(turn: ScriptTurn, maxChars: number, maxWords: number): ScriptTurn[] {
  if (turn.text.length <= maxChars && countWords(turn.text) <= maxWords) return [turn]
  const sentences = splitSentences(turn.text)
  const out: ScriptTurn[] = []
  let buf = ''
  for (const sentence of sentences) {
    const merged = buf ? `${buf} ${sentence}` : sentence
    if (buf && (merged.length > maxChars || countWords(merged) > maxWords)) {
      out.push({ ...turn, text: buf })
      buf = sentence
    } else {
      buf = merged
    }
  }
  if (buf) out.push({ ...turn, text: buf })
  // A delivery marks the moment the turn opens on; the continuation pieces fall back to the baseline.
  return out.length > 0
    ? out.map((piece, i) => (i === 0 ? piece : { speaker: piece.speaker, text: piece.text }))
    : [turn]
}

/**
 * Fold a turn into its predecessor when they share a speaker and the first is
 * a short fragment ("Echt?", "Mhm.") — unless doing so would push the merged
 * turn past `maxChars` (it runs after `splitLongTurn`, which already sized
 * turns to fit).
 */
function mergeShortAdjacent(turns: ScriptTurn[], maxChars: number): ScriptTurn[] {
  const out: ScriptTurn[] = []
  for (const turn of turns) {
    const prev = out[out.length - 1]
    if (prev && prev.speaker === turn.speaker && prev.text.length < MERGE_SHORT_TURN_CHARS) {
      const merged = `${prev.text} ${turn.text}`.trim()
      if (merged.length <= maxChars) {
        prev.text = merged
        continue
      }
    }
    out.push({ ...turn })
  }
  return out
}

/**
 * Clean up one segment's turns for synthesis: drop disallowed audio tags,
 * strip markdown/emoji/bullets and collapse whitespace, split any turn over
 * `maxChars` at sentence boundaries (same speaker throughout), then merge a
 * short leading fragment into its same-speaker predecessor.
 */
export function sanitizeTurns(
  turns: ScriptTurn[],
  maxChars = DEFAULT_SPLIT_MAX_CHARS,
  maxWords = MAX_TURN_WORDS,
): ScriptTurn[] {
  const cleaned = turns
    .map((t) => ({ ...t, text: collapseWhitespace(stripMarkdown(stripDisallowedTags(t.text))) }))
    .map((t) => ({ ...t, text: stripTagsOnShortTurn(t.text) }))
    .filter((t) => t.text.length > 0)
  const split = cleaned.flatMap((t) => splitLongTurn(t, maxChars, maxWords))
  return mergeShortAdjacent(split, maxChars)
}

export const countWords = (text: string): number => (text.match(/\S+/g) ?? []).length

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const LANGUAGE_LABEL: Record<'de' | 'en', string> = { de: 'German', en: 'English' }

const HUMOR_INSTRUCTION: Record<EpisodeBrief['humor'], string> = {
  none: 'none — write no jokes at all. Dry precision is allowed; a bit, a running gag or a punchline is not.',
  sparse:
    'sparse — humor only where the material itself hands it to you, at most once or twice in the whole episode. Never planned, never a running gag.',
  natural:
    'natural — let humor happen wherever it genuinely fits, in the phrasing as much as in the content. Still never a scheduled running joke.',
}

/**
 * Render the editor's brief as the binding instruction block the writers'
 * room works from. Optional parts (devices, avoid, glossary policy) appear
 * only when the editor filled them — an empty list must not read as an
 * instruction to invent one.
 */
function renderEpisodeBrief(req: PodcastScriptRequest): string {
  const brief = req.episodeBrief
  const [hostA, hostB] = req.hosts
  const lines = [
    `- Format: ${brief.format}`,
    `- Why this form for this material: ${brief.rationale}`,
    `- ${hostA.name} (A) in this episode: ${brief.roles.A}`,
    `- ${hostB.name} (B) in this episode: ${brief.roles.B}`,
    `- Tone: ${brief.tone}`,
    `- Humor: ${HUMOR_INSTRUCTION[brief.humor]}`,
    `- Opening: ${brief.opening}`,
    `- Closing: ${brief.closing}`,
    `- Rhythm: ${brief.rhythm}`,
    `- Length: about ${brief.minutes} minutes across ${brief.segments} segment(s).`,
  ]
  if (brief.asks?.length) lines.push(`- Listener asks (each needs an explicit verdict): ${brief.asks.join(' | ')}`)
  if (brief.devices.length > 0) lines.push(`- Devices to use (and only these): ${brief.devices.join('; ')}`)
  if (brief.avoid.length > 0)
    lines.push(`- Avoid (patterns from recent episodes, do not repeat them): ${brief.avoid.join('; ')}`)
  if (brief.glossaryPolicy.trim()) lines.push(`- Unfamiliar names and terms: ${brief.glossaryPolicy}`)
  return lines.join('\n')
}

/** The shared, non-negotiable rules — identical for the outline and every segment call. */
export function baseSystemPrompt(req: PodcastScriptRequest, showBible: string, voice = ''): string {
  const [hostA, hostB] = req.hosts
  const languageLabel = LANGUAGE_LABEL[req.language]
  const openQuestions = req.dossier.openQuestions
  const closeQuestionRule =
    openQuestions.length > 0
      ? `Instead the close carries exactly one open question addressed to the listener, taken from the OPEN QUESTIONS the research found (below) and turning that gap outward — a real question, not a statement ("Reicht dir das schon, oder wartest du lieber auf eine echte Studie?").`
      : `The research found no open question for this episode, so the close does not invent one — it ends the way the brief's CLOSING says.`
  return `You are the head writer of "${req.series}", a two-host podcast that turns one person's research notes into an episode that sounds like a real, well-produced show — not a read-aloud summary.

Hosts: A = ${hostA.name}, B = ${hostB.name}. Their personalities are in the show bible. What each of them IS in THIS episode — who explains, who asks, who leads, who barely speaks — comes from the EPISODE BRIEF below, nowhere else. The notes belong to the listener or a third party, never to a host: no host ever claims to have written or researched them. Both are the listener's friends, on a first-name basis, addressing the listener as "du" (German) / "you". Neither is an assistant; nobody says "als KI".

Non-negotiables:
1. Every fact, number, place name, price, date and rule comes from the SOURCE (and from the ADDITIONS, each of which names where it came from). Never invent. If the source flags something as open/unverified, the hosts say so ("das ist noch offen"). You may add widely-known general context only when it helps understanding and is clearly framed as general ("grundsätzlich…").
2. The EPISODE BRIEF decides this episode's shape, roles, tone, humor and rhythm. Follow it exactly — the editor wrote it for THIS material after reading the recent episodes. There is no house formula: no obligatory cold open, no obligatory running joke, no obligatory disagreement per segment, no obligatory three takeaways. A dense, straight walkthrough with long turns is a perfectly good episode. Whatever the brief did not ask for, do not add.
EPISODE BRIEF:
${renderEpisodeBrief(req)}
3. It is a CONVERSATION with real weight, not ping-pong. Whoever is explaining gets the floor for as long as the thought needs — a real walk-through, an example, a small story — and the other host listens, then reacts with weight, not a one-liner. Vary the rhythm as the brief asks: a long stretch, a quick exchange, a pause. Interjections exist but are rare and earned. Never alternate mechanically; never let both hosts speak in the same length all the time. The default mode of this show is KNOWLEDGE SHARING: one host knows and explains, the other asks the sharp questions the listener would ask (the number, the reason, the consequence), and both add to it. A host disagrees only when the brief says the material is genuinely contested — never to create friction, never an objection that is conceded one turn later. Sharing is not chatter: keep the density of facts, no small talk, no filler. No lists read aloud — turn any list into back-and-forth or a walked-through explanation.
4. Written for the EAR in ${languageLabel}: numbers, prices, times, units, dates and abbreviations fully spelled out as spoken (German: "dreihundertdreißig Euro", "hundertfünf Stundenkilometer", "elfter September", "zwei Meter fünfzig"); no digits, no symbols, no URLs, no markdown, no emoji, no parentheses. Place names in their local form. Expand every acronym once.
5. Numbers and names are written for the EAR, not for the page. One figure per sentence — a sentence carrying three numbers is unlistenable. Round, unless the precision IS the point: "gut dreitausend" beats "dreitausendzweiundvierzig", and "null Komma eins sieben" is only ever spoken when that digit is exactly what matters. Anchor every important figure to something the listener already knows ("das ist eine Tankfüllung", "so viel wie eine Monatsmiete"). A cluster of figures is never read out — the hosts walk through it, one figure at a time, with pauses ("…") and a real reaction in between. An unfamiliar proper name or term is introduced as WHAT IT IS before WHAT IT IS CALLED ("die Behörde, die die Maut eintreibt — die heißt …"), spoken slowly, and then gets one short handle the hosts reuse for the rest of the episode; the GLOSSARY gives you both. This covers EVERY proper name, place, person, company, project, tool and internal term or abbreviation — the notes were written for someone who already knows them, the listener has not just read them, so judge by what a stranger to the notes would know, not by what the SOURCE takes for granted. If neither SOURCE nor GLOSSARY says what a thing is, say only what the notes imply ("ein Werkzeug, das in deinen Notizen vorkommt") — never pretend to know more. Never use a name before it has been introduced that way, in one plain clause: what it is and why it matters here.
6. Expressiveness is deliberate, in three layers. (a) Punctuation first — dashes, short sentences, a question left hanging. (b) Inline tags ONLY from this list, written exactly with the angle brackets, in English even inside German text: ${PODCAST_TAGS.join(' ')}. Use them where a real person would: a few well-placed pauses (<short pause> before a number or a turn in the argument, <long pause> once for weight) and real reactions (<laugh> or <chuckle> only where something is actually funny, <sigh> where something is actually tiresome) — roughly one tag every four to eight turns, inside turns of twelve words or more, between two sentences. Never as the first word of a short line, never two tags side by side, never translated, never invented, never a tag where nothing happens. No square-bracket tags, no mood tags. Emphasis is a single word in CAPS, at most once a turn. (c) Per-turn delivery: every turn has a baseline delivery and carries NO "delivery" field. Set "delivery" ONLY on a turn where the moment changes — a host gets curious, amused, surprised, serious, has to think, speeds up, goes dry, reassures — to exactly one of: ${DELIVERY_KEYS.join(', ')}. Never the same delivery on three turns in a row, never on a line of fewer than eight words, never an invented key. Most turns have none.
6b. The notes are never a source of ignorance on air: no "steht nicht in deinen Notizen", "das wissen wir nicht" as a tic, no "in deinen Notizen" as the place something is missing, and research that came up empty is never announced as such ("dazu haben wir nichts gefunden", "wir haben dazu nichts gefunden", "konnten wir nicht herausfinden"). What is unknown about the listener becomes conditional advice ("Falls bei dir jemand schwanger ist, …") — never a statement that the notes do not say. A genuine evidence gap is never admitted in the body of the episode — not once, nowhere before the close, never as a flat statement. ${closeQuestionRule}
6c. Both hosts bring things. Whoever explains does not carry everything: the other host adds a related fact from the material, their own listener's reaction, the everyday example, the punchline — not only one-line questions. A host who only prompts is a failure unless the brief made the format an interview. When the brief asks for playful, funny, curious, the humor is in the phrasing and in how the hosts treat each other; it is allowed to be funny.
7. The episode is for the listener described in the brief; when the notes are the listener's own plan, the hosts talk about it as THEIR listener's plan ("du fährst…", "dein Van…") and give advice, not a travelogue.
8. Output STRICT JSON only, no commentary, no code fences.${voiceSection(voice)}${showBibleSection(showBible)}`
}

/** What the first lines may frame: the listener's asks, or the question the outline says the episode answers. Empty when neither exists. */
export const openingFrameOf = (brief: EpisodeBrief, outline: Outline): string[] =>
  (brief.asks ?? []).length > 0 ? [...(brief.asks ?? []), ...(outline.throughLine ? [outline.throughLine] : [])] : []

/** The outline's ask assignments in the shape lint wants. */
export const outlineAsks = (outline: Outline): Array<{ ask: string; segmentIndex: number }> =>
  outline.segments.flatMap((seg, segmentIndex) => (seg.answers ?? []).map((ask) => ({ ask, segmentIndex })))

/** Every listener ask lands in exactly one segment (the outline writer's pick where it named one, else the best textual fit). */
export function withAssignedAsks(outline: Outline, asks: string[]): Outline {
  return { ...outline, segments: assignAsks(outline.segments, asks) }
}

export function outlinePrompt(
  req: PodcastScriptRequest,
  segmentCount: number,
  targetWords: number,
  showBible: string,
  voice = '',
): string {
  const languageLabel = LANGUAGE_LABEL[req.language]
  const brief = req.episodeBrief
  return `${baseSystemPrompt(req, showBible, voice)}

You are writing the OUTLINE for this episode — break the story inside what the EPISODE BRIEF already decided, like a writers' room before anyone drafts a line. The brief's format, roles, tone, humor, opening, closing and rhythm are settled; you are not re-deciding them.
- Produce exactly ${segmentCount} segments. The FIRST segment opens the episode exactly the way the brief's OPENING says ("${brief.opening}"); the LAST segment ends it exactly the way the brief's CLOSING says ("${brief.closing}"). Nothing beyond that is prescribed — no station intro, no takeaway count, no sign-off unless the brief asked for one.
- The segments' target_words must sum to about ${targetWords} words in total (roughly ${Math.round(targetWords / segmentCount)} per segment) — the whole episode is meant to run about ${brief.minutes} minutes at roughly ${WORDS_PER_MINUTE} spoken words per minute. target_words is a soft budget for the whole segment, not a per-turn quota — how the words are spent inside a segment is the segment writer's call.
- cover_prompt: a concrete, painterly, text-free square podcast-cover brief in English, mentioning the subject and mood.
- genres: 1 to 3 short English genre labels (e.g. "Travel", "Planning").
- through_line: the ONE question this episode is really answering, written as a single sentence for the writers' room, never as a line a host says out loud. Return "" when the material has no single question and the brief did not ask for one.
- motif, hook, reveals and digressions are DRAMATURGY DEVICES. Fill each one ONLY when the brief's DEVICES list calls for it; otherwise return an empty string / an empty array. Do not invent a hook, a running joke, a withheld reveal or a digression because a podcast usually has one — an episode with none of them is a valid episode, and a forced device is the single most common failure of this show.
  - motif: one thing the hosts can return to, lightly, across the episode.
  - hook: the opening beat itself — a concrete scene, a striking number, or the open question itself. It must not summarize the episode or preview its conclusions.
  - reveals: things worth deliberately withholding — a number, a decision, a twist — each tied to the 0-based index of the segment where it should land. Segments before that index may gesture at it without giving it away.
  - digressions: planned side-trips (an anecdote, a concrete example, a "what if") — each tied to the 0-based index of the segment that should host it, plus a one-line return_hook: the line that pulls the conversation back to the main thread afterward.
${brief.asks?.length ? `- LISTENER ASKS — the listener raised these concrete questions/habits; each one gets an explicit verdict in exactly one segment, and the segment that owns it is built around giving that verdict first, before any side story:\n${brief.asks.map((a) => `  • ${a}`).join('\n')}\n  Put each ask, copied verbatim, into the "answers" array of the segment that answers it. A segment may also follow the notes into territory the listener did not ask about (a shopping list is not a question), but never at the cost of an ask. The FIRST segment frames the episode in its first lines: it says plainly what the episode answers (the listener's question, one or two lines, playful is fine) before any detail.\n` : "- The FIRST segment frames the episode in its first lines: it says plainly what the episode answers (the listener's question, one or two lines, playful is fine) before any detail.\n"}- Every key_facts entry must be a fact, number or rule taken verbatim (or near-verbatim) from the source — these are the load-bearing details each segment MUST speak aloud.

Return STRICT JSON only, no markdown, no commentary:
{"title":"<episode title>","description":"<2-4 sentence show-notes description in ${languageLabel}>","cover_prompt":"<English image brief>","genres":["..."],"motif":"<motif, or \\"\\" when the brief did not ask for one>","through_line":"<the one question the episode answers, or \\"\\">","hook":"<the opening beat, or \\"\\" when the brief did not ask for one>","reveals":[{"text":"<what gets revealed>","segment":<0-based segment index>}],"digressions":[{"beat":"<the side-trip>","segment":<0-based segment index>,"return_hook":"<the line that returns to the thread>"}],"segments":[{"title":"<segment title>","goal":"<what this segment accomplishes>","key_facts":["<verbatim fact from the source>"],"target_words":<number>,"tension":"<what pulls the listener through this segment: the open question, the curiosity, or the reveal it is heading for — a conflict only if the material is genuinely contested>","answers":["<listener ask this segment answers, verbatim, or none>"]}]}`
}

export function segmentPrompt(params: {
  req: PodcastScriptRequest
  outline: Outline
  segment: OutlineSegmentSpec
  index: number
  total: number
  previous?: OutlineSegmentSpec
  showBible: string
  voice?: string
}): string {
  const { req, outline, segment, index, total, previous, showBible, voice = '' } = params
  const brief = req.episodeBrief
  const [hostA, hostB] = req.hosts
  const bridgeInstruction =
    index === 0
      ? `This is the FIRST segment — it opens the episode, and the brief's OPENING is binding: ${brief.opening}. Do not add a cold open, a station intro or a hook the brief did not ask for. Within the first ${OPENING_FRAME_TURNS} turns the hosts say plainly what this episode answers — the listener's question, in one or two lines (playful is fine) — so nobody starts on a detail without a frame.`
      : `The previous segment ended aiming at: "${previous?.goal ?? ''}". Open with a natural bridge from that into this segment — never re-introduce the show.`
  const wrapInstruction =
    index === total - 1
      ? `This is the LAST segment — it closes the episode, and the brief's CLOSING is binding: ${brief.closing}. Do not add takeaways, an outlook or a sign-off the brief did not ask for.`
      : 'End this segment with a hand-off / teaser into the next topic — never a final sign-off.'
  const devicesInstruction =
    outline.reveals.length > 0 || outline.digressions.length > 0
      ? 'If the user message assigns this segment a digression, take it fully — let it breathe — then use its return hook to pull the conversation back. If it assigns reveals, build toward them without giving them away yet. If it lists things reserved for a later segment, do not mention them at all, not even obliquely.\n'
      : ''

  return `${baseSystemPrompt(req, showBible, voice)}

You are writing ONE SEGMENT (${index + 1} of ${total}) of the episode "${outline.title}".
Write ONLY this segment: "${segment.title}". Target about ${segment.targetWords} words — a soft budget for the whole segment, not a per-turn quota.
Segment goal: ${segment.goal}
What pulls the listener through this segment: ${segment.tension}
Roles here — ${hostA.name} (A): ${brief.roles.A}; ${hostB.name} (B): ${brief.roles.B}. Tone: ${brief.tone}. Humor: ${HUMOR_INSTRUCTION[brief.humor]} Rhythm: ${brief.rhythm}${brief.glossaryPolicy.trim() ? `\nUnfamiliar names and terms: ${brief.glossaryPolicy}` : ''}
Key facts this segment MUST speak, verbatim where possible:
${segment.keyFacts.map((f) => `- ${f}`).join('\n')}
${segment.answers?.length ? `\nThe listener ASKED these — this segment owes each one an explicit verdict (yes / no / it depends on X, and what to do), spoken early, in plain words, before any side story:\n${segment.answers.map((a) => `- ${a}`).join('\n')}\n` : ''}${outline.motif ? `\nRunning motif of the episode (return to it once, lightly, if it fits): ${outline.motif}\n` : ''}
${outline.throughLine ? `\nThe episode's through-line (the one question it's really answering — circle it, don't state it outright): ${outline.throughLine}\n` : ''}
${devicesInstruction}${bridgeInstruction}
${wrapInstruction}

Return STRICT JSON only, no markdown, no commentary:
{"turns":[{"speaker":"A"|"B","text":"<what this host says>","delivery":"<optional: one of ${DELIVERY_KEYS.join(' | ')} — omit the field on a baseline turn>"}]}`
}

/**
 * The research stage's findings, rendered as prompt sections. Every section is
 * omitted when empty — an empty "GLOSSARY:" heading reads to a writer model as
 * an instruction to fill it.
 */
function dossierSections(dossier: Dossier): string[] {
  const parts: string[] = []
  if (dossier.additions.length > 0) {
    parts.push(
      `ADDITIONS (extra material the writers may use; each item names where it came from):\n${dossier.additions
        .map((a) => `[${a.source}]\n${a.text}`)
        .join('\n\n')}`,
    )
  }
  if (dossier.glossary.length > 0) {
    parts.push(
      `GLOSSARY (names/terms the listener may not know, with the plain-words handle to introduce them by and reuse):\n${dossier.glossary
        .map((g) => `${g.term} — ${g.plain}`)
        .join('\n')}`,
    )
  }
  if (dossier.priorCoverage.length > 0) {
    parts.push(
      `PRIOR COVERAGE (do not repeat — earlier episodes already covered this):\n${dossier.priorCoverage
        .map((p) => `- ${p.title}: ${p.covered}`)
        .join('\n')}`,
    )
  }
  if (dossier.openQuestions.length > 0) {
    parts.push(
      `OPEN QUESTIONS (reserved for the close — pick exactly one for the outro question, never mentioned earlier):\n${dossier.openQuestions.map((q) => `- ${q}`).join('\n')}`,
    )
  }
  return parts
}

export function buildOutlineUserContent(req: PodcastScriptRequest): string {
  const parts = [
    `SOURCE (verbatim; every fact must come from here):\n${req.source}`,
    ...dossierSections(req.dossier),
    req.brief ? `BRIEF (who the listener is / what they want from this episode):\n${req.brief}` : undefined,
    req.title ? `TITLE HINT: ${req.title}` : undefined,
  ].filter((p): p is string => Boolean(p))
  return parts.join('\n\n')
}

export function buildSegmentUserContent(params: {
  req: PodcastScriptRequest
  outline: Outline
  index: number
}): string {
  const { req, outline, index } = params
  const segment = outline.segments[index]
  if (!segment) throw new Error(`segment index ${index} out of range`)
  const previous = outline.segments[index - 1]

  const ownReveals = outline.reveals.filter((r) => r.segmentIndex === index)
  const laterReveals = outline.reveals.filter((r) => r.segmentIndex > index)
  const ownDigressions = outline.digressions.filter((d) => d.segmentIndex === index)

  const parts = [
    `SOURCE (verbatim; every fact must come from here):\n${req.source}`,
    ...dossierSections(req.dossier),
    req.brief ? `BRIEF: ${req.brief}` : undefined,
    `FULL EPISODE OUTLINE (for continuity — you are writing only segment ${index + 1} of ${outline.segments.length}):\n${outline.segments
      .map((s, i) => `${i + 1}. ${s.title} — ${s.goal}`)
      .join('\n')}`,
    previous
      ? `PREVIOUS SEGMENT (for the bridge — do not repeat it): "${previous.title}" — ended aiming at: ${previous.goal}`
      : undefined,
    index === 0 && outline.hook
      ? `HOOK (open this segment with this beat, concrete, no summary of what's coming): ${outline.hook}`
      : undefined,
    ownReveals.length > 0
      ? `REVEALS TO LAND IN THIS SEGMENT:\n${ownReveals.map((r) => `- ${r.text}`).join('\n')}`
      : undefined,
    laterReveals.length > 0
      ? `DO NOT REVEAL YET (planned for a later segment — do not mention, even obliquely):\n${laterReveals
          .map((r) => `- ${r.text} (lands in segment ${r.segmentIndex + 1})`)
          .join('\n')}`
      : undefined,
    ownDigressions.length > 0
      ? `DIGRESSION FOR THIS SEGMENT:\n${ownDigressions.map((d) => `- ${d.beat} — then return with: ${d.returnHook}`).join('\n')}`
      : undefined,
    `THIS SEGMENT'S SPEC:\nTitle: ${segment.title}\nGoal: ${segment.goal}\nPull: ${segment.tension}\nTarget words: ${segment.targetWords}\nKey facts to speak:\n${segment.keyFacts
      .map((f) => `- ${f}`)
      .join('\n')}`,
  ].filter((p): p is string => Boolean(p))
  return parts.join('\n\n')
}

// ---------------------------------------------------------------------------
// Review prompts (multi-angle, whole-draft)
// ---------------------------------------------------------------------------

export const REVIEWER_ROLES = ['dramaturge', 'conversation-coach', 'fact-editor'] as const
export type ReviewerRole = (typeof REVIEWER_ROLES)[number]

const REVIEWER_INSTRUCTIONS: Record<ReviewerRole, (req: PodcastScriptRequest) => string> = {
  dramaturge: (req) =>
    `You are the DRAMATURGE reviewing a finished two-host podcast draft AGAINST ITS EPISODE BRIEF — not against a fixed curve, and not against what podcasts usually do. This show has no house shape; the brief below is the only shape this episode owes anyone. Check: does the episode do what the brief decided (format, opening, closing, the roles each host was given); is the rhythm the one the brief asked for; does it avoid what the brief said to avoid; are the brief's devices — if it listed any — actually earning their place; and, just as important, has the draft added devices NOBODY asked for (an unearned cold open, a forced running joke, a bolted-on set of takeaways, a disagreement staged for its own sake) that should simply go. Check specifically for a MANUFACTURED ARGUMENT: an objection that is conceded one turn later, a host who takes a side only so the other has someone to answer, "ja, aber" hedges, positions that are not in the SOURCE. Unless the brief names a genuinely contested question, the episode should read as one host sharing what they know while the other asks sharp questions — flag every staged disagreement and say what the exchange should be instead (a question, a missing fact, a consequence). LISTENER ASKS: the brief lists the listener's concrete questions; every one needs an explicit, spoken verdict in the segment that owns it — yes / no / depends, and what to do. A segment that talks around an ask, or swaps it for adjacent material (a side ingredient, a related story), has FAILED it: flag that as the first note, with the ask quoted. Also check the episode's first lines say what the episode answers; an opening that starts on a detail with no frame is a note. If the brief asked for reveals or digressions, check they land in the segment they were assigned to and that a digression returns to the point.

THE BRIEF THIS EPISODE OWES:
${renderEpisodeBrief(req)}`,
  'conversation-coach': () =>
    `You are the CONVERSATION COACH reviewing a finished two-host podcast draft for how it sounds, not what it says. Check: does this sound like two people actually talking — real floor time for whoever is explaining, reactions with substance rather than a one-word acknowledgement, natural interruptions, no mechanical strict alternation, no "wie gesagt" / "as we said" filler; no ECHOED reactions (a turn that opens by repeating the last words of the previous turn instead of adding a question, a consequence or a number); a sharp question from the listening host every few turns while the other explains; do the two hosts sound distinct from each other; do any moments of humour actually land and fit the moment. Also flag written-language constructs and AI-isms: essay sentences, hedges like "es ist erwähnenswert" or "worth stating plainly", tidy triads, over-explained emotion, a character explaining what they feel instead of just feeling it, filler, and repeated setups.`,
  'fact-editor': (req) =>
    `You are the FACT & SPEECH EDITOR reviewing a finished two-host podcast draft. Check: every fact, number, place, price or date is traceable to the SOURCE — flag anything invented or contradicted; nothing important from any segment's key_facts is missing from the draft; numbers, dates and units are spelled out as spoken ${LANGUAGE_LABEL[req.language]}, never digits or symbols; every sentence is speakable in one breath; inline tags are only from the allowed list (${PODCAST_TAGS.join(' ')}), angle brackets, never square brackets, and judged by MISUSE, not presence: flag a tag in the wrong place (mid-clause, on a short line), a staged laugh where nothing is funny, a <sigh> or <laugh> repeated like a tic, two tags side by side, an invented or translated tag. A segment with several well-placed pauses and reactions is correct; a segment with none is flat — say so. Per-turn "delivery" values (${DELIVERY_KEYS.join(', ')}) must fit what the turn says and mark a real change of moment — flag one that contradicts the words, one used out of habit, or a missing one where a host clearly turns serious, amused or surprised;  no markdown, no emoji, nothing that isn't spoken text.
Additionally, flag FIGURE CLUSTERS and UNINTRODUCED NAMES, which is where this show fails hardest for a listener: more than one figure in a single sentence; a precise figure the listener has nothing to compare it to (unrounded and unanchored); a run of figures read out instead of walked through one at a time with pauses and a reaction; and any proper name, place, person, company, project, tool, internal term or abbreviation used before a host said what it IS in plain words. Judge as a STRANGER to these notes would: the SOURCE assuming a reader knows "Cortex" or "engrams" does not mean the listener does. For each such name, give the segment/turn of its first mention and the one clause that should introduce it. The lint block (when present) lists mechanically detected candidates — confirm or dismiss them, and add the names it cannot see.`,
}

export function reviewPrompt(params: {
  req: PodcastScriptRequest
  outline: Outline
  role: ReviewerRole
  showBible: string
}): string {
  const { req, outline, role, showBible } = params
  const languageLabel = LANGUAGE_LABEL[req.language]
  return `You are a reviewer from a different model family than the writer; your notes are advisory. You never rewrite lines — you point, you do not draft. Prefer few, specific, high-value notes over many.

${REVIEWER_INSTRUCTIONS[role](req)}

You are reviewing one finished episode draft of "${outline.title}", written in ${languageLabel}. You get the SOURCE, the full outline (with its dramaturgy), and the full draft script rendered as one line per turn: "[seg i][turn j] Name: text" (both indices 0-based).

Give at most 12 notes. Every note must be specific and actionable — name the segment/turn it is about and say exactly what to change, not just what is wrong. If something is fine, do not write a note about it.${showBibleSection(showBible)}

Return STRICT JSON only, no markdown, no commentary:
{"notes":[{"segment":<0-based segment index>,"turn":<0-based turn index within that segment, or null for a segment-wide or episode-wide note>,"note":"<specific, actionable note>"}],"verdict":"<one line: is this draft ready to publish, and why>"}`
}

export function renderDraftForReview(segments: ScriptSegment[], hosts: [PodcastHost, PodcastHost]): string {
  const nameFor = (speaker: 'A' | 'B'): string => hosts.find((h) => h.id === speaker)?.name ?? speaker
  return segments
    .flatMap((seg, i) =>
      seg.turns.map(
        (t, j) =>
          `[seg ${i}][turn ${j}]${t.delivery ? ` [delivery: ${t.delivery}]` : ''} ${nameFor(t.speaker)}: ${t.text}`,
      ),
    )
    .join('\n')
}

export function buildReviewUserContent(params: {
  req: PodcastScriptRequest
  outline: Outline
  segments: ScriptSegment[]
  lintReport?: string
}): string {
  const { req, outline, segments, lintReport } = params
  const dramaturgy = [
    outline.motif ? `Motif: ${outline.motif}` : undefined,
    outline.throughLine ? `Through-line: ${outline.throughLine}` : undefined,
    outline.hook ? `Hook: ${outline.hook}` : undefined,
    outline.reveals.length > 0
      ? `Planned reveals:\n${outline.reveals.map((r) => `- ${r.text} (segment ${r.segmentIndex + 1})`).join('\n')}`
      : undefined,
    outline.digressions.length > 0
      ? `Planned digressions:\n${outline.digressions.map((d) => `- ${d.beat} (segment ${d.segmentIndex + 1}) — returns with: ${d.returnHook}`).join('\n')}`
      : undefined,
  ]
    .filter((p): p is string => Boolean(p))
    .join('\n')

  const parts = [
    `SOURCE (verbatim; every fact must come from here):\n${req.source}`,
    ...dossierSections(req.dossier),
    `EPISODE OUTLINE:\nTitle: ${outline.title}\n${dramaturgy}${dramaturgy ? '\n' : ''}Segments:\n${outline.segments
      .map((s, i) => `${i + 1}. ${s.title} — ${s.goal} (pull: ${s.tension})`)
      .join('\n')}`,
    `FULL DRAFT SCRIPT:\n${renderDraftForReview(segments, req.hosts)}`,
    lintReport
      ? `DETERMINISTIC LINT (measured by code, per segment index; advisory facts, not verdicts):\n${lintReport}`
      : undefined,
  ].filter((p): p is string => Boolean(p))
  return parts.join('\n\n')
}

// ---------------------------------------------------------------------------
// Revision prompts (per segment, targeted)
// ---------------------------------------------------------------------------

export function revisionPrompt(params: {
  req: PodcastScriptRequest
  outline: Outline
  segment: OutlineSegmentSpec
  index: number
  total: number
  showBible: string
  voice?: string
}): string {
  const { req, outline, segment, index, total, showBible, voice = '' } = params
  return `${baseSystemPrompt(req, showBible, voice)}

You are REVISING ONE SEGMENT (${index + 1} of ${total}) of the episode "${outline.title}" — "${segment.title}" — based on editorial notes from a review pass. The segment's target is ${segment.targetWords} words; a revision never grows the segment, and if a note asks for a cut, the cut is the priority. You get the segment's CURRENT turns, the notes that apply to it, and a few turns from the neighbouring segments for the seams.
Apply every note that is valid. Where a note is wrong (it contradicts the source, or the segment's own goal/pull), use your judgement and keep what already works — you are not obligated to change something just because a note mentions it. Do not shorten the segment just to hit a word target; keep its texture. Keep each turn's inline tags and "delivery" exactly as they are unless a note is about them — a delivery marks a real change of moment, so it stays on the turn it belongs to.
Segment goal: ${segment.goal}
What pulls the listener through this segment: ${segment.tension}
Key facts this segment MUST speak, verbatim where possible:
${segment.keyFacts.map((f) => `- ${f}`).join('\n')}

Return the FULL revised segment as STRICT JSON only, no markdown, no commentary:
{"turns":[{"speaker":"A"|"B","text":"<what this host says>","delivery":"<optional: one of ${DELIVERY_KEYS.join(' | ')} — omit the field on a baseline turn>"}]}`
}

export function buildRevisionUserContent(params: {
  req: PodcastScriptRequest
  outline: Outline
  segments: ScriptSegment[]
  index: number
  notes: ReviewNote[]
}): string {
  const { req, outline, segments, index, notes } = params
  const segment = outline.segments[index]
  if (!segment) throw new Error(`segment index ${index} out of range`)
  const current = segments[index]
  if (!current) throw new Error(`draft segment ${index} out of range`)
  const previousDraft = segments[index - 1]
  const nextDraft = segments[index + 1]

  const renderTurns = (turns: ScriptTurn[]): string =>
    turns
      .map(
        (t, j) =>
          `[turn ${j}]${t.delivery ? ` [delivery: ${t.delivery}]` : ''} ${req.hosts.find((h) => h.id === t.speaker)?.name ?? t.speaker}: ${t.text}`,
      )
      .join('\n')

  const parts = [
    `SOURCE (verbatim; every fact must come from here):\n${req.source}`,
    ...dossierSections(req.dossier),
    `CURRENT TURNS FOR THIS SEGMENT:\n${renderTurns(current.turns)}`,
    `EDITORIAL NOTES FOR THIS SEGMENT:\n${notes.map((n) => `- [${n.reviewer}] ${n.note}`).join('\n')}`,
    previousDraft
      ? `END OF PREVIOUS SEGMENT (for the seam — do not repeat it):\n${renderTurns(previousDraft.turns.slice(-3))}`
      : undefined,
    nextDraft
      ? `START OF NEXT SEGMENT (for the seam — hand off toward it):\n${renderTurns(nextDraft.turns.slice(0, 2))}`
      : undefined,
  ].filter((p): p is string => Boolean(p))
  return parts.join('\n\n')
}

/** The notes a segment's revision call should see: its own notes, plus episode-wide notes (`segmentIndex: null`) — but ONLY if it has at least one note of its own, so an untouched segment is never rewritten just because of an episode-level remark. */
/** Every version so far overshot its length (22 min asked, 27–36 min delivered); the writer models pad. This is the tolerance before the governor cuts. */
const LENGTH_TOLERANCE = 0.2

/**
 * Scale the outline's per-segment targets so they sum to the episode's
 * budget. The story pass is asked for that, but the model's arithmetic drifts
 * and the drift compounds through six segment writers. Exported for tests.
 */
export function normalizeOutlineTargets(outline: Outline, totalTargetWords: number): Outline {
  const sum = outline.segments.reduce((n, seg) => n + seg.targetWords, 0)
  if (sum <= 0) return outline
  const factor = totalTargetWords / sum
  return {
    ...outline,
    segments: outline.segments.map((seg) => ({
      ...seg,
      targetWords: Math.max(80, Math.round(seg.targetWords * factor)),
    })),
  }
}

const segmentWords = (seg: ScriptSegment): number => seg.turns.reduce((n, t) => n + countWords(t.text), 0)

/**
 * Length governor: one editorial note per segment that runs more than
 * LENGTH_TOLERANCE over its target, phrased as a cut with what to keep.
 * Goes through the normal revision pass, so it costs nothing extra when the
 * segment is already being revised. Exported for tests.
 */
export function lengthNotes(segments: ScriptSegment[], outline: Outline): ReviewNote[] {
  const notes: ReviewNote[] = []
  segments.forEach((seg, index) => {
    const target = outline.segments[index]?.targetWords
    if (!target) return
    const words = segmentWords(seg)
    if (words <= target * (1 + LENGTH_TOLERANCE)) return
    notes.push({
      segmentIndex: index,
      turnIndex: null,
      reviewer: 'length-governor',
      note: `This segment runs ${words} words against a target of ${target}. Cut it to about ${target} words: remove restatements, second examples and warm-up lines; keep every key fact, the strongest exchange and the bridge. Do not add anything.`,
    })
  })
  return notes
}

export function segmentNotesFor(notes: ReviewNote[], index: number): ReviewNote[] {
  const own = notes.filter((n) => n.segmentIndex === index)
  if (own.length === 0) return []
  return [...own, ...notes.filter((n) => n.segmentIndex === null)]
}

// ---------------------------------------------------------------------------
// Metadata pass (final title/description/cover prompt/genres/chapter titles)
// ---------------------------------------------------------------------------

/** A chapter title from the metadata pass, replacing the outline's working segment title. */
export interface EpisodeChapter {
  segmentIndex: number
  title: string
}

export interface EpisodeMetadata {
  title: string
  description: string
  coverPrompt: string
  genres: string[]
  chapters: EpisodeChapter[]
  /** 3–6 short archive labels — what the episode is actually about, for the episode profile. */
  topics: string[]
}

function metadataPrompt(req: PodcastScriptRequest): string {
  const languageLabel = LANGUAGE_LABEL[req.language]
  return `You are the final METADATA EDITOR for "${req.series}", writing publish-ready metadata for one finished, locked two-host podcast episode. You get the finished script, the story outline's draft title/description/cover prompt, and the listener brief. Your job is to sharpen the drafts into what actually ships — reflecting what the FINISHED episode delivers, not what was planned — and to write one chapter title per segment for the episode's audio chapter markers.
- title: punchy, accurate to the finished episode, in ${languageLabel}.
- description: 2 to 4 sentences, show-notes style, in ${languageLabel}, written for someone deciding whether to press play.
- cover_prompt: a concrete, painterly, text-free square podcast-cover brief in English, for a German travel/knowledge show — the concrete subject and the mood.
- genres: 1 to 3 short English genre labels.
- chapters: exactly one entry per segment, in order, each a short chapter title (max 6 words) in ${languageLabel} that reflects what actually happens in that segment.
- topics: 3 to 6 short labels (one to three words each) naming what this episode is actually about. These go into the archive, so a later episode can see what has already been covered — not marketing copy.
You never rewrite the script — you only produce metadata about it.

Return STRICT JSON only, no markdown, no commentary:
{"title":"<episode title>","description":"<2-4 sentence show-notes description in ${languageLabel}>","cover_prompt":"<English image brief>","genres":["..."],"topics":["<short label>"],"chapters":[{"segment":<0-based segment index>,"title":"<chapter title, max 6 words>"}]}`
}

function buildMetadataUserContent(params: {
  req: PodcastScriptRequest
  outline: Outline
  segments: ScriptSegment[]
}): string {
  const { req, outline, segments } = params
  const parts = [
    req.brief ? `BRIEF (who the listener is / what they want from this episode): ${req.brief}` : undefined,
    `OUTLINE DRAFTS (for reference only — the finished episode may have moved beyond these):\nTitle: ${outline.title}\nDescription: ${outline.description}\nCover prompt: ${outline.coverPrompt}`,
    `FINISHED SCRIPT (final, as spoken):\n${renderDraftForReview(segments, req.hosts)}`,
  ].filter((p): p is string => Boolean(p))
  return parts.join('\n\n')
}

/**
 * Parse the metadata LLM's reply. Same fence/prose tolerance as
 * {@link parseOutline}; a chapter missing its title or segment index is
 * dropped, `segment` is clamped onto a real segment.
 */
export function parseEpisodeMetadata(raw: string, segmentCount: number): EpisodeMetadata {
  const parsed = JSON.parse(extractJsonObject(raw)) as {
    title?: unknown
    description?: unknown
    cover_prompt?: unknown
    genres?: unknown
    topics?: unknown
    chapters?: unknown
  }
  const chaptersRaw = Array.isArray(parsed.chapters) ? parsed.chapters : []
  const chapters: EpisodeChapter[] = []
  for (const item of chaptersRaw) {
    const obj = (item ?? {}) as Record<string, unknown>
    const title = typeof obj['title'] === 'string' ? obj['title'].trim() : ''
    if (!title || typeof obj['segment'] !== 'number') continue
    chapters.push({ segmentIndex: clampSegmentIndex(obj['segment'], segmentCount), title })
  }
  return {
    title: typeof parsed.title === 'string' ? parsed.title.trim() : '',
    description: typeof parsed.description === 'string' ? parsed.description.trim() : '',
    coverPrompt: typeof parsed.cover_prompt === 'string' ? parsed.cover_prompt.trim() : '',
    genres: Array.isArray(parsed.genres) ? parsed.genres.filter((g): g is string => typeof g === 'string') : [],
    topics: Array.isArray(parsed.topics)
      ? parsed.topics.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).map((t) => t.trim())
      : [],
    chapters,
  }
}

/**
 * Write the episode's final title/description/cover prompt/genres/chapter
 * titles from the LOCKED script. Metadata is polish, not the episode: on
 * failure (after the usual retry) the caller falls back to the outline's
 * drafts and logs a warning rather than failing the job.
 */
export async function writeEpisodeMetadata(
  llm: Llm,
  params: { req: PodcastScriptRequest; outline: Outline; segments: ScriptSegment[] },
): Promise<EpisodeMetadata> {
  const { req, outline, segments } = params
  return callAndParse(
    'metadata',
    (attempt) =>
      llm.call({
        route: 'podcast.metadata',
        systemPrompt: metadataPrompt(req),
        userContent: buildMetadataUserContent({ req, outline, segments }),
        maxCompletionTokens: writerBudget(4000, attempt),
        stage: 'metadata',
        retryOnTruncation: true,
      }),
    (raw) => parseEpisodeMetadata(raw, segments.length),
  )
}

/**
 * What the ledger remembers about this episode — the editor of the NEXT
 * episode reads it, which is the whole point of persisting it. `lead` is
 * computed from the word share per speaker rather than asked for: within
 * {@link LEAD_BALANCED_POINTS} percentage points of each other counts as
 * "balanced". `durationSeconds` is filled after mastering, not here.
 */
const LEAD_BALANCED_POINTS = 10

/** An episode this far under the length the caller asked for is flagged in the profile and the log. */
const SHORT_SHARE = 0.8

export function buildEpisodeProfile(params: {
  brief: EpisodeBrief
  script: PodcastScript
  dossier: Dossier
  hosts?: PodcastHost[]
  requestedMinutes?: number
}): EpisodeProfile {
  const { brief, script, dossier, hosts = [], requestedMinutes } = params
  const words = { A: 0, B: 0 }
  for (const segment of script.segments) {
    for (const turn of segment.turns) words[turn.speaker] += countWords(turn.text)
  }
  const total = words.A + words.B
  const shareDiffPoints = total > 0 ? (Math.abs(words.A - words.B) / total) * 100 : 0
  const lead: EpisodeProfile['lead'] =
    shareDiffPoints <= LEAD_BALANCED_POINTS ? 'balanced' : words.A > words.B ? 'A' : 'B'

  return {
    format: brief.format,
    lead,
    humor: brief.humor,
    opening: brief.opening,
    minutes: brief.minutes,
    durationSeconds: null,
    topics: script.topics,
    segmentCount: script.segments.length,
    toolCalls: dossier.toolCalls.length,
    researchCalls: dossier.toolCalls.filter((c) => c.tool === 'research').length,
    expression: expressionSummary(lintSegments(script.segments, { hostNames: hosts.map((h) => h.name) })),
    ...lengthProfile({ requestedMinutes, words: total }),
    ...asksProfile({ brief, script, hostNames: hosts.map((h) => h.name) }),
  }
}

function lengthProfile(params: { requestedMinutes?: number; words: number }): Partial<EpisodeProfile> {
  const { requestedMinutes, words } = params
  if (!requestedMinutes) return { words }
  const ratio = Math.round((words / (requestedMinutes * WORDS_PER_MINUTE)) * 100) / 100
  const lengthShort = ratio < SHORT_SHARE
  if (lengthShort) log.warn('podcast episode is under 80% of the requested length', { requestedMinutes, words, ratio })
  return { requestedMinutes, words, lengthVsRequested: ratio, lengthShort }
}

function asksProfile(params: {
  brief: EpisodeBrief
  script: PodcastScript
  hostNames: string[]
}): Partial<EpisodeProfile> {
  const { brief, script, hostNames } = params
  const asks = brief.asks ?? []
  if (asks.length === 0) return {}
  // A script without assignments (older, or the outline writer dropped them) was never checked — say so instead of reporting a clean pass.
  if (!script.asks) return { asks: { total: asks.length, uncovered: null, openingFramed: null } }
  const findings = lintSegments(script.segments, {
    hostNames,
    asks: script.asks,
    openingFrame: script.openingFrame ?? asks,
  }).findings
  return {
    asks: {
      total: asks.length,
      uncovered: findings.filter((f) => f.rule === 'ask-uncovered').length,
      openingFramed: !findings.some((f) => f.rule === 'opening-unframed'),
    },
  }
}

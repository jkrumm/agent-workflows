import { type AgentRun, createSegmentAgent } from './agent.ts'
import { callAndParse, type Llm, writerBudget } from './llm.ts'
import { log } from './log.ts'
import type { BrainPort } from './ports.ts'
import { resolvePodcastRoute } from './routes.ts'
import {
  baseSystemPrompt,
  buildOutlineUserContent,
  buildRevisionUserContent,
  buildReviewUserContent,
  buildSegmentUserContent,
  normalizeOutlineTargets,
  type Outline,
  outlinePrompt,
  type PodcastScriptRequest,
  parseOutline,
  parseReviewNotes,
  parseSegmentTurns,
  pruneUnrequestedDevices,
  type ReviewerRole,
  type ReviewNote,
  reviewPrompt,
  revisionPrompt,
  SEGMENT_TURNS_SCHEMA,
  type ScriptSegment,
  type ScriptTurn,
  sanitizeTurns,
  segmentPrompt,
  segmentNotesFor,
  withAssignedAsks,
} from './script.ts'

// The writers' room stages as the workflow's steps call them, one unit of work each (legacy `writePodcastScript`,
// `reviewEpisode`, `reviseSegments`, split so every segment, review and revision is its own journaled step).

/** The house texts every writing prompt carries, journaled once per run (`house` step). */
export interface House {
  showBible: string
  voice: string
}

/** What one segment step journals: the turns and, when the agentic writer ran, its loop's record. */
export interface WrittenSegment {
  turns: ScriptTurn[]
  agent: AgentRun | null
}

/** The outline: one call, devices the brief did not ask for pruned, word targets normalised, asks assigned. */
export function planOutline(
  llm: Llm,
  params: { req: PodcastScriptRequest; house: House; segmentCount: number; targetWords: number; maxSegments: number },
): Promise<Outline> {
  const { req, house, segmentCount, targetWords, maxSegments } = params
  return callAndParse(
    'outline',
    (attempt) =>
      llm.call({
        route: 'podcast.outline',
        systemPrompt: outlinePrompt(req, segmentCount, targetWords, house.showBible, house.voice),
        userContent: buildOutlineUserContent(req),
        // The outline of a long episode is thousands of tokens of verbatim key facts, and reasoning counts against
        // the same budget: sized for the worst case.
        maxCompletionTokens: writerBudget(8000, attempt),
        stage: 'outline',
        retryOnTruncation: true,
      }),
    (raw) =>
      withAssignedAsks(
        normalizeOutlineTargets(
          pruneUnrequestedDevices(capSegments(parseOutline(raw), maxSegments), req.episodeBrief),
          targetWords,
        ),
        req.episodeBrief.asks ?? [],
      ),
  )
}

/**
 * One journaled step exists per segment up to `max`; the brief never asks for more. The cut comes before devices are
 * pruned, targets normalised and asks assigned, so the kept segments carry the whole length and every ask.
 */
function capSegments(outline: Outline, max: number): Outline {
  if (outline.segments.length <= max) return outline
  log.warn('podcast outline returned more segments than the room writes; keeping the first ones', {
    segments: outline.segments.length,
    kept: max,
  })
  // Reveals and digressions on a cut segment land on the last kept one, as the parser clamps an index past the end.
  const clamp = (i: number) => Math.min(i, max - 1)
  return {
    ...outline,
    segments: outline.segments.slice(0, max),
    reveals: outline.reveals.map((r) => ({ ...r, segmentIndex: clamp(r.segmentIndex) })),
    digressions: outline.digressions.map((d) => ({ ...d, segmentIndex: clamp(d.segmentIndex) })),
  }
}

export interface WriterOptions {
  /** The agentic writer (a tool loop that measures its own text); off: the single-shot call only. */
  agentic: boolean
  brain?: BrainPort
  /** Multi-speaker request ceiling the writer measures its synth units against. */
  maxUnitChars: number
}

/**
 * One segment by the voice owner: the agentic loop first, the single-shot call when the loop fails (or the agentic
 * writer is off). The single-shot call on the Anthropic wire caches the episode-constant system prefix and forces the
 * segment schema.
 */
export async function writeSegment(
  llm: Llm,
  params: { req: PodcastScriptRequest; outline: Outline; index: number; house: House; writer: WriterOptions },
): Promise<WrittenSegment> {
  const { req, outline, index, house, writer } = params
  const spec = outline.segments[index]
  if (!spec) throw new Error(`outline segment ${index} out of range`)
  const total = outline.segments.length
  const singleShot = (): Promise<ScriptTurn[]> =>
    callAndParse(
      `segment ${index + 1}`,
      (attempt) =>
        llm.call({
          route: 'podcast.write',
          systemPrompt: segmentPrompt({
            req,
            outline,
            segment: spec,
            index,
            total,
            previous: outline.segments[index - 1],
            showBible: house.showBible,
            voice: house.voice,
          }),
          userContent: buildSegmentUserContent({ req, outline, index }),
          // Generous headroom: a tighter budget cut a segment mid-array on legacy.
          maxCompletionTokens: writerBudget(spec.targetWords * 6, attempt),
          stage: 'segment',
          cacheableSystemPrefix: baseSystemPrompt(req, house.showBible, house.voice),
          jsonSchema: SEGMENT_TURNS_SCHEMA,
        }),
      (raw) => sanitizeTurns(parseSegmentTurns(raw)),
    )
  if (!writer.agentic) return { turns: await singleShot(), agent: null }
  let run: AgentRun | null = null
  const agent = createSegmentAgent(llm, {
    ...(writer.brain ? { brain: writer.brain } : {}),
    maxUnitChars: writer.maxUnitChars,
    onRun: (r) => {
      run = r
    },
  })
  try {
    const turns = await agent.draft({ req, outline, index, total, showBible: house.showBible, voice: house.voice })
    return { turns, agent: run }
  } catch (err) {
    if (llm.aborted) throw err
    log.warn('segment agent draft failed, falling back to the single-shot draft', {
      index,
      error: err instanceof Error ? err.message : String(err),
    })
    return { turns: await singleShot(), agent: run }
  }
}

/** The reviewer roster: each role on each of these routes. A route's position is part of the review step's id. */
export const REVIEW_ROUTES = ['podcast.review.a', 'podcast.review.b'] as const
export type ReviewRoute = (typeof REVIEW_ROUTES)[number]

/**
 * One reviewer (`<role>@<model>`): advisory notes on the whole draft. A reviewer that fails twice is skipped (`null`):
 * a review is polish, not the episode.
 */
export async function reviewDraft(
  llm: Llm,
  params: {
    req: PodcastScriptRequest
    outline: Outline
    segments: ScriptSegment[]
    role: ReviewerRole
    route: ReviewRoute
    house: House
    lintReport: string
  },
): Promise<{ reviewer: string; notes: ReviewNote[]; verdict: string } | null> {
  const { req, outline, segments, role, route, house, lintReport } = params
  const reviewer = `${role}@${resolvePodcastRoute(route).model}`
  try {
    const result = await callAndParse(
      `review ${reviewer}`,
      (attempt) =>
        llm.call({
          route,
          systemPrompt: reviewPrompt({ req, outline, role, showBible: house.showBible }),
          userContent: buildReviewUserContent({ req, outline, segments, lintReport }),
          // Reviewers read source, outline and the whole draft and reason before answering.
          maxCompletionTokens: writerBudget(4000, attempt),
          stage: 'review',
          retryOnTruncation: true,
        }),
      (raw) => parseReviewNotes(raw, reviewer),
    )
    log.info('podcast review verdict', { reviewer, verdict: result.verdict, notes: result.notes.length })
    return { reviewer, ...result }
  } catch (err) {
    if (llm.aborted) throw err
    log.warn('podcast reviewer skipped', { reviewer, error: err instanceof Error ? err.message : String(err) })
    return null
  }
}

/**
 * Rewrite one segment against its notes, by the voice owner (agentic loop, single-shot fallback). `null` when the
 * revision fails twice or comes back empty: the draft stands, polish lost, not an episode.
 */
export async function reviseSegment(
  llm: Llm,
  params: {
    req: PodcastScriptRequest
    outline: Outline
    segments: ScriptSegment[]
    index: number
    notes: ReviewNote[]
    house: House
    writer: WriterOptions
  },
): Promise<WrittenSegment | null> {
  const { req, outline, segments, index, house, writer } = params
  const spec = outline.segments[index]
  if (!spec) throw new Error(`outline segment ${index} out of range`)
  const total = segments.length
  const notes = segmentNotesFor(params.notes, index)
  const singleShot = (): Promise<ScriptTurn[]> =>
    callAndParse(
      `revise ${index + 1}`,
      (attempt) =>
        llm.call({
          route: 'podcast.write',
          systemPrompt: revisionPrompt({
            req,
            outline,
            segment: spec,
            index,
            total,
            showBible: house.showBible,
            voice: house.voice,
          }),
          userContent: buildRevisionUserContent({ req, outline, segments, index, notes }),
          maxCompletionTokens: writerBudget(spec.targetWords * 6, attempt),
          stage: 'revise',
          cacheableSystemPrefix: baseSystemPrompt(req, house.showBible, house.voice),
          jsonSchema: SEGMENT_TURNS_SCHEMA,
        }),
      (raw) => sanitizeTurns(parseSegmentTurns(raw)),
    )
  let run: AgentRun | null = null
  try {
    let turns: ScriptTurn[]
    if (writer.agentic) {
      const agent = createSegmentAgent(llm, {
        ...(writer.brain ? { brain: writer.brain } : {}),
        maxUnitChars: writer.maxUnitChars,
        onRun: (r) => {
          run = r
        },
      })
      turns = await agent
        .revise({ req, outline, segments, index, total, notes, showBible: house.showBible, voice: house.voice })
        .catch((err: unknown) => {
          if (llm.aborted) throw err
          log.warn('segment agent revision failed, falling back to the single-shot revision', {
            index,
            error: err instanceof Error ? err.message : String(err),
          })
          return singleShot()
        })
    } else {
      turns = await singleShot()
    }
    // An empty revision is a failed one: never replace a written segment with nothing.
    return turns.length > 0 ? { turns, agent: run } : null
  } catch (err) {
    if (llm.aborted) throw err
    log.warn('podcast revision skipped, keeping draft segment', {
      index,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

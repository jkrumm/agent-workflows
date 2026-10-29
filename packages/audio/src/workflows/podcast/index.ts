import type { AnyWorkflow, Ctx, Json, Logger, StepScope, Workflow } from '../../../../runtime/src/index.ts'
import { defineWorkflow, WorkflowError } from '../../../../runtime/src/index.ts'
import type { AgentRun } from './agent.ts'
import { type PodcastConfig, podcastConfigFromEnv } from './config.ts'
import { decideEpisodeBrief, defaultEpisodeBrief } from './editorial.ts'
import { iuModelPort } from './iu.ts'
import { lintNotes, lintSegments, renderLintReport } from './lint.ts'
import { Llm, type ModelPort, type Spend } from './llm.ts'
import { log, setPodcastLogger } from './log.ts'
import type { BrainPort, HistoryPort, ResearchPort } from './ports.ts'
import type { ProduceInput, ProduceInputValue } from './produce-input.ts'
import { dropAnsweredOpenQuestions, readBrainNotes, runLoadBearingResearch, runPodcastResearch } from './research.ts'
import {
  type House,
  planOutline,
  REVIEW_ROUTES,
  type ReviewRoute,
  reviewDraft,
  reviseSegment,
  type WriterOptions,
  type WrittenSegment,
  writeSegment,
} from './room.ts'
import {
  type HostValue,
  MAX_SOURCE_CHARS,
  MIN_MINUTES,
  MAX_MINUTES,
  PodcastInput,
  PodcastOutput,
  type PodcastRequest,
  type PodcastResult,
  ProduceResult,
} from './schema.ts'
import {
  buildEpisodeProfile,
  countWords,
  type EpisodeMetadata,
  lengthNotes,
  MAX_SEGMENTS,
  type Outline,
  openingFrameOf,
  outlineAsks,
  type PodcastScript,
  type PodcastScriptRequest,
  type ReviewerRole,
  type ReviewNote,
  type ScriptSegment,
  segmentNotesFor,
  WORDS_PER_MINUTE,
  writeEpisodeMetadata,
} from './script.ts'
import type { Dossier, EpisodeBrief, EpisodeProfile, EpisodeSummary } from './types.ts'
import { EMPTY_DOSSIER } from './types.ts'
import { mapConcurrent } from './vocab.ts'

export const PODCAST_VERSION = '2026-10-29.1'
export { ProduceInput, type ProduceInputValue } from './produce-input.ts'
export { PodcastInput, PodcastOutput } from './schema.ts'

/** What the workflow is built from. Everything but `history` defaults to production on `process.env`. */
export interface PodcastDeps {
  /** The show's memory (`history.ts` on Postgres in production). */
  history: HistoryPort
  /** The model transport. Default: IU (`iu.ts`). */
  models?: ModelPort
  /** The vault (`brain.ts`); absent: no brain tools, and `sourcePaths` are refused. */
  brain?: BrainPort
  /** The host's `research` workflow (`research-client.ts`); absent: no `research` tool and no follow-up. */
  research?: ResearchPort
  /**
   * The internal child that turns the locked script into the published episode. Absent: the run ends after the
   * script with `produce: null` (the writers' room alone; the produce workflow lands separately).
   */
  produce?: Workflow<typeof ProduceInput, AnyWorkflow['output']>
  config?: Partial<PodcastConfig>
  logger?: Logger
}

// ---------------------------------------------------------------------------
// Step-id tables: step ids are literals (concept §3); a fan-out adds its index.
// ---------------------------------------------------------------------------

type Body = (scope: StepScope) => Promise<Json>
type StepAt = (ctx: Ctx, body: Body) => Promise<Json>

const SEGMENT_STEPS: StepAt[] = [
  (ctx, body) => ctx.step('segment:0', body),
  (ctx, body) => ctx.step('segment:1', body),
  (ctx, body) => ctx.step('segment:2', body),
  (ctx, body) => ctx.step('segment:3', body),
  (ctx, body) => ctx.step('segment:4', body),
  (ctx, body) => ctx.step('segment:5', body),
  (ctx, body) => ctx.step('segment:6', body),
  (ctx, body) => ctx.step('segment:7', body),
  (ctx, body) => ctx.step('segment:8', body),
]
const REVISE_STEPS: StepAt[] = [
  (ctx, body) => ctx.step('revise:0', body),
  (ctx, body) => ctx.step('revise:1', body),
  (ctx, body) => ctx.step('revise:2', body),
  (ctx, body) => ctx.step('revise:3', body),
  (ctx, body) => ctx.step('revise:4', body),
  (ctx, body) => ctx.step('revise:5', body),
  (ctx, body) => ctx.step('revise:6', body),
  (ctx, body) => ctx.step('revise:7', body),
  (ctx, body) => ctx.step('revise:8', body),
]
const TIGHTEN_STEPS: StepAt[] = [
  (ctx, body) => ctx.step('tighten:0', body),
  (ctx, body) => ctx.step('tighten:1', body),
  (ctx, body) => ctx.step('tighten:2', body),
  (ctx, body) => ctx.step('tighten:3', body),
  (ctx, body) => ctx.step('tighten:4', body),
  (ctx, body) => ctx.step('tighten:5', body),
  (ctx, body) => ctx.step('tighten:6', body),
  (ctx, body) => ctx.step('tighten:7', body),
  (ctx, body) => ctx.step('tighten:8', body),
]
const REVIEW_STEPS: Record<`${ReviewerRole}:${ReviewRoute}`, StepAt> = {
  'dramaturge:podcast.review.a': (ctx, body) => ctx.step('review:dramaturge:a', body),
  'dramaturge:podcast.review.b': (ctx, body) => ctx.step('review:dramaturge:b', body),
  'conversation-coach:podcast.review.a': (ctx, body) => ctx.step('review:conversation-coach:a', body),
  'conversation-coach:podcast.review.b': (ctx, body) => ctx.step('review:conversation-coach:b', body),
  'fact-editor:podcast.review.a': (ctx, body) => ctx.step('review:fact-editor:a', body),
  'fact-editor:podcast.review.b': (ctx, body) => ctx.step('review:fact-editor:b', body),
}
const REVIEWER_ROLES: ReviewerRole[] = ['dramaturge', 'conversation-coach', 'fact-editor']

/** A step's value as it replays: JSON round-tripped, so `undefined` fields drop exactly as the journal drops them. */
const json = (value: unknown): Json => JSON.parse(JSON.stringify(value)) as Json
const as = async <T>(value: Promise<Json>): Promise<T> => (await value) as unknown as T

/** What a model-calling step journals besides its value: its spend, summed into the run's output. */
type Metered<T> = { value: T; spend: Spend }

/** The step's model calls, metered; the body's value and the spend journal together. */
function metered<T>(models: ModelPort, fn: (llm: Llm, scope: StepScope) => Promise<T>): Body {
  return async (scope) => {
    const llm = new Llm(models, scope)
    const value = await fn(llm, scope)
    return json({ value, spend: llm.spend } satisfies Metered<T>)
  }
}

/** A best-effort stage's failure: its fallback stands, unless the step was aborted (cancel, lease loss, shutdown). */
function fallBack<T>(stage: string, error: unknown, signal: AbortSignal, fallback: T): T {
  if (signal.aborted) throw error
  log.warn(`podcast ${stage} failed, using its fallback`, {
    error: error instanceof Error ? error.message : String(error),
  })
  return fallback
}

const sumSpend = (spends: Spend[]): Spend =>
  spends.reduce((a, b) => ({ usd: a.usd + b.usd, unpriced: a.unpriced + b.unpriced }), { usd: 0, unpriced: 0 })

/** What the `house` step journals: the texts and hosts every later step reads, fixed for the run. */
interface HouseStep extends House {
  hosts: [HostValue, HostValue]
  /** When the episode started: the produce stage's episode date. */
  createdAt: string
}

/** What the `script` step journals: the locked script as legacy persisted it (`script.json`), and its profile. */
interface ScriptStep {
  script: PodcastScript & { hosts: [HostValue, HostValue] }
  profile: EpisodeProfile
}

const SHOW_BIBLE = new URL('./show-bible.md', import.meta.url)

async function readOptional(path: URL | string | null, what: string): Promise<string> {
  if (!path) return ''
  try {
    return await Bun.file(path).text()
  } catch (err) {
    log.warn(`podcast ${what} unreadable, continuing without it`, {
      error: err instanceof Error ? err.message : String(err),
    })
    return ''
  }
}

export function createPodcastWorkflow(deps: PodcastDeps) {
  const config: PodcastConfig = { ...podcastConfigFromEnv(), ...deps.config }
  const models = deps.models ?? iuModelPort()
  if (deps.logger) setPodcastLogger(deps.logger)
  const writer: WriterOptions = {
    agentic: config.agentic,
    maxUnitChars: config.maxUnitChars,
    ...(deps.brain ? { brain: deps.brain } : {}),
  }

  async function run(ctx: Ctx, request: PodcastRequest): Promise<PodcastResult> {
    // 0. The house texts and hosts, fixed for the run (a resume after a deploy writes with the same ones).
    const house = await as<HouseStep>(
      ctx.step('house', async () =>
        json({
          showBible: await readOptional(SHOW_BIBLE, 'show bible'),
          voice: await readOptional(config.voicePath, 'voice guide'),
          hosts: config.hosts,
          createdAt: new Date().toISOString(),
        } satisfies HouseStep),
      ),
    )
    const hosts = house.hosts

    // 1. The source: the request's text plus the notes it names, read in-process through the vault capabilities.
    const source = await as<string>(
      ctx.step('source', async ({ signal }) => {
        let text = request.source
        if (request.sourcePaths.length > 0) {
          if (!deps.brain) throw new WorkflowError('invalid_input', 'sourcePaths needs the vault (AGW_BRAIN_DIR)')
          const notes = await readBrainNotes(deps.brain, request.sourcePaths, signal).catch((err: unknown) => {
            throw new WorkflowError('invalid_input', err instanceof Error ? err.message : String(err))
          })
          for (const note of notes) text += `\n\n## ${note.path}\n${note.text}`
        }
        if (text.length > MAX_SOURCE_CHARS) {
          throw new WorkflowError('invalid_input', `source exceeds ${MAX_SOURCE_CHARS} characters`)
        }
        return text
      }),
    )

    // 2. Research: best-effort, an episode without a dossier beats no episode.
    const research = await as<Metered<{ dossier: Dossier; researchUnpriced: number }>>(
      ctx.step(
        'research',
        metered(models, async (llm, scope) => {
          if (!request.research) return { dossier: EMPTY_DOSSIER, researchUnpriced: 0 }
          try {
            return await runPodcastResearch(
              llm,
              {
                source,
                language: request.language,
                series: request.series,
                ...(request.brief ? { brief: request.brief } : {}),
                ...(request.title ? { title: request.title } : {}),
              },
              {
                history: deps.history,
                series: request.series,
                signal: scope.signal,
                progress: scope.progress,
                ...(deps.brain ? { brain: deps.brain } : {}),
                ...(deps.research
                  ? {
                      research: {
                        port: deps.research,
                        ...(config.researchMaxCalls > 0 ? { maxCalls: config.researchMaxCalls } : {}),
                      },
                    }
                  : {}),
              },
            )
          } catch (err) {
            return fallBack('research', err, scope.signal, { dossier: EMPTY_DOSSIER, researchUnpriced: 0 })
          }
        }),
      ),
    )

    // 3. Editorial: the recent episodes, then one call; best-effort, the neutral default brief.
    const history = await as<EpisodeSummary[]>(
      ctx.step('history', async () => json(await deps.history.recent(request.series, config.historyDepth))),
    )
    const editorialInput = {
      dossier: research.value.dossier,
      source,
      language: request.language,
      minutes: request.minutes,
      pinMinutes: request.pinMinutes,
      bounds: { minMinutes: MIN_MINUTES, maxMinutes: MAX_MINUTES },
      series: request.series,
      hosts,
      history,
      showBible: house.showBible,
      ...(request.brief ? { brief: request.brief } : {}),
      ...(request.title ? { title: request.title } : {}),
    }
    const editorial = await as<Metered<EpisodeBrief>>(
      ctx.step(
        'editorial',
        metered(models, (llm) => decideEpisodeBrief(llm, editorialInput)),
      ),
    )
    const brief = editorial.value

    // 3b. Load-bearing follow-up: the facts the editor named, at standard depth; best-effort per fact.
    const followUp = await as<{ dossier: Dossier; usd: number; unpriced: number }>(
      ctx.step('research:follow-up', async ({ signal, progress }) => {
        const dossier = research.value.dossier
        const none = { dossier, usd: 0, unpriced: 0 }
        if (!request.research || !deps.research || brief.loadBearingFacts.length === 0) return json(none)
        try {
          const found = await runLoadBearingResearch(brief.loadBearingFacts, {
            research: deps.research,
            signal,
            progress,
          })
          return json({
            dossier: {
              ...dossier,
              additions: [...dossier.additions, ...found.additions],
              toolCalls: [...dossier.toolCalls, ...found.toolCalls],
              openQuestions: dropAnsweredOpenQuestions(dossier.openQuestions, found.answeredOpenQuestions),
              researchUsd: (dossier.researchUsd ?? 0) + found.usdSpent,
            },
            usd: found.usdSpent,
            unpriced: found.unpriced,
          })
        } catch (err) {
          return json(fallBack('research follow-up', err, signal, none))
        }
      }),
    )
    const dossier = followUp.dossier

    const req: PodcastScriptRequest = {
      source,
      language: request.language,
      minutes: request.minutes,
      hosts,
      series: request.series,
      dossier,
      episodeBrief: brief,
      ...(request.brief ? { brief: request.brief } : {}),
      ...(request.title ? { title: request.title } : {}),
    }

    // 4. Outline: required. The editor's segment count, clamped defensively.
    const segmentCount = Math.min(MAX_SEGMENTS, Math.max(1, Math.round(brief.segments)))
    const targetWords = Math.round(brief.minutes * WORDS_PER_MINUTE)
    const outlined = await as<Metered<Outline>>(
      ctx.step(
        'outline',
        metered(models, async (llm) => {
          const outline = await planOutline(llm, { req, house, segmentCount, targetWords })
          if (outline.segments.length <= MAX_SEGMENTS) return outline
          // One journaled step per segment exists up to MAX_SEGMENTS; the brief never asks for more.
          log.warn('podcast outline returned more segments than the room writes; keeping the first ones', {
            segments: outline.segments.length,
            kept: MAX_SEGMENTS,
          })
          return { ...outline, segments: outline.segments.slice(0, MAX_SEGMENTS) }
        }),
      ),
    )
    const outline = outlined.value
    const indexes = outline.segments.map((_, i) => i)

    // 5. Segments: required, three at a time; the agentic writer, the single-shot call as its fallback.
    const drafted = await mapConcurrent(config.concurrency, indexes, (index) =>
      as<Metered<WrittenSegment>>(
        (SEGMENT_STEPS[index] as StepAt)(
          ctx,
          metered(models, (llm) => writeSegment(llm, { req, outline, index, house, writer })),
        ),
      ),
    )
    const segments: ScriptSegment[] = drafted.map((d, i) => ({
      title: outline.segments[i]?.title ?? `Segment ${i + 1}`,
      turns: d.value.turns,
    }))

    // 6. Lint: deterministic, the reviewers read it and its unambiguous findings become notes.
    const lint = await as<{ report: string; notes: ReviewNote[]; findings: number }>(
      ctx.step('lint', async () => {
        const report = lintSegments(segments, {
          glossaryTerms: dossier.glossary.map((g) => g.term),
          hostNames: hosts.map((h) => h.name),
          source,
          asks: outlineAsks(outline),
          openingFrame: openingFrameOf(brief, outline),
        })
        log.info('podcast lint', {
          findings: report.findings.length,
          rules: [...new Set(report.findings.map((f) => f.rule))],
        })
        return json({ report: renderLintReport(report), notes: lintNotes(report), findings: report.findings.length })
      }),
    )

    // 7. Review: three roles on each reviewer route, in parallel, advisory (a failed reviewer is skipped).
    const reviews = await Promise.all(
      REVIEWER_ROLES.flatMap((role) =>
        REVIEW_ROUTES.map((route) =>
          as<Metered<{ notes: ReviewNote[] } | null>>(
            REVIEW_STEPS[`${role}:${route}`](
              ctx,
              metered(models, (llm) =>
                reviewDraft(llm, { req, outline, segments, role, route, house, lintReport: lint.report }),
              ),
            ),
          ),
        ),
      ),
    )
    const notes = [...reviews.flatMap((r) => r.value?.notes ?? []), ...lengthNotes(segments, outline), ...lint.notes]

    // 8. Revise every segment with notes, then tighten what is still over length; each best-effort per segment.
    const revisePass = async (steps: StepAt[], current: ScriptSegment[], passNotes: ReviewNote[]) => {
      const targets = indexes.filter((i) => segmentNotesFor(passNotes, i).length > 0)
      const done = await mapConcurrent(config.concurrency, targets, (index) =>
        as<Metered<WrittenSegment | null>>(
          (steps[index] as StepAt)(
            ctx,
            metered(models, (llm) =>
              reviseSegment(llm, { req, outline, segments: current, index, notes: passNotes, house, writer }),
            ),
          ),
        ),
      )
      const byIndex = new Map(targets.map((index, k) => [index, done[k]]))
      return {
        segments: current.map((seg, i) => {
          const turns = byIndex.get(i)?.value?.turns
          return turns ? { ...seg, turns } : seg
        }),
        metered: done,
      }
    }
    const revised = notes.length > 0 ? await revisePass(REVISE_STEPS, segments, notes) : { segments, metered: [] }
    const stillLong = lengthNotes(revised.segments, outline)
    if (stillLong.length > 0) {
      log.warn('podcast segments still over length after revision, tightening', {
        segments: stillLong.map((n) => n.segmentIndex),
      })
    }
    const tightened =
      stillLong.length > 0
        ? await revisePass(TIGHTEN_STEPS, revised.segments, stillLong)
        : { segments: revised.segments, metered: [] }
    const finalSegments = tightened.segments

    // 9. Metadata: best-effort, field by field over the outline's drafts.
    const meta = await as<Metered<EpisodeMetadata | null>>(
      ctx.step(
        'metadata',
        metered(models, async (llm, scope) => {
          try {
            return await writeEpisodeMetadata(llm, { req, outline, segments: finalSegments })
          } catch (err) {
            return fallBack('metadata', err, scope.signal, null)
          }
        }),
      ),
    )

    // 10. The locked script and its profile: the transcript source of `past_transcript` and the editor's history.
    const agentRuns: AgentRun[] = [
      ...drafted.map((d) => d.value.agent),
      ...revised.metered.map((m) => m.value?.agent ?? null),
      ...tightened.metered.map((m) => m.value?.agent ?? null),
    ].filter((r): r is AgentRun => r !== null)
    const locked = await as<ScriptStep>(
      ctx.step('script', async () => {
        const script = assembleScript({ outline, segments: finalSegments, metadata: meta.value, request, brief })
        const profile = buildEpisodeProfile({ brief, script, dossier, hosts, requestedMinutes: request.minutes })
        if (agentRuns.length > 0) {
          profile.agent = {
            runs: agentRuns.length,
            rounds: agentRuns.reduce((n, r) => n + r.rounds, 0),
            rejections: agentRuns.reduce((n, r) => n + r.rejections, 0),
            fellBack: agentRuns.filter((r) => r.fellBack).length,
          }
        }
        return json({ script: { ...script, hosts }, profile } satisfies ScriptStep)
      }),
    )
    const { script, profile } = locked

    const spend = sumSpend([
      research.spend,
      editorial.spend,
      outlined.spend,
      ...drafted.map((d) => d.spend),
      ...reviews.map((r) => r.spend),
      ...revised.metered.map((m) => m.spend),
      ...tightened.metered.map((m) => m.spend),
      meta.spend,
    ])
    const cost = {
      scriptUsd: Math.round(spend.usd * 1e6) / 1e6,
      scriptUnpriced: spend.unpriced,
      researchUsd: Math.round((dossier.researchUsd ?? 0) * 1e6) / 1e6,
      researchUnpriced: research.value.researchUnpriced + followUp.unpriced,
    }
    const chapterTitles = script.segments.map((s) => ({ title: s.title }))

    // 11. Produce: the internal child (synth, master, cover, publish, brain note). Required once wired.
    if (!deps.produce) {
      log.warn('podcast.produce is not wired: the run ends with the script', { runId: ctx.runId })
      return {
        title: script.title,
        description: script.description,
        chapters: chapterTitles,
        profile,
        cost,
        produce: null,
      }
    }
    const input: ProduceInputValue = {
      episode: { id: ctx.runId, createdAt: house.createdAt },
      script: {
        language: script.language,
        segments: script.segments,
        wordCount: script.wordCount,
        ...(script.asks ? { asks: script.asks } : {}),
        ...(script.openingFrame ? { openingFrame: script.openingFrame } : {}),
      },
      hosts,
      metadata: {
        title: script.title,
        description: script.description,
        coverPrompt: script.coverPrompt,
        genres: script.genres,
        topics: script.topics,
      },
      request: {
        series: request.series,
        language: request.language,
        minutes: request.minutes,
        publish: request.publish,
        cover: request.cover,
        brainNote: request.brainNote,
      },
      profile,
    }
    const [produced] = await ctx.workflow('produce', deps.produce, [input])
    if (produced === null || produced === undefined) {
      throw new WorkflowError('step_failed', 'podcast.produce failed; its run record holds the error')
    }
    const result = ProduceResult.parse(produced)
    return {
      title: script.title,
      description: script.description,
      chapters: result.chapters ?? chapterTitles,
      profile: { ...profile, durationSeconds: result.durationSeconds ?? profile.durationSeconds },
      cost,
      produce: result,
    }
  }

  const podcast = defineWorkflow({
    id: 'podcast',
    version: PODCAST_VERSION,
    input: PodcastInput,
    output: PodcastOutput,
    // Legacy ran one episode at a time (one queue); the produce stage's synth and mastering are the heavy part.
    concurrency: 1,
    run,
  })
  return podcast
}

/** The final script: the metadata pass field by field over the outline's drafts, chapter titles per segment. */
export function assembleScript(params: {
  outline: Outline
  segments: ScriptSegment[]
  metadata: EpisodeMetadata | null
  request: PodcastRequest
  brief: EpisodeBrief
}): PodcastScript {
  const { outline, segments, metadata, request, brief } = params
  const wordCount = segments.reduce((sum, seg) => sum + seg.turns.reduce((s, t) => s + countWords(t.text), 0), 0)
  const chapterTitle = new Map((metadata?.chapters ?? []).map((c) => [c.segmentIndex, c.title]))
  const asks = outlineAsks(outline)
  const openingFrame = openingFrameOf(brief, outline)
  return {
    title: metadata?.title || outline.title || request.title || request.series,
    description: metadata?.description || outline.description,
    coverPrompt: metadata?.coverPrompt || outline.coverPrompt,
    genres: metadata && metadata.genres.length > 0 ? metadata.genres : outline.genres,
    language: request.language,
    segments: segments.map((seg, i) => {
      const title = chapterTitle.get(i)
      return title ? { ...seg, title } : seg
    }),
    wordCount,
    topics: metadata?.topics ?? [],
    ...(asks.length > 0 ? { asks } : {}),
    ...(openingFrame.length > 0 ? { openingFrame } : {}),
  }
}

export { defaultEpisodeBrief }

import type { AnyWorkflow, Ctx, Json, Logger, StepScope, Workflow } from '../../../../runtime/src/index.ts'
import { Cancelled, defineWorkflow, InfraError, WorkflowError } from '../../../../runtime/src/index.ts'
import { episodeToken } from '../podcast-produce/abs.ts'
import { type NotifyConfig, notifyConfigFromEnv, notifyPodcastResult } from '../podcast-produce/notify.ts'
import type { AgentRun } from './agent.ts'
import { type PodcastConfig, podcastConfigFromEnv } from './config.ts'
import { decideEpisodeBrief, defaultEpisodeBrief } from './editorial.ts'
import { iuModelPort } from './iu.ts'
import { lintNotes, lintSegments, renderLintReport } from './lint.ts'
import { Llm, type ModelPort } from './llm.ts'
import { log, setPodcastLogger } from './log.ts'
import type { BrainPort, EpisodeCost, HistoryPort, PodcastJournal, ResearchPort, Spent } from './ports.ts'
import { researchStepPrefix, startedByKey } from './ports.ts'
import type { ProduceInput, ProduceInputValue } from './produce-input.ts'
import {
  dropAnsweredOpenQuestions,
  type LoadBearingAnswer,
  loadBearingToRun,
  researchLoadBearingFact,
  runPodcastResearch,
} from './research.ts'
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
  MAX_MINUTES,
  MAX_SOURCE_CHARS,
  MIN_MINUTES,
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
import { type SourceReader, vaultSourceReader } from './source.ts'
import type { Dossier, EpisodeBrief, EpisodeProfile, EpisodeSummary } from './types.ts'
import { EMPTY_DOSSIER } from './types.ts'
import { mapConcurrent } from './vocab.ts'

export const PODCAST_VERSION = '2026-10-29.2'
export { ProduceInput, type ProduceInputValue } from './produce-input.ts'
export { PodcastInput, PodcastOutput } from './schema.ts'

/** What the workflow is built from. `history` and `journal` read the journal; the rest defaults to production. */
export interface PodcastDeps {
  /** The show's memory (`postgresHistory`). */
  history: HistoryPort
  /**
   * The journal (`postgresJournal`): the episode's recorded cost (the output's `cost` is read from it, never summed
   * here) and the research runs a step already started (a resumed step re-attaches to them).
   */
  journal: PodcastJournal
  /** The model transport. Default: IU (`iu.ts`). */
  models?: ModelPort
  /** The vault for the research agent's tools (`brain.ts`, the capability allowlist); absent: no brain tools. */
  brain?: BrainPort
  /** Where `sourcePaths` are read (`source.ts`, legacy's rule). Default: the vault at `config.vaultDir`. */
  sources?: SourceReader
  /** The host's `research` workflow (`research-client.ts`); absent: no `research` tool and no follow-up. */
  research?: ResearchPort
  /**
   * The internal child that turns the locked script into the published episode. Absent: the run ends after the
   * script with `produce: null` (the writers' room alone; the produce workflow lands separately).
   */
  produce?: Workflow<typeof ProduceInput, AnyWorkflow['output']>
  config?: Partial<PodcastConfig>
  /** The Slack notice of a failed episode (legacy's env, `notify.ts`); default from the process env, null = none. */
  notify?: { config: NotifyConfig | null; fetch?: typeof fetch }
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
/** One step per load-bearing fact (at most `MAX_LOAD_BEARING_FACTS`): a resume never repeats a finished one. */
const FACT_STEPS: { id: string; at: StepAt }[] = [
  { id: 'research:fact:0', at: (ctx, body) => ctx.step('research:fact:0', body) },
  { id: 'research:fact:1', at: (ctx, body) => ctx.step('research:fact:1', body) },
  { id: 'research:fact:2', at: (ctx, body) => ctx.step('research:fact:2', body) },
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

/** A model-calling step: its calls bound to the step's `addUsage` (the journal records what they cost). */
function withLlm<T>(models: ModelPort, fn: (llm: Llm, scope: StepScope) => Promise<T>): Body {
  return async (scope) => json(await fn(new Llm(models, scope), scope))
}

/** A best-effort stage's failure: its fallback stands, unless the step was aborted (cancel, lease loss, shutdown). */
function fallBack<T>(stage: string, error: unknown, signal: AbortSignal, fallback: T): T {
  if (signal.aborted) throw error
  log.warn(`podcast ${stage} failed, using its fallback`, {
    error: error instanceof Error ? error.message : String(error),
  })
  return fallback
}

const usd = (value: number) => Math.round(value * 1e6) / 1e6
const total = (...parts: Spent[]): Spent => ({
  usd: usd(parts.reduce((n, p) => n + p.usd, 0)),
  unpriced: parts.reduce((n, p) => n + p.unpriced, 0),
})

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

/** The loops' counters for the profile; the loops themselves are not journaled beyond these. */
function agentProfile(runs: AgentRun[]): EpisodeProfile['agent'] {
  return {
    runs: runs.length,
    rounds: runs.reduce((n, r) => n + r.rounds, 0),
    rejections: runs.reduce((n, r) => n + r.rejections, 0),
    fellBack: runs.filter((r) => r.fellBack).length,
  }
}

export function createPodcastWorkflow(deps: PodcastDeps) {
  const config: PodcastConfig = { ...podcastConfigFromEnv(), ...deps.config }
  const models = deps.models ?? iuModelPort()
  const sources = deps.sources ?? vaultSourceReader(config.vaultDir)
  if (deps.logger) setPodcastLogger(deps.logger)
  const writer: WriterOptions = {
    agentic: config.agentic,
    maxUnitChars: config.maxUnitChars,
    ...(deps.brain ? { brain: deps.brain } : {}),
  }

  /** The research runs one step already started (an earlier attempt, a run before a restart), by key. */
  async function startedIn(runId: string, stepId: string): Promise<Map<string, string>> {
    const prefix = researchStepPrefix(runId, stepId)
    return startedByKey(prefix, await deps.journal.startedResearch(prefix))
  }

  const notify = deps.notify ?? { config: notifyConfigFromEnv(process.env) }

  /**
   * Legacy's failure line in Slack for a failed episode, room or production (its child's failure ends the room). Not for
   * a run that resumes (an infra error, a shutdown, a lost lease) or one that was cancelled. Best-effort: never masks
   * the failure itself.
   */
  async function noticeFailure(ctx: Ctx, error: unknown): Promise<void> {
    if (!notify.config || ctx.signal.aborted || error instanceof InfraError || error instanceof Cancelled) return
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 500)
    // The episode token of its Audiobookshelf file name, as legacy's id8 was.
    const text = `Podcast-Job ${episodeToken(ctx.runId)} ist fehlgeschlagen: ${message}`
    try {
      await notifyPodcastResult(notify.config, text, notify.fetch)
    } catch (err) {
      log.warn('podcast failure notice failed', { error: err instanceof Error ? err.message : String(err) })
    }
  }

  async function runWithNotice(ctx: Ctx, request: PodcastRequest): Promise<PodcastResult> {
    try {
      return await run(ctx, request)
    } catch (error) {
      await noticeFailure(ctx, error)
      throw error
    }
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

    // 1. The source: the request's text plus the notes it names, raw, read by legacy's rule (`source.ts`).
    const source = await as<string>(
      ctx.step('source', async () => {
        let text = request.source
        for (const path of request.sourcePaths) {
          const note = await sources.read(path).catch((err: unknown) => {
            throw new WorkflowError('invalid_input', `sourcePaths: ${err instanceof Error ? err.message : String(err)}`)
          })
          text += `\n\n## ${path}\n${note}`
        }
        if (text.length > MAX_SOURCE_CHARS) {
          throw new WorkflowError('invalid_input', `source exceeds ${MAX_SOURCE_CHARS} characters`)
        }
        return text
      }),
    )

    // 2. Research: best-effort, an episode without a dossier beats no episode.
    const researched = await as<Dossier>(
      ctx.step(
        'research',
        withLlm(models, async (llm, scope) => {
          if (!request.research) return EMPTY_DOSSIER
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
                        origin: { runId: ctx.runId, stepId: 'research' },
                        started: await startedIn(ctx.runId, 'research'),
                        ...(config.researchMaxCalls > 0 ? { maxCalls: config.researchMaxCalls } : {}),
                      },
                    }
                  : {}),
              },
            )
          } catch (err) {
            return fallBack('research', err, scope.signal, EMPTY_DOSSIER)
          }
        }),
      ),
    )

    // 3. Editorial: the recent episodes, then one call; best-effort, the neutral default brief.
    const history = await as<EpisodeSummary[]>(
      ctx.step('history', async () => json(await deps.history.recent(request.series, config.historyDepth))),
    )
    const editorialInput = {
      dossier: researched,
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
    const brief = await as<EpisodeBrief>(
      ctx.step(
        'editorial',
        withLlm(models, (llm) => decideEpisodeBrief(llm, editorialInput)),
      ),
    )

    // 3b. Load-bearing follow-up: each fact the editor named, at standard depth, its own step; best-effort per fact.
    const research = deps.research
    const facts = request.research && research ? loadBearingToRun(brief.loadBearingFacts) : []
    const answers = await Promise.all(
      facts.map((fact, i) => {
        const step = FACT_STEPS[i] as (typeof FACT_STEPS)[number]
        return as<LoadBearingAnswer | null>(
          step.at(ctx, async ({ signal, progress }) => {
            try {
              return json(
                await researchLoadBearingFact(fact, {
                  research: research as ResearchPort,
                  origin: { runId: ctx.runId, stepId: step.id },
                  started: await startedIn(ctx.runId, step.id),
                  signal,
                  progress,
                }),
              )
            } catch (err) {
              return json(fallBack('load-bearing research', err, signal, null))
            }
          }),
        )
      }),
    )
    const dossier: Dossier = {
      ...researched,
      additions: [...researched.additions, ...answers.flatMap((a) => (a?.addition ? [a.addition] : []))],
      toolCalls: [...researched.toolCalls, ...answers.flatMap((a) => (a ? [a.toolCall] : []))],
      openQuestions: dropAnsweredOpenQuestions(
        researched.openQuestions,
        answers.flatMap((a) => (a?.answeredOpenQuestion ? [a.answeredOpenQuestion] : [])),
      ),
    }

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

    // 4. Outline: required. The editor's segment count, clamped defensively; at most one step per segment.
    const segmentCount = Math.min(MAX_SEGMENTS, Math.max(1, Math.round(brief.segments)))
    const targetWords = Math.round(brief.minutes * WORDS_PER_MINUTE)
    const outline = await as<Outline>(
      ctx.step(
        'outline',
        withLlm(models, (llm) =>
          planOutline(llm, { req, house, segmentCount, targetWords, maxSegments: SEGMENT_STEPS.length }),
        ),
      ),
    )
    const indexes = outline.segments.map((_, i) => i)

    // 5. Segments: required, three at a time; the agentic writer, the single-shot call as its fallback.
    const drafted = await mapConcurrent(config.concurrency, indexes, (index) =>
      as<WrittenSegment>(
        (SEGMENT_STEPS[index] as StepAt)(
          ctx,
          withLlm(models, (llm) => writeSegment(llm, { req, outline, index, house, writer })),
        ),
      ),
    )
    const segments: ScriptSegment[] = drafted.map((d, i) => ({
      title: outline.segments[i]?.title ?? `Segment ${i + 1}`,
      turns: d.turns,
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
          as<{ notes: ReviewNote[] } | null>(
            REVIEW_STEPS[`${role}:${route}`](
              ctx,
              withLlm(models, (llm) =>
                reviewDraft(llm, { req, outline, segments, role, route, house, lintReport: lint.report }),
              ),
            ),
          ),
        ),
      ),
    )
    const notes = [...reviews.flatMap((r) => r?.notes ?? []), ...lengthNotes(segments, outline), ...lint.notes]

    // 8. Revise every segment with notes, then tighten what is still over length; each best-effort per segment.
    const revisePass = async (steps: StepAt[], current: ScriptSegment[], passNotes: ReviewNote[]) => {
      const targets = indexes.filter((i) => segmentNotesFor(passNotes, i).length > 0)
      const done = await mapConcurrent(config.concurrency, targets, (index) =>
        as<WrittenSegment | null>(
          (steps[index] as StepAt)(
            ctx,
            withLlm(models, (llm) =>
              reviseSegment(llm, { req, outline, segments: current, index, notes: passNotes, house, writer }),
            ),
          ),
        ),
      )
      const byIndex = new Map(targets.map((index, k) => [index, done[k]]))
      return {
        segments: current.map((seg, i) => {
          const turns = byIndex.get(i)?.turns
          return turns ? { ...seg, turns } : seg
        }),
        written: done,
      }
    }
    const revised = notes.length > 0 ? await revisePass(REVISE_STEPS, segments, notes) : { segments, written: [] }
    const stillLong = lengthNotes(revised.segments, outline)
    if (stillLong.length > 0) {
      log.warn('podcast segments still over length after revision, tightening', {
        segments: stillLong.map((n) => n.segmentIndex),
      })
    }
    const tightened =
      stillLong.length > 0
        ? await revisePass(TIGHTEN_STEPS, revised.segments, stillLong)
        : { segments: revised.segments, written: [] }
    const finalSegments = tightened.segments

    // 9. Metadata: best-effort, field by field over the outline's drafts.
    const metadata = await as<EpisodeMetadata | null>(
      ctx.step(
        'metadata',
        withLlm(models, async (llm, scope) => {
          try {
            return await writeEpisodeMetadata(llm, { req, outline, segments: finalSegments })
          } catch (err) {
            return fallBack('metadata', err, scope.signal, null)
          }
        }),
      ),
    )

    // 10. The locked script and its profile: the transcript source of `past_transcript` and the editor's history. The
    // research spend in the profile is the journal's record of the research runs, all finished by now.
    const agentRuns: AgentRun[] = [...drafted, ...revised.written, ...tightened.written].flatMap((w) =>
      w?.agent ? [w.agent] : [],
    )
    const locked = await as<ScriptStep>(
      ctx.step('script', async () => {
        const script = assembleScript({ outline, segments: finalSegments, metadata, request, brief })
        const recorded = await deps.journal.episodeCost(ctx.runId)
        const profile = buildEpisodeProfile({
          brief,
          script,
          dossier,
          hosts,
          requestedMinutes: request.minutes,
        })
        if (agentRuns.length > 0) profile.agent = agentProfile(agentRuns)
        // The research spend as recorded: with how many calls had no price, and null while a run has not ended.
        if (recorded.research.runs > 0) {
          profile.researchUsd = recorded.research.pending > 0 ? null : usd(recorded.research.usd)
          profile.researchUnpriced = recorded.research.unpriced
        }
        return json({ script: { ...script, hosts }, profile } satisfies ScriptStep)
      }),
    )
    const { script, profile } = locked
    const chapterTitles = script.segments.map((s) => ({ title: s.title }))

    // 11. Produce: the internal child (synth, master, cover, publish, brain note). Required once wired.
    let produced: Produced | null = null
    if (deps.produce) {
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
      const [result] = await ctx.workflow('produce', deps.produce, [input])
      if (result === null || result === undefined) {
        throw new WorkflowError('step_failed', 'podcast.produce failed; its run record holds the error')
      }
      produced = ProduceResult.parse(result)
    } else {
      log.warn('podcast.produce is not wired: the run ends with the script', { runId: ctx.runId })
    }

    // 12. Cost: the journal's record of every call this episode made (retries, failed attempts, resumes included).
    const recorded = await as<EpisodeCost>(
      ctx.step('cost', async () => json(await deps.journal.episodeCost(ctx.runId))),
    )
    const all = total(recorded.script, recorded.research, recorded.produce)
    return {
      title: script.title,
      description: script.description,
      chapters: produced?.chapters ?? chapterTitles,
      profile: { ...profile, durationSeconds: produced?.durationSeconds ?? profile.durationSeconds },
      cost: {
        scriptUsd: usd(recorded.script.usd),
        scriptUnpriced: recorded.script.unpriced,
        researchUsd: usd(recorded.research.usd),
        researchUnpriced: recorded.research.unpriced,
        researchRuns: recorded.research.runs,
        researchPending: recorded.research.pending,
        produceUsd: usd(recorded.produce.usd),
        produceUnpriced: recorded.produce.unpriced,
        totalUsd: all.usd,
        unpriced: all.unpriced,
        // Exact only when every call was priced and every research run had ended; otherwise a lower bound.
        complete: all.unpriced === 0 && recorded.research.pending === 0,
      },
      produce: produced,
    }
  }

  return defineWorkflow({
    id: 'podcast',
    version: PODCAST_VERSION,
    input: PodcastInput,
    output: PodcastOutput,
    // Legacy ran one episode at a time (one queue); the produce stage's synth and mastering are the heavy part.
    concurrency: 1,
    run: runWithNotice,
  })
}

type Produced = ReturnType<typeof ProduceResult.parse>

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

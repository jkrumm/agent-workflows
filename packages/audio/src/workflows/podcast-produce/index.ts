import { join } from 'node:path'
import { z } from 'zod'
import { artifactDir } from '../../../../host/src/artifacts.ts'
import type { Ctx, Json, Logger, Usage } from '../../../../runtime/src/index.ts'
import { defineWorkflow, WorkflowError } from '../../../../runtime/src/index.ts'
import { audioRoutes } from '../../routes.ts'
import type { AudioDeps } from '../../scope.ts'
import type { UsagePort } from '../../usage.ts'
import { renderTranscriptMarkdown } from '../podcast/history.ts'
import { lintSegmentation, type SegmentationReport } from '../podcast/lint.ts'
import { ProduceInput, type ProduceInputValue } from '../podcast/produce-input.ts'
import { type AbsDeps, episodeFilename, publishToAudiobookshelf } from './abs.ts'
import { writeEpisodeBrainNote } from './brain-note.ts'
import { type ProduceConfig, produceConfigFromEnv } from './config.ts'
import {
  findCover,
  readStored,
  type StoredFile,
  type StoredUnit,
  store,
  storeCover,
  unitRequestHash,
  usageToRecord,
} from './files.ts'
import type { ProduceJournal } from './journal.ts'
import { log, messageOf, setProduceLogger } from './log.ts'
import {
  buildMuxTurns,
  type Chapter,
  chaptersFromSegments,
  concatWithGaps,
  masterPodcastMp3,
  matchHostLoudness,
  PRE_MASTER_HOST_LUFS,
} from './mux.ts'
import { notifyPodcastResult, podcastDoneMessage } from './notify.ts'
import { createUnitWorkflow, speakersOf, type UnitInputValue } from './unit.ts'
import {
  type SynthTurnInput,
  type SynthUnit,
  type TtsLane,
  turnsForSynthesis,
  unitsForMultiSpeaker,
  unitsPerTurn,
} from './synth.ts'

// `podcast.produce`: the writers' room's locked script to a published episode (audio-gateway `runPodcastPipeline` from
// step 4 on, `publishEpisode`, the Slack notice, `writeEpisodeBrainNote`). Internal: only the room's `ctx.workflow`
// (and a resume) starts it. Its follow-up `podcast-publish` (legacy `POST /:id/publish`) is `publish.ts`.

export const PRODUCE_VERSION = '2026-10-29.1'
export { ProduceInput, type ProduceInputValue }

/** The artifact store's workflow directory: `<root>/podcast/<episode id>/`, legacy's per-job directory. */
export const ARTIFACT_WORKFLOW = 'podcast'

const Abs = z.object({ url: z.string(), libraryItemId: z.string(), episodeId: z.string().nullable() })
const Publish = z.object({
  /** The request's `publish` (forced true by `podcast-publish`). */
  requested: z.boolean(),
  /** null = not attempted (not requested). */
  ok: z.boolean().nullable(),
  error: z.string().nullable(),
})
const BrainNote = z.object({ path: z.string(), committed: z.boolean(), pushed: z.boolean() })
const Segmentation = z.object({
  units: z.number(),
  minChars: z.number(),
  meanChars: z.number(),
  maxChars: z.number(),
  findings: z.array(z.string()),
})

export const ProduceOutput = z.object({
  /** The mastered episode in the artifact store (30-day retention). */
  mp3Path: z.string(),
  coverPath: z.string().nullable(),
  durationSeconds: z.number(),
  turns: z.number(),
  chapters: z.array(z.object({ title: z.string(), startMs: z.number() })),
  abs: Abs.nullable(),
  publish: Publish,
  brainNote: BrainNote.nullable(),
  /** The multi-speaker segmentation lint (legacy `profile.segmentation`); null on the per-turn lane. */
  segmentation: Segmentation.nullable(),
  /** This run's journaled spend (synth and cover); `complete` false when a call had no price. */
  cost: z.object({ usd: z.number(), unpriced: z.number(), complete: z.boolean() }),
})
export type ProduceResult = z.output<typeof ProduceOutput>
export type AbsResult = z.output<typeof Abs>
export type PublishResult = z.output<typeof Publish>
export type BrainNoteResult = z.output<typeof BrainNote>

/** The image capability (`image.generate`), structurally: called in-process, its usage on the cover step. */
export interface CoverCall {
  call(
    input: { prompt: string; size: string; quality: 'medium'; n: number },
    options: { signal: AbortSignal; addUsage: (usage: Usage) => void },
  ): Promise<{ images: { b64: string }[] }>
}

/** The parts of the effects tests replace: never a network or a real vault lock by default in a test. */
export interface EffectDeps {
  abs?: Omit<AbsDeps, 'config'>
  notifyFetch?: typeof fetch
  brainLock?: { lockDir?: string; lockRetryAttempts?: number; lockRetryDelayMs?: number }
}

export interface ProduceDeps extends EffectDeps {
  journal: ProduceJournal
  /** The audio lanes' deps without `usage`: every synth step opens its own scope, its calls priced onto that step. */
  audio: Omit<AudioDeps, 'usage'>
  /** Absent: no cover (the episode is produced without one). */
  cover?: CoverCall
  config?: Partial<ProduceConfig>
  /** The artifact store's root (tests). Default the host's (`artifacts.ts`). */
  artifactRoot?: string
  logger?: Logger
  /** Test seam: called after a billed file (a unit, the cover) is stored, before its step ends: a kill there. */
  onStored?: (file: StoredFile) => Promise<void>
  /** The clock for the episode's date (tests). */
  now?: () => Date
}

/** What the `plan` step journals: everything later steps read, fixed for the run (a resume after a deploy keeps it). */
export interface Plan {
  lane: TtsLane
  turns: SynthTurnInput[]
  units: SynthUnit[]
  segmentation: SegmentationReport | null
  /** The episode's MP3 track number in its series. */
  track: number
  /** YYYY-MM-DD: the MP3 date tag and the Audiobookshelf file name. */
  date: string
  /** The file name in the show folder; its `[xxxxxxxx]` episode token is how a resumed publish finds its upload. */
  filename: string
}

export interface Mastered {
  mp3: StoredFile
  durationSeconds: number
  turns: number
  chapters: Chapter[]
  gainsDb: Record<string, number>
}

const json = (value: unknown): Json => JSON.parse(JSON.stringify(value)) as Json
const as = async <T>(value: Promise<Json>): Promise<T> => (await value) as unknown as T

/** A best-effort stage's failure: its fallback stands, unless the step was aborted (cancel, lease loss, shutdown). */
export function fallBack<T>(stage: string, error: unknown, signal: AbortSignal, fallback: T): T {
  if (signal.aborted) throw error
  log.warn(`podcast ${stage} failed, continuing without it`, { error: messageOf(error) })
  return fallback
}

/** The audio scope's call events as the step's usage: the journal records the cost (and projects it to Argo). */
export function stepUsage(addUsage: (usage: Usage) => void): UsagePort {
  return {
    record(event) {
      if (event.kind !== 'call') return
      const notBilled = event.costSource === 'not-billed'
      addUsage({
        model: event.model,
        tokens: {
          input: event.inputTokens ?? 0,
          output: event.outputTokens ?? 0,
          cacheRead: event.cachedTokens ?? 0,
          reasoning: 0,
        },
        cost: notBilled ? 0 : event.costUsd,
        costSource: event.costSource === 'provider' || event.costSource === 'unknown' ? event.costSource : 'rate',
      })
    },
  }
}

/** The lane the configured route runs on. */
export function laneFor(config: ProduceConfig, audio: ProduceDeps['audio']): TtsLane {
  const route = audioRoutes(audio.env)[config.ttsRouteId as keyof ReturnType<typeof audioRoutes>]
  if (!route) throw new Error(`audio route "${config.ttsRouteId}" is not in the route table`)
  if (route.lane === 'gemini') return { kind: 'gemini', routeId: route.id, hostStyles: config.hostStyles }
  if (route.lane === 'replicate') {
    return {
      kind: 'replicate',
      routeId: route.id,
      stability: config.stability,
      similarityBoost: audio.config.ttsElevenLabsSimilarity,
      style: audio.config.ttsElevenLabsStyle,
    }
  }
  throw new Error(`audio route "${route.id}" is a ${route.lane} route, not a TTS lane`)
}

/** Turns, units and segmentation: legacy's synth stage up to the first request. Pure. */
export function planSynthesis(
  input: ProduceInputValue,
  lane: TtsLane,
  config: Pick<ProduceConfig, 'denseTurnThreshold' | 'denseTurnSlowdown' | 'multiSpeakerMaxChars'>,
): Pick<Plan, 'turns' | 'units' | 'segmentation'> {
  const { segments } = input.script
  const turns = turnsForSynthesis(segments, input.hosts, input.request.language, {
    denseThreshold: config.denseTurnThreshold,
    denseSlowdown: config.denseTurnSlowdown,
  })
  const segmentLengths = segments.map((s) => s.turns.length)
  if (lane.kind !== 'gemini') return { turns, units: unitsPerTurn(turns.length), segmentation: null }
  const units = unitsForMultiSpeaker(turns, segmentLengths, config.multiSpeakerMaxChars)
  const segmentation = lintSegmentation({
    texts: turns.map((t) => t.text),
    segmentLengths,
    units,
    maxChars: config.multiSpeakerMaxChars,
  })
  return { turns, units, segmentation }
}

/** The episode's artifact directory. */
export const episodeDir = (episodeId: string, root?: string) =>
  artifactDir(ARTIFACT_WORKFLOW, episodeId, root ? { root } : {})

// ---------------------------------------------------------------------------
// The effects: shared with `podcast-publish`. Each never throws but on abort.
// ---------------------------------------------------------------------------

export interface PublishParams {
  input: ProduceInputValue
  config: ProduceConfig
  deps: EffectDeps
  filename: string
  mp3: StoredFile
  cover: StoredFile | null
  signal: AbortSignal
  /** The effect key (`<runId>:<stepId>`), for the log. */
  key: string
}

/**
 * Upload, scan, poll, patch (legacy `publishEpisode`). A resumed or repeated publish finds its own upload first (the
 * file name's episode token, `abs.ts`) and only patches it: never a second episode.
 */
export async function publishEpisode(
  params: PublishParams,
): Promise<{ abs: AbsResult | null; publish: PublishResult }> {
  const { input, config, deps, filename, signal, key } = params
  if (!config.abs) {
    log.warn('publish skipped: audiobookshelf not configured', { episode: input.episode.id, key })
    return { abs: null, publish: { requested: true, ok: false, error: 'not configured' } }
  }
  try {
    const published = await publishToAudiobookshelf(
      { ...deps.abs, config: config.abs },
      {
        series: input.request.series,
        author: config.author,
        description: config.seriesDescription,
        language: input.request.language,
        genres: input.metadata.genres,
        episode: {
          title: input.metadata.title,
          description: input.metadata.description,
          filename,
          file: await readStored(params.mp3),
        },
        ...(params.cover ? { cover: await readStored(params.cover) } : {}),
      },
    )
    log.info('podcast published', { episode: input.episode.id, key, itemId: published.libraryItemId })
    return {
      abs: { url: published.url, libraryItemId: published.libraryItemId, episodeId: published.episodeId },
      publish: { requested: true, ok: true, error: null },
    }
  } catch (error) {
    if (signal.aborted) throw error
    const message = messageOf(error).slice(0, 500)
    log.error('podcast publish failed', { episode: input.episode.id, key, error: message })
    return { abs: null, publish: { requested: true, ok: false, error: message } }
  }
}

/** The transcript note and the regenerated folder note, committed and pushed (legacy `writeEpisodeBrainNote`). */
export async function fileBrainNote(params: {
  input: ProduceInputValue
  config: ProduceConfig
  deps: EffectDeps
  durationSeconds: number
  segmentation: SegmentationReport | null
  absItemId: string | null
  key: string
}): Promise<BrainNoteResult | null> {
  const { input, config, key } = params
  if (!input.request.brainNote) return null
  if (!config.brainDir) {
    log.warn('brain note skipped: BRAIN_DIR is not set', { episode: input.episode.id })
    return null
  }
  const profile = {
    ...input.profile,
    durationSeconds: params.durationSeconds,
    ...(params.segmentation ? { segmentation: params.segmentation } : {}),
  }
  try {
    return await writeEpisodeBrainNote({
      brainDir: config.brainDir,
      jobId: input.episode.id,
      title: input.metadata.title,
      description: input.metadata.description,
      series: input.request.series,
      createdAt: input.episode.createdAt,
      profile,
      transcriptMarkdown: renderTranscriptMarkdown({
        title: input.metadata.title,
        description: input.metadata.description,
        segments: input.script.segments,
        hosts: input.hosts,
      }),
      absItemId: params.absItemId,
      effectKey: key,
      ...params.deps.brainLock,
    })
  } catch (error) {
    log.warn('brain note failed', { episode: input.episode.id, error: messageOf(error) })
    return null
  }
}

// ---------------------------------------------------------------------------
// The workflow
// ---------------------------------------------------------------------------

/** `podcast.produce` and its per-unit child; both are registered (internal) so a resume finds them. */
export function createProduceWorkflows(deps: ProduceDeps) {
  const config: ProduceConfig = { ...produceConfigFromEnv(deps.audio.env ?? process.env), ...deps.config }
  if (deps.logger) setProduceLogger(deps.logger)
  const now = deps.now ?? (() => new Date())

  const unitWorkflow = createUnitWorkflow({
    audio: deps.audio,
    dirOf: (episodeId) => episodeDir(episodeId, deps.artifactRoot),
    ...(deps.onStored ? { onStored: deps.onStored } : {}),
    usage: stepUsage,
  })

  async function run(ctx: Ctx, input: ProduceInputValue): Promise<ProduceResult> {
    const dir = episodeDir(input.episode.id, deps.artifactRoot)

    // 1. The plan: turns, units, track and date, fixed for the run.
    const plan = await as<Plan>(
      ctx.step('plan', async () => {
        const lane = laneFor(config, deps.audio)
        const planned = planSynthesis(input, lane, config)
        if (planned.segmentation)
          log.info('podcast segmentation', { episode: input.episode.id, ...planned.segmentation })
        const date = now().toISOString().slice(0, 10)
        return json({
          lane,
          ...planned,
          track: (await deps.journal.episodesInSeries(input.request.series)) + 1,
          date,
          filename: episodeFilename(date, input.metadata.title, input.episode.id),
        } satisfies Plan)
      }),
    )

    // 2. Synth (one child run per unit, its audio in the store) and the cover (best-effort), side by side.
    const speakers = speakersOf(plan.turns)
    const [synthesized, cover] = await Promise.all([
      ctx.workflow(
        'synth',
        unitWorkflow,
        plan.units.map(
          (unit, index): UnitInputValue => ({
            episodeId: input.episode.id,
            index,
            lane: { ...plan.lane },
            speakers: speakers.map((t) => ({ ...t })),
            turns: unit.turnIndexes.map((t) => ({ ...(plan.turns[t] as SynthTurnInput) })),
          }),
        ),
      ),
      as<StoredFile | null>(
        ctx.step('cover', async ({ signal, addUsage, key }) => {
          if (!input.request.cover || !deps.cover) return null
          const request = { prompt: input.metadata.coverPrompt, size: '1024x1024', quality: 'medium' as const, n: 1 }
          const hash = unitRequestHash(request)
          const found = await findCover(dir, hash)
          if (found) {
            // Stored by an earlier attempt (of this step: its usage is recorded here) or run: not generated again.
            log.info('podcast cover found in the store, not generated again', { key })
            for (const usage of usageToRecord(found.billed, key)) addUsage(usage)
            return json(found.file)
          }
          let file: StoredFile
          try {
            const reported: Usage[] = []
            const out = await deps.cover.call(request, {
              signal,
              addUsage: (usage) => {
                reported.push(usage)
                addUsage(usage)
              },
            })
            const b64 = out.images[0]?.b64
            if (!b64) throw new Error('the image capability returned no image')
            file = await storeCover(dir, hash, Uint8Array.from(Buffer.from(b64, 'base64')), {
              producedBy: key,
              usage: reported,
            })
          } catch (error) {
            return json(fallBack('cover', error, signal, null))
          }
          // Outside the fallback: a stored, billed cover is never dropped as a failed generation.
          await deps.onStored?.(file)
          return json(file)
        }),
      ),
    ])

    const failed = synthesized.findIndex((unit) => unit === null)
    if (failed >= 0)
      throw new WorkflowError('step_failed', `synth of unit ${failed} failed; its run record holds the error`)
    const units = synthesized as StoredUnit[]

    // 3. Master: per-host loudness, gapped concat, chapters per segment, loudnorm, ID3 with the cover, MP3.
    const mastered = await as<Mastered>(
      ctx.step('master', async () => {
        const pcm = await Promise.all(units.map((u) => readStored(u)))
        const levelled = await matchHostLoudness(
          units.map((u, i) => {
            const speakers = new Set((plan.units[i]?.turnIndexes ?? []).map((t) => plan.turns[t]?.speaker))
            const speaker = speakers.size === 1 ? ([...speakers][0] ?? 'AB') : 'AB'
            return { pcm: pcm[i] as Uint8Array, sampleRate: u.sampleRate, speaker }
          }),
          PRE_MASTER_HOST_LUFS,
        )
        log.info('podcast host loudness matched', { episode: input.episode.id, gainsDb: levelled.gainsDb })
        const mux = concatWithGaps(
          buildMuxTurns({
            synthOutputs: levelled.turns,
            turnTexts: plan.units.map((unit) => plan.turns[unit.turnIndexes[0] ?? 0]?.text ?? ''),
            gapMs: config.gapMs,
            shortGapMs: config.shortGapMs,
          }),
        )
        const unitOfTurn = new Map<number, number>()
        plan.units.forEach((unit, u) => {
          for (const t of unit.turnIndexes) unitOfTurn.set(t, u)
        })
        const chapters = chaptersFromSegments(input.script.segments, mux.turnStartsMs, (t) => unitOfTurn.get(t) ?? t)
        const mp3 = await masterPodcastMp3(mux.pcm, mux.sampleRate, {
          chapters,
          tags: {
            title: input.metadata.title,
            album: input.request.series,
            artist: config.author,
            albumArtist: config.author,
            comment: input.metadata.description,
            date: plan.date,
            genre: input.metadata.genres[0] ?? 'Podcast',
            language: input.request.language === 'de' ? 'deu' : 'eng',
            track: plan.track,
          },
          ...(cover ? { cover: await readStored(cover) } : {}),
          bitrateKbps: config.bitrateKbps,
        })
        return json({
          mp3: await store(join(dir, 'episode.mp3'), mp3),
          durationSeconds: Math.round(mux.totalMs / 1000),
          turns: plan.turns.length,
          chapters,
          gainsDb: levelled.gainsDb,
        } satisfies Mastered)
      }),
    )

    // 4. Publish: best-effort, an effect keyed (runId, 'publish'); a resume finds its own upload first.
    const published = await as<{ abs: AbsResult | null; publish: PublishResult }>(
      ctx.effect('publish', async (key, { signal }) => {
        if (!input.request.publish) return { abs: null, publish: { requested: false, ok: null, error: null } }
        return json(
          await publishEpisode({ input, config, deps, filename: plan.filename, mp3: mastered.mp3, cover, signal, key }),
        )
      }),
    )

    // 5. The Slack notice, only where legacy's env is set; best-effort.
    await ctx.effect('notify', async (_key, { signal }) => {
      if (!config.notify) return null
      try {
        const text = podcastDoneMessage({
          title: input.metadata.title,
          durationSeconds: mastered.durationSeconds,
          chapters: mastered.chapters.map((c) => c.title),
          absUrl: published.abs?.url ?? null,
          // The whole episode's spend, as legacy's job total: the room, this run and its units, the cover.
          costUsd: (await deps.journal.episodeCost(ctx.runId)).usd,
          publishRequested: input.request.publish,
          publishError:
            published.publish.ok === false && published.publish.error !== 'not configured'
              ? published.publish.error
              : null,
          format: input.profile.format,
          lead: input.profile.lead,
          humor: input.profile.humor,
          hostNames: [input.hosts[0].name, input.hosts[1].name],
        })
        return json(await notifyPodcastResult(config.notify, text, deps.notifyFetch))
      } catch (error) {
        return json(fallBack('notify', error, signal, { sent: false, error: messageOf(error) }))
      }
    })

    // 6. The brain note: best-effort, an effect keyed (runId, 'brain-note'); a resume never commits twice.
    const brainNote = await as<BrainNoteResult | null>(
      ctx.effect('brain-note', async (key) =>
        json(
          await fileBrainNote({
            input,
            config,
            deps,
            durationSeconds: mastered.durationSeconds,
            segmentation: plan.segmentation,
            absItemId: published.abs?.libraryItemId ?? null,
            key,
          }),
        ),
      ),
    )

    // 7. Cost: what the journal recorded on this run's steps (retries, failed attempts and resumes included).
    const cost = await as<{ usd: number; unpriced: number }>(
      ctx.step('cost', async () => json(await deps.journal.runCost(ctx.runId))),
    )
    return {
      mp3Path: mastered.mp3.path,
      coverPath: cover?.path ?? null,
      durationSeconds: mastered.durationSeconds,
      turns: mastered.turns,
      chapters: mastered.chapters,
      abs: published.abs,
      publish: published.publish,
      brainNote,
      segmentation: plan.segmentation,
      cost: { usd: Math.round(cost.usd * 1e6) / 1e6, unpriced: cost.unpriced, complete: cost.unpriced === 0 },
    }
  }

  const produce = defineWorkflow({
    id: 'podcast.produce',
    version: PRODUCE_VERSION,
    input: ProduceInput,
    output: ProduceOutput,
    // Legacy produced one episode at a time; synth and mastering are the heavy part.
    concurrency: 1,
    run,
  })
  return { produce, unit: unitWorkflow }
}

export const createProduceWorkflow = (deps: ProduceDeps) => createProduceWorkflows(deps).produce

/** A typed failure for a journal record that does not have the shape this version wrote. */
export function unreadable(what: string): WorkflowError {
  return new WorkflowError('invalid_input', `the journal's ${what} is unreadable by this version`)
}

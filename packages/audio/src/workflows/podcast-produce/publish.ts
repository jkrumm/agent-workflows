import { z } from 'zod'
import type { Ctx, Json, Logger } from '../../../../runtime/src/index.ts'
import { defineWorkflow, WorkflowError } from '../../../../runtime/src/index.ts'
import { ProduceInput } from '../podcast/produce-input.ts'
import { type ProduceConfig, produceConfigFromEnv } from './config.ts'
import type { StoredFile } from './files.ts'
import {
  type AbsResult,
  type BrainNoteResult,
  type EffectDeps,
  fileBrainNote,
  type Mastered,
  type Plan,
  type PublishResult,
  publishEpisode,
} from './index.ts'
import type { ProduceJournal } from './journal.ts'
import { setProduceLogger } from './log.ts'

// `podcast-publish <runId>`: legacy `POST /v1/podcasts/:id/publish`. Repeats only the upload of an episode already
// produced (its MP3 and cover are still in the artifact store), then files the brain note again with the
// Audiobookshelf link. The id is the `podcast` run (or its `podcast.produce` child). A public workflow of its own:
// `agw podcast publish` cannot exist, because `podcast` is a command and no command may be the prefix of another.

export const PUBLISH_VERSION = '2026-10-29.1'

export const PublishInput = z
  .object({ runId: z.string().min(1).describe('The podcast run (or its podcast.produce child) to publish') })
  .strict()

export const PublishOutput = z.object({
  /** The `podcast.produce` run whose episode was published. */
  produceRunId: z.string(),
  abs: z.object({ url: z.string(), libraryItemId: z.string(), episodeId: z.string().nullable() }).nullable(),
  publish: z.object({ requested: z.boolean(), ok: z.boolean().nullable(), error: z.string().nullable() }),
  brainNote: z.object({ path: z.string(), committed: z.boolean(), pushed: z.boolean() }).nullable(),
})

export interface PublishDeps extends EffectDeps {
  journal: ProduceJournal
  config?: Partial<ProduceConfig>
  logger?: Logger
}

/** What the `load` step journals: the produced episode as its run recorded it. */
interface Loaded {
  produceRunId: string
  input: z.output<typeof ProduceInput>
  plan: Pick<Plan, 'filename' | 'segmentation'>
  master: Pick<Mastered, 'mp3' | 'durationSeconds'>
  cover: StoredFile | null
}

const json = (value: unknown): Json => JSON.parse(JSON.stringify(value)) as Json

export function createPublishWorkflow(deps: PublishDeps) {
  const config: ProduceConfig = { ...produceConfigFromEnv(), ...deps.config }
  if (deps.logger) setProduceLogger(deps.logger)

  async function run(ctx: Ctx, { runId }: z.output<typeof PublishInput>) {
    const loaded = (await ctx.step('load', async () => {
      const produced = await deps.journal.producedRun(runId)
      if (!produced) throw new WorkflowError('invalid_input', `no finished podcast.produce run for "${runId}"`)
      const input = ProduceInput.safeParse(produced.input)
      const plan = produced.steps.plan as Loaded['plan'] | undefined
      const master = produced.steps.master as Loaded['master'] | undefined
      if (!input.success || !plan?.filename || !master?.mp3) {
        throw new WorkflowError('invalid_input', `podcast.produce run ${produced.id} has no episode this version reads`)
      }
      return json({
        produceRunId: produced.id,
        input: input.data,
        plan: { filename: plan.filename, segmentation: plan.segmentation ?? null },
        master: { mp3: master.mp3, durationSeconds: master.durationSeconds },
        cover: (produced.steps.cover as StoredFile | null | undefined) ?? null,
      } satisfies Loaded)
    })) as unknown as Loaded

    const published = (await ctx.effect('publish', async (key, { signal }) =>
      json(
        await publishEpisode({
          input: loaded.input,
          config,
          deps,
          filename: loaded.plan.filename,
          mp3: loaded.master.mp3,
          cover: loaded.cover,
          signal,
          key,
        }),
      ),
    )) as unknown as { abs: AbsResult | null; publish: PublishResult }

    // Legacy re-filed the note only after a successful upload: it gains the Audiobookshelf link the first run lacked.
    const brainNote = (await ctx.effect('brain-note', async (key) => {
      if (!published.abs) return null
      return json(
        await fileBrainNote({
          input: loaded.input,
          config,
          deps,
          durationSeconds: loaded.master.durationSeconds,
          segmentation: loaded.plan.segmentation,
          absItemId: published.abs.libraryItemId,
          key,
        }),
      )
    })) as unknown as BrainNoteResult | null

    return { produceRunId: loaded.produceRunId, abs: published.abs, publish: published.publish, brainNote }
  }

  return defineWorkflow({
    id: 'podcast-publish',
    version: PUBLISH_VERSION,
    input: PublishInput,
    output: PublishOutput,
    concurrency: 1,
    run,
  })
}

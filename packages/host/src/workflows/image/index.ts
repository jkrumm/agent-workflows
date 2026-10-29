import { join } from 'node:path'
import type { CallOptions } from '@agent-workflows/capabilities'
import { defineWorkflow, type Json, type StepScope } from '@agent-workflows/runtime'
import { type ArtifactOptions, artifactDir } from '../../artifacts.ts'
import type { HostWorkflow } from '../../operations.ts'
import { ImageInput, type ImageInputValue, ImageOutput, type ImageOutputValue } from './schema.ts'
import { imageScorer } from './scorer.ts'

export const IMAGE_VERSION = '2026-10-29.1'

/** What the workflow reads of a generated or cut-out image: the capability's output, bytes as base64. */
interface ImageResult {
  b64: string
  bytes: number
  width: number
  height: number
  hasAlpha: boolean
}
interface Priced {
  id: string
  model: string
  cost: { usd: number | null; source: 'provider' | 'rate' | 'unknown' }
  latencyMs: number
}
interface GenerateResult extends Priced {
  size: string
  snappedFrom?: string
  edit: boolean
  images: ImageResult[]
}
interface CutoutResult extends Priced {
  image: ImageResult
}

/** The two capabilities the workflow calls; any registry that has `image.generate` and `image.cutout` fits. */
export interface ImageCaller {
  call(
    id: 'image.generate',
    input: {
      prompt: string
      size: string
      n: number
      quality: ImageInputValue['quality']
      model: 'auto' | 'flare' | 'sunburst'
      background: ImageInputValue['background']
      images: string[]
    },
    options?: CallOptions,
  ): Promise<GenerateResult>
  call(
    id: 'image.cutout',
    input: { file: string; model: 'recraft' | 'bria' },
    options?: CallOptions,
  ): Promise<CutoutResult>
}

/** Writes `<dir>/<n>.png` for each image; the run's step journals paths and sizes, never the bytes. */
async function store(dir: string, images: ImageResult[]) {
  return Promise.all(
    images.map(async (image, index) => {
      const path = join(dir, `${index + 1}.png`)
      await Bun.write(path, Buffer.from(image.b64, 'base64'))
      return { path, bytes: image.bytes, width: image.width, height: image.height, hasAlpha: image.hasAlpha }
    }),
  )
}

/**
 * `image` (concept §11 P4a): generate or edit images from a prompt, or cut a background out of a file. Port of the agent
 * lane of the image stack (`imgcli gen`, `imgcli cutout`), minus image-gateway: the capabilities call IU's images endpoint
 * and Replicate directly. The PNGs go to the platform artifact store (`artifacts.ts`), the output lists their absolute
 * paths; every billed call reports its price on the step, so the run record carries the cost.
 */
export function createImageWorkflows(
  deps: { registry: ImageCaller },
  options: { artifacts?: ArtifactOptions } = {},
): HostWorkflow[] {
  const { registry } = deps

  const image = defineWorkflow({
    id: 'image',
    version: IMAGE_VERSION,
    input: ImageInput,
    output: ImageOutput,
    scorer: imageScorer,
    async run(ctx, input): Promise<ImageOutputValue> {
      const dir = () => artifactDir('image', ctx.runId, options.artifacts)
      if (input.file !== undefined) {
        const file = input.file
        const model = input.model === 'bria' ? 'bria' : 'recraft'
        return ImageOutput.parse(
          await ctx.step('cutout', async ({ addUsage, signal }: StepScope): Promise<Json> => {
            const out = await registry.call('image.cutout', { file, model }, { addUsage, signal })
            const files = await store(dir(), [out.image])
            return {
              kind: 'cutout',
              generationId: out.id,
              model: out.model,
              dir: dir(),
              files,
              cost: out.cost,
              latencyMs: out.latencyMs,
            }
          }),
        )
      }
      const prompt = input.prompt ?? ''
      const model = input.model === 'flare' || input.model === 'sunburst' ? input.model : 'auto'
      return ImageOutput.parse(
        await ctx.step('generate', async ({ addUsage, signal }: StepScope): Promise<Json> => {
          const out = await registry.call(
            'image.generate',
            {
              prompt,
              size: input.size,
              n: input.n,
              quality: input.quality,
              model,
              background: input.background,
              images: input.images,
            },
            { addUsage, signal },
          )
          const files = await store(dir(), out.images)
          return {
            kind: out.edit ? 'edit' : 'generate',
            generationId: out.id,
            model: out.model,
            size: out.size,
            ...(out.snappedFrom ? { snappedFrom: out.snappedFrom } : {}),
            dir: dir(),
            files,
            cost: out.cost,
            latencyMs: out.latencyMs,
          }
        }),
      )
    },
  })

  return [
    {
      workflow: image,
      summary:
        'Generate or edit images from a prompt (--images for an edit), or cut a background out of --file; the PNGs land in the artifact store and the output lists their paths',
      cli: { positional: ['prompt'], defaultFormat: 'json' },
    },
  ]
}

import { join } from 'node:path'
import type { EnhanceOutput } from '@agent-workflows/capabilities'
import { defineWorkflow, type Json, type StepScope, WorkflowError } from '@agent-workflows/runtime'
import { type ArtifactOptions, artifactDir } from '../../artifacts.ts'
import type { HostWorkflow } from '../../operations.ts'
import type { HostRegistry } from '../index.ts'
import { ImageInput, type ImageInputValue, ImageOutput, type ImageOutputValue } from './schema.ts'
import { imageScorer } from './scorer.ts'

export const IMAGE_VERSION = '2026-10-29.1'

/** The registry the workflow calls: the host's, typed by the image capabilities it holds. */
export type ImageCaller = Pick<HostRegistry, 'call'>

/** A generated or cut-out image as a capability answers it, bytes as base64. */
interface ImageResult {
  b64: string
  bytes: number
  width: number
  height: number
  hasAlpha: boolean
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
              params: { model: out.model, n: 1 },
              dir: dir(),
              files,
              cost: out.cost,
              latencyMs: out.latencyMs,
            }
          }),
        )
      }

      // --enhance: the planner turns the brief into a playbook prompt and derives settings; a setting the caller gave wins,
      // and a hard policy warning is a wall the generation would hit, so the run stops before spending on it.
      let prompt = input.prompt ?? ''
      let plan: EnhanceOutput | undefined
      if (input.enhance) {
        plan = await ctx.step('enhance', ({ addUsage, signal }: StepScope) =>
          registry.call(
            'image.enhance',
            { brief: prompt, hasReferences: input.images.length > 0 },
            { addUsage, signal },
          ),
        )
        const hard = plan.warnings.filter((w) => w.severity === 'hard')
        if (hard.length)
          throw new WorkflowError(
            'invalid_input',
            `plan refused (hard policy wall): ${hard.map((w) => w.message).join('; ')}`,
          )
        prompt = plan.prompt
      }
      const request = {
        prompt,
        size: input.size ?? plan?.settings.size ?? 'auto',
        n: input.n ?? plan?.settings.n ?? 1,
        quality: input.quality ?? plan?.settings.quality ?? 'auto',
        model: input.model === 'flare' || input.model === 'sunburst' ? input.model : ('auto' as const),
        // The planner writes its prompt to match its background: dropping the background while sending that prompt paints a checkerboard.
        background: input.background ?? plan?.settings.background ?? 'auto',
        images: input.images,
      }
      const planned = plan && {
        prompt: plan.prompt,
        intent: plan.intent.detected,
        assumptions: plan.assumptions,
        warnings: plan.warnings,
        estimatedCostUsd: plan.estimatedCost?.totalUsd ?? null,
        playbookVersion: plan.playbookVersion,
        enhanceModel: plan.enhanceModel,
      }
      return ImageOutput.parse(
        await ctx.step('generate', async ({ addUsage, signal }: StepScope): Promise<Json> => {
          const out = await registry.call('image.generate', request, { addUsage, signal })
          const files = await store(dir(), out.images)
          return {
            kind: out.edit ? 'edit' : 'generate',
            generationId: out.id,
            model: out.model,
            params: { model: out.model, size: out.size, quality: request.quality, n: request.n },
            size: out.size,
            ...(out.snappedFrom ? { snappedFrom: out.snappedFrom } : {}),
            dir: dir(),
            files,
            ...(out.rejected.length ? { rejected: out.rejected } : {}),
            ...(planned ? { plan: planned } : {}),
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
        'Generate or edit images from a prompt (--images for an edit, --enhance to plan it first), or cut a background out of --file; the PNGs land in the artifact store and the output lists their paths',
      cli: { positional: ['prompt'], defaultFormat: 'json' },
    },
  ]
}

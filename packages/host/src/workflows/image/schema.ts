import { CUTOUT_MODELS, GENERATE_MODELS, MAX_EDIT_IMAGES, QUALITIES } from '@agent-workflows/capabilities'
import { z } from 'zod'

/**
 * One command for both jobs, told apart by what it is given: a `prompt` generates (with `images` it edits those
 * images), a `file` cuts its background out. Exactly one of the two. The generation settings have no default here: an
 * unset one is the planner's to derive under `--enhance`, else `auto` (size, quality, background) or 1 (n).
 */
export const ImageInput = z
  .object({
    prompt: z
      .string()
      .min(1)
      .max(32_000)
      .optional()
      .describe('Generate: what to draw, or with --images what to change'),
    file: z
      .string()
      .min(1)
      .optional()
      .describe('Cutout: absolute path of the image on this host (png, jpeg, webp; 5 MB, sides 256-4096 px)'),
    size: z
      .string()
      .regex(/^(auto|\d{2,4}x\d{2,4})$/, "size must be 'auto' or 'WxH'")
      .optional()
      .describe(
        "Generate: 'auto' (default), a preset (1024x1024, 1536x1024, 1024x1536) or WxH; a WxH the endpoint refuses is snapped into its envelope",
      ),
    n: z.int().min(1).max(10).optional().describe('Generate: images to make, 1-10 (default 1)'),
    quality: z
      .enum(QUALITIES)
      .optional()
      .describe('Generate: low is about a tenth of the price of high (default auto)'),
    model: z
      .enum(['auto', ...GENERATE_MODELS, ...CUTOUT_MODELS])
      .optional()
      .describe(
        'Generate: flare (fast drafts) or sunburst (final renders and edits); auto (default) picks sunburst for high+ quality and edits. Cutout: recraft ($0.01, keeps resolution, default) or bria ($0.018, may downscale)',
      ),
    background: z
      .enum(['transparent', 'opaque', 'auto'])
      .optional()
      .describe('Generate: transparent returns a PNG with an alpha channel, an icon source (default auto)'),
    images: z
      .array(z.string().min(1))
      .max(MAX_EDIT_IMAGES)
      .default([])
      .describe(
        'Generate: absolute paths of reference images on this host (png, jpeg, webp), the call is an edit: --images \'["/abs/photo.jpg"]\'',
      ),
    enhance: z
      .boolean()
      .optional()
      .describe(
        'Generate: run the prompt through the planner first (playbook prompt, derived settings, policy check); settings you give win over its. A hard policy warning refuses the run',
      ),
  })
  .strict()
  .superRefine((input, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message })
    if ((input.prompt === undefined) === (input.file === undefined)) {
      issue(
        input.prompt === undefined ? 'prompt' : 'file',
        'give a prompt to generate or a --file to cut out, not both and not neither',
      )
      return
    }
    if (input.file !== undefined) {
      if (input.model === 'flare' || input.model === 'sunburst')
        issue('model', 'a cutout takes --model recraft or bria')
      if (input.images.length) issue('images', 'a cutout takes no --images')
      if (input.enhance) issue('enhance', 'a cutout has no prompt to enhance')
    } else if (input.model === 'recraft' || input.model === 'bria') {
      issue('model', 'generate takes --model flare or sunburst (or auto); recraft and bria are cutout models')
    }
  })
export type ImageInputValue = z.output<typeof ImageInput>

export const ImageFile = z.object({
  path: z.string().describe('Absolute path of the PNG in the artifact store'),
  bytes: z.int().nonnegative(),
  width: z.int().positive(),
  height: z.int().positive(),
  hasAlpha: z.boolean().describe('The PNG has an alpha channel'),
})
export type ImageFileValue = z.output<typeof ImageFile>

export const ImageOutput = z.object({
  kind: z.enum(['generate', 'edit', 'cutout']),
  generationId: z.string(),
  model: z.string(),
  params: z
    .object({
      model: z.string(),
      size: z.string().optional().describe('Generate: the size requested after snapping'),
      quality: z.string().optional(),
      n: z.int().positive(),
    })
    .describe('The request parameters that were sent: what two arms of an eval compare'),
  size: z.string().optional().describe('Generate: the size requested after snapping'),
  snappedFrom: z.string().optional().describe('Generate: the size asked for, when it had to be snapped'),
  dir: z.string().describe('The run directory in the artifact store; swept 30 days after its last change'),
  files: z.array(ImageFile),
  rejected: z
    .array(z.object({ index: z.int().nonnegative(), reason: z.string() }))
    .optional()
    .describe('Generate: entries of the answer that were not a valid PNG (billed, not written)'),
  plan: z
    .object({
      prompt: z.string(),
      intent: z.string(),
      assumptions: z.array(z.string()),
      warnings: z.array(z.object({ code: z.string(), severity: z.string(), message: z.string() })),
      estimatedCostUsd: z.number().nullable(),
      playbookVersion: z.string(),
      enhanceModel: z.string(),
    })
    .optional()
    .describe('--enhance: what the planner made of the prompt'),
  cost: z.object({ usd: z.number().nonnegative().nullable(), source: z.enum(['provider', 'rate', 'unknown']) }),
  latencyMs: z.int().nonnegative(),
})
export type ImageOutputValue = z.output<typeof ImageOutput>

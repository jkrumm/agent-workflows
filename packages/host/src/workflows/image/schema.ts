import { z } from 'zod'

export const GENERATE_MODELS = ['flare', 'sunburst'] as const
export const CUTOUT_MODELS = ['recraft', 'bria'] as const
export const QUALITIES = ['low', 'medium', 'high', 'xhigh', 'max', 'auto'] as const

export const MAX_REFERENCE_IMAGES = 16

/**
 * One command for both jobs, told apart by what it is given: a `prompt` generates (with `images` it edits those
 * images), a `file` cuts its background out. Exactly one of the two.
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
      .default('auto')
      .describe(
        "Generate: 'auto', a preset (1024x1024, 1536x1024, 1024x1536) or WxH; a WxH the endpoint refuses is snapped into its envelope",
      ),
    n: z.int().min(1).max(10).default(1).describe('Generate: images to make, 1-10'),
    quality: z.enum(QUALITIES).default('auto').describe('Generate: low is about a tenth of the price of high'),
    model: z
      .enum(['auto', ...GENERATE_MODELS, ...CUTOUT_MODELS])
      .default('auto')
      .describe(
        'Generate: flare (fast drafts) or sunburst (final renders and edits); auto picks sunburst for high+ quality and edits. Cutout: recraft ($0.01, keeps resolution) or bria ($0.018, may downscale)',
      ),
    background: z
      .enum(['transparent', 'opaque', 'auto'])
      .default('auto')
      .describe('Generate: transparent returns a PNG with an alpha channel (an icon source)'),
    images: z
      .array(z.string().min(1))
      .max(MAX_REFERENCE_IMAGES)
      .default([])
      .describe(
        'Generate: absolute paths of reference images on this host (png, jpeg, webp), the call is an edit: --images \'["/abs/photo.jpg"]\'',
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
  size: z.string().optional().describe('Generate: the size requested after snapping'),
  snappedFrom: z.string().optional().describe('Generate: the size asked for, when it had to be snapped'),
  dir: z.string().describe('The run directory in the artifact store; swept 30 days after its last change'),
  files: z.array(ImageFile),
  cost: z.object({ usd: z.number().nonnegative().nullable(), source: z.enum(['provider', 'rate', 'unknown']) }),
  latencyMs: z.int().nonnegative(),
})
export type ImageOutputValue = z.output<typeof ImageOutput>

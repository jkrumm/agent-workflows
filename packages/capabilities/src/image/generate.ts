import { z } from 'zod'
import { fail } from '../errors.ts'
import { defineCapability } from '../procedure.ts'
import type { ResolvedImageDeps } from './deps.ts'
import { MAX_EDIT_IMAGE_BYTES, MAX_EDIT_IMAGES, readInputImage } from './files.ts'
import { MIME, magicBytesValid, readPng } from './png.ts'
import { snapSize } from './size.ts'
import { GENERATE_MODELS, MODELS, pickRoute, QUALITIES, requestImages } from './studio.ts'

export { GENERATE_MODELS, MODELS, pickRoute, QUALITIES }

export const generateInput = z.object({
  prompt: z.string().min(1).max(32_000).describe('What to draw, or with images, what to change'),
  size: z
    .string()
    .regex(/^(auto|\d{2,4}x\d{2,4})$/, "size must be 'auto' or 'WxH'")
    .default('auto')
    .describe(
      "'auto', a preset (1024x1024, 1536x1024, 1024x1536) or WxH; a WxH outside the endpoint's envelope is snapped into it",
    ),
  n: z.int().min(1).max(10).default(1).describe('Images to generate, 1-10'),
  quality: z
    .enum(QUALITIES)
    .default('auto')
    .describe('low is about a tenth of the price of high; xhigh and max cost far more'),
  model: z
    .enum(MODELS)
    .default('auto')
    .describe(
      'flare: fast, for drafts. sunburst: slower, for final renders and edits. auto: sunburst for high, xhigh, max and every edit, else flare',
    ),
  background: z
    .enum(['transparent', 'opaque', 'auto'])
    .default('auto')
    .describe('transparent returns a PNG with an alpha channel; the prompt must not ask for a checkerboard'),
  images: z
    .array(z.string().min(1))
    .max(MAX_EDIT_IMAGES)
    .default([])
    .describe(
      'Absolute paths of reference images on this host (png, jpeg, webp; 50 MB each, at most 16): the call becomes an edit',
    ),
})

const image = z.object({
  b64: z.string().describe('The PNG, base64'),
  bytes: z.int().nonnegative(),
  width: z.int().positive(),
  height: z.int().positive(),
  hasAlpha: z.boolean().describe('The PNG has an alpha channel (not that a pixel is transparent)'),
})
export type GeneratedImage = z.infer<typeof image>

export const generateOutput = z.object({
  id: z.string().describe('The generation id'),
  model: z.string(),
  size: z.string().describe('The size requested after snapping; each image carries the size it came back as'),
  snappedFrom: z.string().optional().describe('The size asked for, when it was snapped'),
  quality: z.string(),
  background: z.string(),
  edit: z.boolean(),
  images: z.array(image).describe('The images that came back valid, in order'),
  rejected: z
    .array(z.object({ index: z.int().nonnegative(), reason: z.string() }))
    .describe('Entries of the answer that were not a valid png: billed, not returned'),
  cost: z.object({ usd: z.number().nonnegative().nullable(), source: z.enum(['provider', 'rate', 'unknown']) }),
  latencyMs: z.int().nonnegative(),
})
export type GenerateOutput = z.infer<typeof generateOutput>

export function createGenerate(deps: ResolvedImageDeps) {
  return defineCapability({
    id: 'image.generate',
    summary: 'Generate images from a prompt, or edit reference images; returns the PNGs and what the call cost',
    input: generateInput,
    output: generateOutput,
    // Hidden from the CLI: a result that is megabytes of base64 is for workflows (`agw image`), not a terminal.
    // The workflow is the command `agw image`, and the host refuses a command that is the prefix of another: the capabilities'
    // commands are single hyphenated words.
    cli: { command: ['image-generate'], hidden: true, defaultFormat: 'json' },
    async handler(input, ctx) {
      const size = snapSize(input.size)
      const references = await Promise.all(input.images.map((path) => readInputImage(path, MAX_EDIT_IMAGE_BYTES)))
      const answer = await requestImages(deps, ctx, {
        prompt: input.prompt,
        size,
        n: input.n,
        quality: input.quality,
        model: input.model,
        background: input.background,
        output_format: 'png',
        references: references.map((ref) => ({
          bytes: ref.bytes,
          name: ref.path.slice(ref.path.lastIndexOf('/') + 1),
          mime: MIME[ref.format],
        })),
      })

      // The images are PNGs by their magic bytes; `generate` also needs their header (size, alpha), and an entry without a
      // readable one is rejected like any other bad entry.
      const images: GeneratedImage[] = []
      const rejected = [...answer.rejected]
      for (const entry of answer.images) {
        const bytes = Buffer.from(entry.b64, 'base64')
        const info = magicBytesValid(bytes, 'png') ? readPng(bytes) : null
        if (info) images.push({ b64: entry.b64, bytes: bytes.length, ...info })
        else rejected.push({ index: entry.index, reason: 'not a valid png (bad magic bytes)' })
      }
      rejected.sort((a, b) => a.index - b.index)
      if (images.length === 0) {
        throw fail(
          'UPSTREAM_ERROR',
          `image returned no valid png: ${rejected.map((r) => `#${r.index + 1} ${r.reason}`).join('; ')}`,
          {},
        )
      }
      return {
        id: answer.id,
        model: answer.model,
        size,
        ...(size !== input.size ? { snappedFrom: input.size } : {}),
        quality: input.quality,
        background: input.background,
        edit: answer.edit,
        images,
        rejected,
        cost: answer.cost,
        latencyMs: answer.latencyMs,
      }
    },
  })
}

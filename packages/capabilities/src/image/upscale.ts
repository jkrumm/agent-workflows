import { z } from 'zod'
import { fail } from '../errors.ts'
import { defineCapability } from '../procedure.ts'
import { cutoutOutput } from './cutout.ts'
import type { ImageRouteId, ResolvedImageDeps } from './deps.ts'
import { readInputImage } from './files.ts'
import { displayedSize, readHeader } from './header.ts'
import { MIME } from './png.ts'
import { deliveredPng, replicateAccess, runPrediction } from './replicate.ts'

/** What real-esrgan is sent: a source past these is refused before any request (image-gateway's upscale limits). */
export const UPSCALE_LIMITS = {
  maxImageBytes: 10 * 1024 * 1024,
  maxEdge: 1440,
  maxPixels: 16_000_000,
  /** The most a delivery may claim; also the bound `Bun.Image` decodes under. */
  maxOutputPixels: 64_000_000,
} as const

const upscaleInput = z.object({
  file: z
    .string()
    .min(1)
    .describe('Absolute path of the image on this host (png, jpeg, webp; 10 MB, long edge up to 1440 px, 16 MP)'),
  scale: z.int().min(2).max(8).default(4).describe('Upscale factor, 2 to 8'),
})

// The same shape as a cutout: one PNG and what the call cost.
const upscaleOutput = cutoutOutput
export type UpscaleOutput = z.infer<typeof upscaleOutput>

/** An upscale is one image: a delivery over this is not one. */
const MAX_DELIVERY_BYTES = 64 * 1024 * 1024

export function createUpscale(deps: ResolvedImageDeps) {
  return defineCapability({
    id: 'image.upscale',
    summary:
      'Upscale an image with real-esrgan (Replicate); the alpha channel is kept; returns a PNG and what the call cost',
    input: upscaleInput,
    output: upscaleOutput,
    // Hidden from the CLI like `image.cutout`: the result is megabytes of base64, for workflows.
    cli: { command: ['image-upscale'], hidden: true, defaultFormat: 'json' },
    async handler(input, ctx) {
      const route = deps.route('image.upscale' satisfies ImageRouteId)
      const access = replicateAccess(deps)
      const source = await readInputImage(input.file, UPSCALE_LIMITS.maxImageBytes)
      // Checked on the header: nothing is decoded for a size a crafted header can inflate.
      const header = readHeader(source.bytes)
      if (!header) throw fail('INVALID_INPUT', `unreadable image: ${input.file}`)
      const { width, height } = displayedSize(header)
      if (Math.max(width, height) > UPSCALE_LIMITS.maxEdge) {
        throw fail(
          'INVALID_INPUT',
          `image long edge must be at most ${UPSCALE_LIMITS.maxEdge}px for upscale, got ${width}x${height}`,
        )
      }
      if (width * height > UPSCALE_LIMITS.maxPixels) {
        throw fail(
          'INVALID_INPUT',
          `image must be at most ${UPSCALE_LIMITS.maxPixels} pixels for upscale, got ${width}x${height}`,
        )
      }
      // A result past the output bound would be refused after the call was billed, so it is refused before.
      if (width * height * input.scale ** 2 > UPSCALE_LIMITS.maxOutputPixels) {
        throw fail(
          'INVALID_INPUT',
          `a ${width}x${height} image upscaled ${input.scale}x is over ${UPSCALE_LIMITS.maxOutputPixels} pixels`,
        )
      }
      const started = performance.now()
      const { bytes, cost } = await runPrediction(deps, ctx, {
        route,
        access,
        input: {
          image: `data:${MIME[source.format]};base64,${Buffer.from(source.bytes).toString('base64')}`,
          scale: input.scale,
          face_enhance: false,
        },
        maxDeliveryBytes: MAX_DELIVERY_BYTES,
      })
      // real-esrgan delivers PNG (alpha kept); a WebP is converted, so every caller gets the PNG promised.
      const { png: out, info } = await deliveredPng(bytes, UPSCALE_LIMITS.maxOutputPixels)
      return {
        id: crypto.randomUUID(),
        model: route.model,
        image: { b64: Buffer.from(out).toString('base64'), bytes: out.length, ...info },
        cost,
        latencyMs: Math.round(performance.now() - started),
      }
    },
  })
}

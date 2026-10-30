import { z } from 'zod'
import { fail } from '../errors.ts'
import { defineCapability } from '../procedure.ts'
import type { ImageRouteId, ResolvedImageDeps } from './deps.ts'
import { readInputImage } from './files.ts'
import { displayedSize, readHeader } from './header.ts'
import { MIME } from './png.ts'
import { deliveredPng, replicateAccess, runPrediction } from './replicate.ts'

/**
 * recraft's documented input limits (image-gateway `CUTOUT_LIMITS`), enforced for both models so the contract is uniform.
 * `maxImageBytes` bounds the file sent (the source as it is, or its re-encode after an EXIF rotation); the pixel and edge
 * limits are checked on the header before anything decodes.
 */
export const CUTOUT_LIMITS = {
  maxImageBytes: 5 * 1024 * 1024,
  maxPixels: 16_000_000,
  minEdge: 256,
  maxEdge: 4096,
} as const

export const CUTOUT_MODELS = ['recraft', 'bria'] as const

export const cutoutInput = z.object({
  file: z
    .string()
    .min(1)
    .describe('Absolute path of the image on this host (png, jpeg, webp; 5 MB, sides 256-4096 px, 16 MP)'),
  model: z
    .enum(CUTOUT_MODELS)
    .default('recraft')
    .describe('recraft: $0.01, keeps the resolution. bria: $0.018, may downscale to 1024 px'),
})

export const cutoutOutput = z.object({
  id: z.string(),
  model: z.string(),
  image: z.object({
    b64: z.string().describe('The RGBA PNG, base64'),
    bytes: z.int().nonnegative(),
    width: z.int().positive(),
    height: z.int().positive(),
    hasAlpha: z.boolean(),
  }),
  cost: z.object({ usd: z.number().nonnegative().nullable(), source: z.enum(['provider', 'rate', 'unknown']) }),
  latencyMs: z.int().nonnegative(),
})
export type CutoutOutput = z.infer<typeof cutoutOutput>

/** A cutout is one image: a delivery over this is not one. */
const MAX_DELIVERY_BYTES = 64 * 1024 * 1024
/** recraft keeps the input's pixels and bria shrinks them, so an output past twice the input limit is not a cutout. */
const MAX_DELIVERY_PIXELS = 2 * CUTOUT_LIMITS.maxPixels

/**
 * What is sent to the cutout model: the file as it is, after recraft's limits are checked on its header (nothing is
 * decoded for a size a crafted header can inflate). Only a JPEG with an EXIF rotation is re-encoded (as a JPEG, size-capped
 * and pixel-capped), so the model sees the picture upright; the limit on bytes applies to what is sent.
 */
export async function prepareInput(
  source: { bytes: Uint8Array; format: 'png' | 'jpeg' | 'webp' },
  path: string,
  purpose = 'cutout',
) {
  const header = readHeader(source.bytes)
  if (!header) throw fail('INVALID_INPUT', `unreadable image: ${path}`)
  const { width, height } = displayedSize(header)
  if (Math.min(width, height) < CUTOUT_LIMITS.minEdge) {
    throw fail(
      'INVALID_INPUT',
      `image sides must be at least ${CUTOUT_LIMITS.minEdge}px for ${purpose}, got ${width}x${height}`,
    )
  }
  if (Math.max(width, height) > CUTOUT_LIMITS.maxEdge) {
    throw fail(
      'INVALID_INPUT',
      `image sides must be at most ${CUTOUT_LIMITS.maxEdge}px for ${purpose}, got ${width}x${height}`,
    )
  }
  if (width * height > CUTOUT_LIMITS.maxPixels) {
    throw fail(
      'INVALID_INPUT',
      `image must be at most ${CUTOUT_LIMITS.maxPixels} pixels for ${purpose}, got ${width}x${height}`,
    )
  }
  if (header.orientation === 1) return { bytes: source.bytes, mime: MIME[source.format] }
  let upright: Uint8Array
  try {
    upright = await new Bun.Image(source.bytes, { maxPixels: CUTOUT_LIMITS.maxPixels }).jpeg({ quality: 95 }).bytes()
  } catch (error) {
    throw fail('INVALID_INPUT', `unreadable image: ${path} (${error instanceof Error ? error.message : String(error)})`)
  }
  if (upright.byteLength > CUTOUT_LIMITS.maxImageBytes) {
    throw fail(
      'INVALID_INPUT',
      `image is ${upright.byteLength} bytes after its EXIF rotation was applied, over the ${CUTOUT_LIMITS.maxImageBytes} byte limit for ${purpose}`,
    )
  }
  return { bytes: upright, mime: MIME.jpeg }
}

export function createCutout(deps: ResolvedImageDeps) {
  return defineCapability({
    id: 'image.cutout',
    summary: 'Remove the background of an image (Replicate); returns an RGBA PNG and what the call cost',
    input: cutoutInput,
    output: cutoutOutput,
    // Hidden from the CLI: a result that is megabytes of base64 is for workflows (`agw image --file`), not a terminal.
    // The workflow is the command `agw image`, and the host refuses a command that is the prefix of another: the capabilities'
    // commands are single hyphenated words.
    cli: { command: ['image-cutout'], hidden: true, defaultFormat: 'json' },
    async handler(input, ctx) {
      const route = deps.route(`image.cutout.${input.model}` satisfies ImageRouteId)
      const access = replicateAccess(deps)
      const source = await readInputImage(input.file, CUTOUT_LIMITS.maxImageBytes)
      const sent = await prepareInput(source, input.file)
      const started = performance.now()
      const { bytes, cost } = await runPrediction(deps, ctx, {
        route,
        access,
        input: { image: `data:${sent.mime};base64,${Buffer.from(sent.bytes).toString('base64')}` },
        maxDeliveryBytes: MAX_DELIVERY_BYTES,
      })
      // recraft delivers RGBA WebP, bria PNG: every caller gets the PNG this capability promises.
      const { png: out, info } = await deliveredPng(bytes, MAX_DELIVERY_PIXELS)
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

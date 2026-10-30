import { CUTOUT_MODELS } from '@agent-workflows/capabilities'
import { isAbsolute } from 'node:path'
import { z } from 'zod'

/** The largest master image accepted (image-gateway `ICONS_LIMITS.maxImageBytes`). */
export const MAX_SOURCE_BYTES = 20 * 1024 * 1024

export const ImageIconInput = z
  .object({
    file: z
      .string()
      .min(1)
      .refine(isAbsolute, 'file must be an absolute path')
      .describe('Absolute path of the master image on this host (png, jpeg, webp; at most 20 MiB)'),
    background: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, 'background must be a #rrggbb hex color')
      .default('#ffffff')
      .describe(
        'Fill (#rrggbb) for the opaque targets only: apple-touch-icon, icon-mask and icon-1024 (default #ffffff)',
      ),
    cutout: z
      .enum(['auto', 'always', 'never'])
      .default('auto')
      .describe(
        'Background removal: auto cuts out only when the image has no real transparency (default), always, or never',
      ),
    cutoutModel: z
      .enum(CUTOUT_MODELS)
      .default('recraft')
      .describe('Cutout model: recraft ($0.01, default) or bria ($0.018)'),
    upscale: z
      .enum(['auto', 'always', 'never'])
      .default('auto')
      .describe(
        'Upscaling with real-esrgan ($0.002): auto runs when the long edge is under 512 px, 4x or 8x under 128 px (default); always accepts at most 1440 px; or never',
      ),
    svg: z
      .enum(['auto', 'never'])
      .default('auto')
      .describe(
        'favicon.svg through recraft-vectorize ($0.01): auto (default) or never. The SVG is left out when the optimized file is over 64 KB',
      ),
  })
  .strict()
export type ImageIconInputValue = z.output<typeof ImageIconInput>

const Cost = z.object({ usd: z.number().nonnegative().nullable(), source: z.enum(['provider', 'rate', 'unknown']) })

const IconFile = z.object({
  name: z.string(),
  path: z.string().describe('Absolute path in the artifact store'),
  mime: z.string(),
  width: z.int().nonnegative().describe('0 for favicon.svg: an SVG has no pixel size'),
  height: z.int().nonnegative(),
  bytes: z.int().nonnegative(),
})
export type IconFileValue = z.output<typeof IconFile>

export const ImageIconOutput = z.object({
  dir: z.string().describe('The run directory in the artifact store; swept 30 days after its last change'),
  workDir: z.string().describe('The intermediate images of the run (source, upscaled, cutout, master)'),
  files: z
    .array(IconFile)
    .describe(
      'favicon.ico, favicon.svg (when made), icon-192, icon-512, icon-mask, apple-touch-icon, icon-1024, AppIcon.icns',
    ),
  html: z.string().describe('The <link> tags for the head'),
  htmlPath: z.string(),
  manifest: z.object({
    icons: z.array(z.object({ src: z.string(), sizes: z.string(), type: z.string(), purpose: z.string().optional() })),
  }),
  manifestPath: z.string(),
  steps: z
    .array(
      z.object({
        step: z.enum(['upscale', 'cutout', 'vectorize']),
        model: z.string(),
        costUsd: z.number().nonnegative().nullable(),
        latencyMs: z.int().nonnegative(),
      }),
    )
    .describe('The model steps that ran, in pipeline order'),
  svgSkippedReason: z.string().optional().describe('Why favicon.svg is not in the set'),
  cost: Cost.describe('The sum of the steps that ran; $0 when none did'),
  latencyMs: z.int().nonnegative(),
})
export type ImageIconOutputValue = z.output<typeof ImageIconOutput>

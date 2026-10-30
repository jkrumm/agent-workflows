import { z } from 'zod'
import { fail } from '../errors.ts'
import { defineCapability } from '../procedure.ts'
import { CUTOUT_LIMITS, cutoutOutput, prepareInput } from './cutout.ts'
import type { ImageRouteId, ResolvedImageDeps } from './deps.ts'
import { readInputImage } from './files.ts'
import { replicateAccess, runPrediction } from './replicate.ts'

const vectorizeInput = z.object({
  file: z
    .string()
    .min(1)
    .describe('Absolute path of the image on this host (png, jpeg, webp; 5 MB, sides 256-4096 px, 16 MP)'),
})

const vectorizeOutput = z.object({
  id: z.string(),
  model: z.string(),
  svg: z.string().describe('The SVG document as the model delivered it (not sanitized or optimized)'),
  bytes: z.int().nonnegative().describe('Size of the SVG in bytes'),
  cost: cutoutOutput.shape.cost,
  latencyMs: cutoutOutput.shape.latencyMs,
})
export type VectorizeOutput = z.infer<typeof vectorizeOutput>

/** An SVG document is text: a delivery over this is not a favicon-sized vectorization. */
const MAX_DELIVERY_BYTES = 8 * 1024 * 1024

/** After an optional BOM, whitespace and XML prolog, the document must open with `<svg`. */
const SVG_START = /^﻿?\s*(?:<\?xml[\s\S]*?\?>\s*)?<svg[\s>]/

export function createVectorize(deps: ResolvedImageDeps) {
  return defineCapability({
    id: 'image.vectorize',
    summary: 'Vectorize an image with recraft (Replicate); returns the SVG document and what the call cost',
    input: vectorizeInput,
    output: vectorizeOutput,
    // Hidden from the CLI like `image.cutout`: it is a model step for workflows (`agw image`).
    cli: { command: ['image-vectorize'], hidden: true, defaultFormat: 'json' },
    async handler(input, ctx) {
      const route = deps.route('image.vectorize' satisfies ImageRouteId)
      const access = replicateAccess(deps)
      const source = await readInputImage(input.file, CUTOUT_LIMITS.maxImageBytes)
      const sent = await prepareInput(source, input.file, 'vectorize')
      const started = performance.now()
      const { bytes, cost } = await runPrediction(deps, ctx, {
        route,
        access,
        input: { image: `data:${sent.mime};base64,${Buffer.from(sent.bytes).toString('base64')}` },
        maxDeliveryBytes: MAX_DELIVERY_BYTES,
      })
      const notSvg = () => fail('UPSTREAM_ERROR', 'replicate vectorize output is not an SVG', {})
      let svg: string
      try {
        svg = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      } catch {
        throw notSvg()
      }
      if (!SVG_START.test(svg)) throw notSvg()
      return {
        id: crypto.randomUUID(),
        model: route.model,
        svg,
        bytes: bytes.length,
        cost,
        latencyMs: Math.round(performance.now() - started),
      }
    },
  })
}

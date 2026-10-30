import type { LlmDeps } from '../llm/model-call.ts'
import { iuTransports } from '../transports/index.ts'
import { createCutout } from './cutout.ts'
import { type ImageDeps, resolveImageDeps } from './deps.ts'
import { createEnhance } from './enhance.ts'
import { createGenerate } from './generate.ts'
import { createUpscale } from './upscale.ts'
import { createVectorize } from './vectorize.ts'

export { CUTOUT_LIMITS, CUTOUT_MODELS } from './cutout.ts'
export type { CutoutOutput } from './cutout.ts'
export type { ImageDeps } from './deps.ts'
export type { EnhanceOutput } from './enhance.ts'
export { MAX_EDIT_IMAGES } from './files.ts'
export type { GenerateOutput, GeneratedImage } from './generate.ts'
export { GENERATE_MODELS, pickRoute, QUALITIES } from './generate.ts'
export {
  type ImageFile,
  type ImagePartial,
  type ImageRequest,
  type ImageResult,
  type ImageResultImage,
  type ImageUsage,
  INPUT_FIDELITIES,
  MAX_MASK_BYTES,
  MAX_PARTIAL_IMAGES,
  MODEL_CAPABILITIES,
  MODERATIONS,
  OUTPUT_FORMATS,
  requestImages,
} from './studio.ts'
export { type AlphaStats, decodeAlphaStats, magicBytesValid, readPng } from './png.ts'
export { replicateBase } from './replicate.ts'
export { snapSize, validateSize } from './size.ts'
export type { UpscaleOutput } from './upscale.ts'
export { UPSCALE_LIMITS } from './upscale.ts'
export type { VectorizeOutput } from './vectorize.ts'

/**
 * The image capabilities: `image.generate` (a prompt, or with reference images an edit), the Replicate model steps
 * `image.cutout`, `image.upscale` and `image.vectorize`, and `image.enhance` (the planner, on the text wire). All but
 * enhance are hidden from the CLI: their answer is base64 or a whole document, for workflows.
 */
export function createImageCapabilities(deps: ImageDeps = {}, llm: LlmDeps = { transports: iuTransports() }) {
  const resolved = resolveImageDeps(deps)
  return [
    createGenerate(resolved),
    createCutout(resolved),
    createUpscale(resolved),
    createVectorize(resolved),
    createEnhance(resolved, llm),
  ] as const
}

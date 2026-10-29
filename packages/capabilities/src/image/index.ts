import type { LlmDeps } from '../llm/model-call.ts'
import { iuTransports } from '../transports/index.ts'
import { createCutout } from './cutout.ts'
import { type ImageDeps, resolveImageDeps } from './deps.ts'
import { createEnhance } from './enhance.ts'
import { createGenerate } from './generate.ts'

export { CUTOUT_LIMITS, CUTOUT_MODELS, replicateBase } from './cutout.ts'
export type { CutoutOutput } from './cutout.ts'
export type { ImageDeps } from './deps.ts'
export type { EnhanceOutput } from './enhance.ts'
export { MAX_EDIT_IMAGES } from './files.ts'
export type { GenerateOutput, GeneratedImage } from './generate.ts'
export { GENERATE_MODELS, pickRoute, QUALITIES } from './generate.ts'
export { type AlphaStats, decodeAlphaStats, magicBytesValid, readPng } from './png.ts'
export { snapSize, validateSize } from './size.ts'

/**
 * The image capabilities: `image.generate` (a prompt, or with reference images an edit), `image.cutout` and
 * `image.enhance` (the planner, on the text wire). Generate and cutout have no CLI command: their answer is base64.
 */
export function createImageCapabilities(deps: ImageDeps = {}, llm: LlmDeps = { transports: iuTransports() }) {
  const resolved = resolveImageDeps(deps)
  return [createGenerate(resolved), createCutout(resolved), createEnhance(resolved, llm)] as const
}

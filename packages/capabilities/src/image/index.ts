import { createCutout } from './cutout.ts'
import { type ImageDeps, resolveImageDeps } from './deps.ts'
import { createGenerate } from './generate.ts'

export { CUTOUT_LIMITS, replicateBase } from './cutout.ts'
export type { CutoutOutput } from './cutout.ts'
export type { ImageDeps } from './deps.ts'
export type { GenerateOutput, GeneratedImage } from './generate.ts'
export { pickRoute } from './generate.ts'
export { magicBytesValid, readPng } from './png.ts'
export { snapSize, validateSize } from './size.ts'

/** The image capabilities: `image.generate` (a prompt, or with reference images an edit) and `image.cutout`. */
export function createImageCapabilities(deps: ImageDeps = {}) {
  const resolved = resolveImageDeps(deps)
  return [createGenerate(resolved), createCutout(resolved)] as const
}

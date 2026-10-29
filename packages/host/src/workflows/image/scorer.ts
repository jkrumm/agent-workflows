import { readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { decodeAlphaStats, readPng, snapSize } from '@agent-workflows/capabilities'
import type { Scorer, Verdict } from '@agent-workflows/runtime'
import { ImageOutput, type ImageInputValue } from './schema.ts'

/** Bump on any change to what a score means: compare refuses to mix scorer versions silently. */
export const IMAGE_SCORER_VERSION = '2026-10-29.2'

/** The share of pixels that must be below, and at, full opacity for a cutout to count as one (the pre-registered thresholds). */
export const ALPHA_MIN_SHARE = 0.05

function readBytes(path: string): Uint8Array | null {
  if (!isAbsolute(path)) return null
  try {
    return new Uint8Array(readFileSync(path))
  } catch {
    return null
  }
}

/** The displayed size of an input file: a PNG's header, or the image decoded for the size of a JPEG or WebP. */
async function sizeOf(path: string): Promise<{ width: number; height: number } | null> {
  const bytes = readBytes(path)
  if (!bytes) return null
  const png = readPng(bytes)
  if (png) return { width: png.width, height: png.height }
  try {
    const { width, height } = await new Bun.Image(bytes, { maxPixels: 100_000_000 }).metadata()
    return { width, height }
  } catch {
    return null
  }
}

/**
 * The `image` scorer (concept §6; the rule is `docs/research/2026-10-29-wave8-ports.md` §image, applied by `rule.ts`).
 * Deterministic, from the files the run left in the artifact store, never from what the output claims:
 * - `valid`: every listed file is on disk, a PNG by its magic bytes, decodes, and agrees with the listed size and bytes;
 *   the run made `n` images (one for a cutout); a generation at a requested `WxH` is that size after snapping; a cutout
 *   has its input's dimensions. A failed or unreadable run scores `valid` 0 and nothing else;
 * - `alpha` (cutout only): the decoded pixels have an alpha channel with at least 5 % of them below 255 and at least
 *   5 % at 255;
 * - `priced`: the run recorded a non-null cost above 0. The run record's cost is the sum of the same step usage as the
 *   output's `cost`, which is what a scorer can see.
 * Wall time is the run's, compared by the rule, not scored here. `pass`: every score present is 1.
 */
export const imageScorer: Scorer<ImageInputValue> = {
  version: IMAGE_SCORER_VERSION,
  async score(input, output): Promise<Verdict> {
    const parsed = ImageOutput.safeParse(output)
    if (!parsed.success) {
      return {
        scores: { valid: 0 },
        pass: false,
        feedback: output === null ? 'the run failed' : 'the output does not fit the image output schema',
      }
    }
    const run = parsed.data
    const cutout = input.file !== undefined
    const problems: string[] = []

    const expectedN = cutout ? 1 : (input.n ?? run.params.n)
    if (run.files.length !== expectedN) problems.push(`${run.files.length} image(s), expected ${expectedN}`)
    const expectedSize = !cutout && input.size && input.size !== 'auto' ? snapSize(input.size) : null
    const inputSize = cutout ? await sizeOf(input.file as string) : null
    if (cutout && !inputSize) problems.push('the cutout input cannot be read to compare sizes')

    const alpha: Array<{ translucent: number; opaque: number; total: number }> = []
    for (const [index, file] of run.files.entries()) {
      const label = `file ${index + 1}`
      const bytes = readBytes(file.path)
      const header = bytes ? readPng(bytes) : null
      if (!bytes || !header) {
        problems.push(`${label} is missing or not a PNG`)
        continue
      }
      const stats = await decodeAlphaStats(bytes)
      if (!stats) problems.push(`${label} does not decode`)
      if (header.width !== file.width || header.height !== file.height || bytes.length !== file.bytes) {
        problems.push(`${label} differs from what the output lists`)
      }
      if (expectedSize && `${header.width}x${header.height}` !== expectedSize) {
        problems.push(`${label} is ${header.width}x${header.height}, expected ${expectedSize}`)
      }
      if (inputSize && (header.width !== inputSize.width || header.height !== inputSize.height)) {
        problems.push(
          `${label} is ${header.width}x${header.height}, the input is ${inputSize.width}x${inputSize.height}`,
        )
      }
      if (stats) alpha.push({ translucent: stats.translucent, opaque: stats.opaque, total: stats.width * stats.height })
    }
    if (run.files.length === 0) problems.push('the run listed no files')

    if (problems.length > 0) return { scores: { valid: 0 }, pass: false, feedback: problems.join('; ') }
    const scores: Record<string, number> = { valid: 1 }
    if (cutout) {
      const good = alpha.every(
        (a) => a.translucent / a.total >= ALPHA_MIN_SHARE && a.opaque / a.total >= ALPHA_MIN_SHARE,
      )
      scores.alpha = good ? 1 : 0
    }
    scores.priced = run.cost.usd !== null && run.cost.usd > 0 ? 1 : 0
    const failed = Object.entries(scores)
      .filter(([, v]) => v !== 1)
      .map(([k]) => k)
    return {
      scores,
      pass: failed.length === 0,
      ...(failed.length
        ? {
            feedback: failed
              .map((k) =>
                k === 'alpha'
                  ? 'less than 5 % of the pixels are transparent or less than 5 % opaque'
                  : 'the run recorded no price',
              )
              .join('; '),
          }
        : {}),
    }
  },
}

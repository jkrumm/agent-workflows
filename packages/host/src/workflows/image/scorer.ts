import { readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { Scorer, Verdict } from '@agent-workflows/runtime'
import { ImageOutput, type ImageInputValue } from './schema.ts'

/** Bump on any change to what a score means: compare refuses to mix scorer versions silently. */
export const IMAGE_SCORER_VERSION = '2026-10-29.1'

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const be32 = (b: Buffer, at: number) => b.readUInt32BE(at)

/** Width, height and alpha of the file on disk, or null when it is missing or not a PNG with a valid header. */
function pngOnDisk(path: string): { width: number; height: number; hasAlpha: boolean; bytes: number } | null {
  if (!isAbsolute(path)) return null
  let bytes: Buffer
  try {
    bytes = readFileSync(path)
  } catch {
    return null
  }
  if (bytes.length < 33 || SIGNATURE.some((v, i) => bytes[i] !== v)) return null
  if (be32(bytes, 8) !== 13 || bytes.toString('latin1', 12, 16) !== 'IHDR') return null
  const colorType = bytes[25]
  let hasAlpha = colorType === 4 || colorType === 6
  if (colorType === 3) {
    for (let at = 33; at + 8 <= bytes.length; at += 12 + be32(bytes, at)) {
      const type = bytes.toString('latin1', at + 4, at + 8)
      if (type === 'tRNS') hasAlpha = true
      if (type === 'IDAT' || type === 'IEND') break
    }
  }
  return { width: be32(bytes, 16), height: be32(bytes, 20), hasAlpha, bytes: bytes.length }
}

/**
 * The `image` scorer (concept §6; the rule is `docs/research/2026-10-29-wave8-ports.md` §image). Deterministic, from the
 * files the run left in the artifact store, never from what the output claims:
 * - `valid`: 1 when the output fits its schema and every listed file is a PNG on disk whose header agrees with the listed
 *   size and bytes; else 0 and the only score (a failed run counts in the valid rate);
 * - `count`: 1 when the run made the images asked for (`n` for a generation, one for a cutout);
 * - `size`: generation with a requested `WxH`: the share of files that are the size the run reports as requested after
 *   snapping (the snapping itself is the capability's, tested there); 0 when the report disagrees with the input
 *   (`size` differs from the input without `snappedFrom`, or `snappedFrom` is not the input); left out for `auto`;
 * - `alpha`: a cutout, or a generation with `background: transparent`: the share of files that carry an alpha channel;
 * - `cost`: 1 when the run recorded a price.
 * `pass`: every score present is 1.
 */
export const imageScorer: Scorer<ImageInputValue> = {
  version: IMAGE_SCORER_VERSION,
  score(input, output): Verdict {
    const parsed = ImageOutput.safeParse(output)
    if (!parsed.success)
      return {
        scores: { valid: 0 },
        pass: false,
        feedback: output === null ? 'the run failed' : 'the output does not fit the image output schema',
      }
    const run = parsed.data
    const disk = run.files.map((file) => ({ listed: file, found: pngOnDisk(file.path) }))
    const broken = disk.filter(
      ({ listed, found }) =>
        !found || found.width !== listed.width || found.height !== listed.height || found.bytes !== listed.bytes,
    )
    if (run.files.length === 0 || broken.length > 0) {
      return {
        scores: { valid: 0 },
        pass: false,
        feedback:
          run.files.length === 0
            ? 'the run listed no files'
            : `${broken.length} file(s) are missing, not a PNG, or differ from what the output lists`,
      }
    }
    const share = (hits: number) => hits / disk.length
    const scores: Record<string, number> = { valid: 1 }
    const problems: string[] = []

    const wanted = input.file !== undefined ? 1 : input.n
    scores.count = run.files.length === wanted ? 1 : 0
    if (scores.count === 0) problems.push(`${run.files.length} image(s), asked for ${wanted}`)

    if (input.file === undefined && input.size !== 'auto') {
      const expected = run.size
      const reported = run.snappedFrom === undefined ? run.size === input.size : run.snappedFrom === input.size
      scores.size = reported
        ? share(disk.filter(({ found }) => `${found?.width}x${found?.height}` === expected).length)
        : 0
      if (scores.size < 1)
        problems.push(reported ? `not every image is ${expected}` : 'the reported size does not follow from the input')
    }
    if (input.file !== undefined || input.background === 'transparent') {
      scores.alpha = share(disk.filter(({ found }) => found?.hasAlpha).length)
      if (scores.alpha < 1) problems.push('not every image has an alpha channel')
    }
    scores.cost = run.cost.usd !== null ? 1 : 0
    if (scores.cost === 0) problems.push('the run recorded no price')
    return {
      scores,
      pass: Object.values(scores).every((v) => v === 1),
      ...(problems.length ? { feedback: problems.join('; ') } : {}),
    }
  },
}

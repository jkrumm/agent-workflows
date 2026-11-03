import { join } from 'node:path'
import type { Scorer, Verdict } from '@agent-workflows/runtime'
import sharp from 'sharp'
import { z } from 'zod'
import { ImageIconInput, type ImageIconInputValue, ImageIconOutput, type ImageIconOutputValue } from './schema.ts'

/** Bump on any change to what a score means: compare refuses to mix scorer versions silently. */
export const IMAGE_ICON_SCORER_VERSION = '2026-11-03.1'

/**
 * What a careful reader expects of one run beyond the output's own consistency: the model steps that ran (their order
 * is the pipeline's) and whether the background is gone at the content corner of `icon-512.png`.
 */
export const ImageIconReference = z.strictObject({
  steps: z.array(z.enum(['upscale', 'cutout', 'vectorize'])),
  transparentCorner: z.boolean(),
})
export type ImageIconReference = z.output<typeof ImageIconReference>

/** The icon set spec: name, mime and pixel size of every file the workflow lists (`favicon.svg` has no pixel size). */
const ICO = { name: 'favicon.ico', mime: 'image/x-icon', size: 48 }
const SVG = { name: 'favicon.svg', mime: 'image/svg+xml', size: 0 }
const RASTERS = [
  { name: 'icon-192.png', mime: 'image/png', size: 192 },
  { name: 'icon-512.png', mime: 'image/png', size: 512 },
  { name: 'icon-mask.png', mime: 'image/png', size: 512 },
  { name: 'apple-touch-icon.png', mime: 'image/png', size: 180 },
  { name: 'icon-1024.png', mime: 'image/png', size: 1024 },
] as const
const ICNS = { name: 'AppIcon.icns', mime: 'image/icns', size: 1024 }

/** A pixel just inside the content corner of `icon-512.png` (box 451 px at offset 30): transparent iff the ground is gone. */
const CORNER_PROBE = 34
/** Below this alpha a pixel counts as transparent; at or above `OPAQUE` as opaque. */
const CLEAR = 8
const OPAQUE = 250

const SCORE_KEYS = ['valid', 'files', 'dimensions', 'manifest', 'svg', 'background', 'cost'] as const
const REFERENCE_KEYS = ['steps', 'alpha'] as const
const ZERO = Object.fromEntries([...SCORE_KEYS, ...REFERENCE_KEYS].map((k) => [k, 0]))

type Listed = ImageIconOutputValue['files'][number]
type Check = { ok: boolean; why: string[] }

const check = (): Check & { fail(why: string): void } => {
  const why: string[] = []
  return {
    get ok() {
      return why.length === 0
    },
    why,
    fail: (message) => void why.push(message),
  }
}

const bytesOf = (path: string): Promise<Uint8Array | null> =>
  Bun.file(path)
    .bytes()
    .catch(() => null)

/** The pixel size a PNG states in its IHDR, or null when the bytes are not a PNG. */
function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  const isPng = bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
  if (!isPng) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

const startsWith = (bytes: Uint8Array, magic: number[]) => magic.every((b, i) => bytes[i] === b)

/** The RGBA of one pixel of an image file, or null when it cannot be decoded. */
async function pixel(path: string, x: number, y: number): Promise<[number, number, number, number] | null> {
  try {
    const { data } = await sharp(path)
      .ensureAlpha()
      .extract({ left: x, top: y, width: 1, height: 1 })
      .raw()
      .toBuffer({ resolveWithObject: true })
    return [data[0] ?? 0, data[1] ?? 0, data[2] ?? 0, data[3] ?? 0]
  } catch {
    return null
  }
}

const expectedSpec = (withSvg: boolean) => [ICO, ...(withSvg ? [SVG] : []), ...RASTERS, ICNS]

/** The listing is the spec's files in order, each at its path in the run dir, on disk, of the stated size and mime. */
async function filesCheck(output: ImageIconOutputValue, withSvg: boolean, listed: Map<string, Listed>) {
  const c = check()
  const spec = expectedSpec(withSvg)
  const names = output.files.map((f) => f.name)
  if (names.join() !== spec.map((s) => s.name).join())
    c.fail(`files are ${names.join(', ')} (want ${spec.map((s) => s.name).join(', ')})`)
  for (const file of output.files) {
    if (file.path !== join(output.dir, file.name)) c.fail(`${file.name} is not in the run dir`)
    const bytes = await bytesOf(file.path)
    if (!bytes) c.fail(`${file.name} is not on disk`)
    else if (bytes.byteLength !== file.bytes)
      c.fail(`${file.name} is ${bytes.byteLength} bytes on disk, listed ${file.bytes}`)
    const want = spec.find((s) => s.name === file.name)
    if (want && file.mime !== want.mime) c.fail(`${file.name} mime ${file.mime} (want ${want.mime})`)
  }
  if (listed.size !== output.files.length) c.fail('a file is listed twice')
  return c
}

/** Listed and on-disk pixel sizes per the spec; the ICO and ICNS by their magic bytes. */
async function dimensionsCheck(output: ImageIconOutputValue) {
  const c = check()
  for (const file of output.files) {
    const want = expectedSpec(true).find((s) => s.name === file.name)
    if (!want) continue
    if (file.width !== want.size || file.height !== want.size)
      c.fail(`${file.name} is listed ${file.width}x${file.height} (want ${want.size}x${want.size})`)
    const bytes = await bytesOf(file.path)
    if (!bytes) continue
    if (file.mime === 'image/png') {
      const size = pngSize(bytes)
      if (!size) c.fail(`${file.name} is not a PNG`)
      else if (size.width !== want.size || size.height !== want.size)
        c.fail(`${file.name} is ${size.width}x${size.height} on disk (want ${want.size}x${want.size})`)
    } else if (file.name === ICO.name && !startsWith(bytes, [0, 0, 1, 0])) c.fail('favicon.ico has no ICO header')
    else if (file.name === ICNS.name && !startsWith(bytes, [0x69, 0x63, 0x6e, 0x73]))
      c.fail('AppIcon.icns has no icns header')
    else if (file.name === SVG.name && !new TextDecoder().decode(bytes).includes('<svg'))
      c.fail('favicon.svg holds no <svg')
  }
  return c
}

/** The manifest points at listed PNGs of the stated size and type, matches the file on disk, and the head tags match the set. */
async function manifestCheck(output: ImageIconOutputValue, listed: Map<string, Listed>) {
  const c = check()
  if (output.manifest.icons.length === 0) c.fail('the manifest lists no icon')
  for (const icon of output.manifest.icons) {
    const file = listed.get(icon.src.replace(/^\//, ''))
    if (!file) {
      c.fail(`manifest icon ${icon.src} is not a listed file`)
      continue
    }
    if (icon.sizes !== `${file.width}x${file.height}`) c.fail(`manifest icon ${icon.src} says ${icon.sizes}`)
    if (icon.type !== file.mime) c.fail(`manifest icon ${icon.src} says ${icon.type}`)
    if ((icon.purpose === 'maskable') !== (file.name === 'icon-mask.png')) c.fail(`manifest icon ${icon.src} purpose`)
  }
  if (
    !output.manifest.icons.some((i) => i.src === '/icon-192.png') ||
    !output.manifest.icons.some((i) => i.src === '/icon-512.png')
  )
    c.fail('the manifest lacks icon-192 or icon-512')
  const manifest = await bytesOf(output.manifestPath)
  try {
    if (!manifest || JSON.stringify(JSON.parse(new TextDecoder().decode(manifest))) !== JSON.stringify(output.manifest))
      c.fail('manifest.webmanifest differs from the manifest')
  } catch {
    c.fail('manifest.webmanifest is not JSON')
  }
  const head = await bytesOf(output.htmlPath)
  if (!head || new TextDecoder().decode(head).trim() !== output.html.trim()) c.fail('head.html differs from the html')
  const tag = (needle: string) => output.html.includes(needle)
  if (!tag('rel="manifest"') || !tag('rel="apple-touch-icon"') || !tag('/favicon.ico'))
    c.fail('the head tags lack a required link')
  if (tag('/favicon.svg') !== listed.has(SVG.name)) c.fail('the svg link and favicon.svg disagree')
  return c
}

/** `svg: never` leaves no svg, no reason and no vectorize call; `auto` calls it, and the file or the reason stands, not both. */
function svgCheck(input: ImageIconInputValue, output: ImageIconOutputValue, hasSvg: boolean) {
  const c = check()
  const vectorized = output.steps.some((s) => s.step === 'vectorize')
  if (input.svg === 'never') {
    if (hasSvg || output.svgSkippedReason !== undefined || vectorized)
      c.fail('svg is never, yet an svg or its reason or call is there')
    return c
  }
  if (!vectorized) c.fail('svg is auto, yet vectorize did not run')
  if (hasSvg && output.svgSkippedReason !== undefined) c.fail('favicon.svg is listed and also skipped')
  if (!hasSvg && !output.svgSkippedReason) c.fail('favicon.svg is missing and no reason is given')
  return c
}

/** `apple-touch-icon.png` is flattened on the input's background: its (0, 0) pixel is that colour, opaque. */
async function backgroundCheck(input: ImageIconInputValue, output: ImageIconOutputValue) {
  const c = check()
  const file = output.files.find((f) => f.name === 'apple-touch-icon.png')
  const px = file ? await pixel(file.path, 0, 0) : null
  const want = [1, 3, 5].map((i) => Number.parseInt(input.background.slice(i, i + 2), 16))
  if (!px) c.fail('apple-touch-icon.png cannot be read')
  else if (px[3] !== 255 || want.some((v, i) => Math.abs(v - (px[i] ?? 0)) > 2))
    c.fail(`apple-touch-icon.png corner is ${px.join(',')} (want ${want.join(',')},255)`)
  return c
}

/** The cost is recorded, known, and the sum of the steps that ran (0 for none). */
function costCheck(output: ImageIconOutputValue) {
  const c = check()
  const steps = output.steps.map((s) => s.costUsd)
  if (output.cost.usd === null || steps.includes(null)) c.fail('a price is unknown')
  else if (Math.abs(output.cost.usd - steps.reduce<number>((sum, v) => sum + (v ?? 0), 0)) > 1e-6)
    c.fail(`cost $${output.cost.usd} is not the sum of the steps`)
  return c
}

/** Whether the ground is gone at the content corner of `icon-512.png`, as the reference says. */
async function alphaCheck(output: ImageIconOutputValue, want: boolean) {
  const c = check()
  const file = output.files.find((f) => f.name === 'icon-512.png')
  const px = file ? await pixel(file.path, CORNER_PROBE, CORNER_PROBE) : null
  if (!px) c.fail('icon-512.png cannot be read')
  else if (want && px[3] >= CLEAR) c.fail(`icon-512 corner has alpha ${px[3]} (want transparent)`)
  else if (!want && px[3] < OPAQUE) c.fail(`icon-512 corner has alpha ${px[3]} (want opaque)`)
  return c
}

/**
 * The `image-icon` scorer. Deterministic, no model: it reads the files the run listed. Every score is 0 or 1; when
 * `valid` is 0 so is every other score:
 * - `valid`: the output parses as an icon-set listing;
 * - `files`: exactly the spec's files in order (`favicon.svg` only if listed), in the run dir, on disk, of the listed size and mime;
 * - `dimensions`: listed and on-disk PNG sizes per the spec (48, 192, 512, 512, 180, 1024), ICO/ICNS/SVG headers;
 * - `manifest`: its icons name listed PNGs of the stated size and type, `manifest.webmanifest` and `head.html` match
 *   the output, the head links match the set;
 * - `svg`: `svg: never` left no svg, reason or call; `auto` called vectorize and has the file or the reason, not both;
 * - `background`: the opaque `apple-touch-icon.png` is flattened on the input's background;
 * - `cost`: the price is known and the sum of the steps that ran;
 * and with a reference: `steps` (the model steps that ran are the reference's, in order) and `alpha` (the ground is gone at
 * the corner of `icon-512.png`, or kept, as the reference says). `pass`: every score 1.
 */
export const imageIconScorer: Scorer<unknown, ImageIconReference> = {
  version: IMAGE_ICON_SCORER_VERSION,
  reference: ImageIconReference,
  async score(input, output, ctx): Promise<Verdict> {
    const parsed = ImageIconOutput.safeParse(output)
    const given = ImageIconInput.safeParse(input)
    const keys = ctx.reference ? [...SCORE_KEYS, ...REFERENCE_KEYS] : SCORE_KEYS
    const failed = (feedback: string): Verdict => ({
      scores: Object.fromEntries(keys.map((k) => [k, ZERO[k] ?? 0])),
      pass: false,
      feedback,
    })
    if (!parsed.success) return failed(output === null ? 'the run failed' : 'the output is not an icon set')
    if (!given.success) return failed('the input is not an image-icon input')
    const out = parsed.data
    const listed = new Map(out.files.map((f) => [f.name, f]))
    const hasSvg = listed.has(SVG.name)

    const checks: Record<string, Check> = {
      files: await filesCheck(out, hasSvg, listed),
      dimensions: await dimensionsCheck(out),
      manifest: await manifestCheck(out, listed),
      svg: svgCheck(given.data, out, hasSvg),
      background: await backgroundCheck(given.data, out),
      cost: costCheck(out),
    }
    if (ctx.reference) {
      const ran = out.steps.map((s) => s.step)
      const steps = check()
      if (ran.join() !== ctx.reference.steps.join())
        steps.fail(`steps ran [${ran.join(', ')}] (want [${ctx.reference.steps.join(', ')}])`)
      checks.steps = steps
      checks.alpha = await alphaCheck(out, ctx.reference.transparentCorner)
    }
    const scores = { valid: 1, ...Object.fromEntries(Object.entries(checks).map(([k, c]) => [k, c.ok ? 1 : 0])) }
    const feedback = Object.entries(checks).flatMap(([k, c]) => c.why.map((w) => `${k}: ${w}`))
    return {
      scores,
      pass: Object.values(scores).every((v) => v === 1),
      ...(feedback.length ? { feedback: feedback.join('; ') } : {}),
    }
  },
}

/**
 * Golden comparison of the image-icon pipeline against the retired image-gateway's `/icons`.
 *
 * Provenance: image-gateway @ 3efdf8a, run of 2026-10-29 on `fixtures/image-icon/source.png`
 * (1024x1024 with real transparency, so upscale and cutout were skipped; default background
 * #ffffff). `fixtures/image-icon/golden.json` was captured from that run's output set (rasters,
 * ICO frames, ICNS chunks as 32x32 lanczos3 RGBA fingerprints, plus head.html, the manifest and the
 * vectorize-cleaned favicon.svg). It is not regenerable: the gateway is being retired.
 *
 * Tolerance: fingerprints must agree within mean abs channel diff <= MEAN_TOLERANCE and max
 * <= MAX_TOLERANCE. Measured on darwin-arm64 with the gateway's sharp 0.35.5: every raster, the ICO
 * and the ICNS are BYTE-IDENTICAL to the gateway files (diff 0 / 0), and cleanVectorized reproduces
 * the golden favicon.svg exactly. The tolerance is therefore tight and only leaves headroom for
 * SIMD rounding on another CPU architecture.
 */
import { beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import {
  buildMaster,
  cleanVectorized,
  decodeRgba,
  type IconAsset,
  ICONS_MANIFEST,
  iconsHtml,
  lacksTransparency,
  renderRasters,
  SVG_MAX_BYTES,
} from '../src/workflows/image-icon/pipeline.ts'

const MEAN_TOLERANCE = 0.25
const MAX_TOLERANCE = 2

interface Fingerprint {
  width: number
  height: number
  channels: number
  hasAlpha: boolean
  fingerprint: string
}
interface GoldenFile {
  name: string
  mime: string
  width: number
  height: number
  channels?: number
  hasAlpha?: boolean
  fingerprint?: string
  frames?: ({ size: number } & Fingerprint)[]
  chunks?: ({ type: string } & Fingerprint)[]
}
interface Golden {
  background: string
  files: GoldenFile[]
  html: string
  manifest: string
  svg: string
}

const FIXTURES = join(import.meta.dir, 'fixtures', 'image-icon')
const golden = JSON.parse(readFileSync(join(FIXTURES, 'golden.json'), 'utf8')) as Golden

async function fingerprint(png: Uint8Array): Promise<Fingerprint> {
  const meta = await sharp(png).metadata()
  const raw = await sharp(png).ensureAlpha().resize(32, 32, { fit: 'fill', kernel: 'lanczos3' }).raw().toBuffer()
  return {
    width: meta.width ?? 0,
    height: meta.height ?? 0,
    channels: meta.channels ?? 0,
    hasAlpha: meta.hasAlpha ?? false,
    fingerprint: raw.toString('base64'),
  }
}

function diff(actual: string, expected: string): { mean: number; max: number } {
  const a = Buffer.from(actual, 'base64')
  const b = Buffer.from(expected, 'base64')
  expect(a.length).toBe(b.length)
  let sum = 0
  let max = 0
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs((a[i] ?? 0) - (b[i] ?? 0))
    sum += d
    if (d > max) max = d
  }
  return { mean: sum / a.length, max }
}

function expectClose(label: string, actual: Fingerprint, expected: Fingerprint): void {
  expect([label, actual.width, actual.height, actual.channels, actual.hasAlpha]).toEqual([
    label,
    expected.width,
    expected.height,
    expected.channels,
    expected.hasAlpha,
  ])
  const { mean, max } = diff(actual.fingerprint, expected.fingerprint)
  expect(mean, `${label} mean diff`).toBeLessThanOrEqual(MEAN_TOLERANCE)
  expect(max, `${label} max diff`).toBeLessThanOrEqual(MAX_TOLERANCE)
}

/** The PNG payloads of an ICO, by directory entry. */
function icoFrames(ico: Buffer): { size: number; png: Buffer }[] {
  return Array.from({ length: ico.readUInt16LE(4) }, (_, i) => {
    const entry = 6 + 16 * i
    const offset = ico.readUInt32LE(entry + 12)
    return { size: ico.readUInt8(entry) || 256, png: ico.subarray(offset, offset + ico.readUInt32LE(entry + 8)) }
  })
}

/** The PNG payloads of an ICNS, by chunk. */
function icnsChunks(icns: Buffer): { type: string; png: Buffer }[] {
  const chunks: { type: string; png: Buffer }[] = []
  for (let offset = 8; offset < icns.length; ) {
    const length = icns.readUInt32BE(offset + 4)
    chunks.push({
      type: icns.subarray(offset, offset + 4).toString('ascii'),
      png: icns.subarray(offset + 8, offset + length),
    })
    offset += length
  }
  return chunks
}

describe('image-icon golden (image-gateway @ 3efdf8a, 2026-10-29)', () => {
  let files: IconAsset[]

  beforeAll(async () => {
    const source = await decodeRgba(readFileSync(join(FIXTURES, 'source.png')))
    expect(lacksTransparency(source.data)).toBe(false)
    files = await renderRasters(await buildMaster(source), golden.background)
  })

  test('same file names, order, mime and dimensions', () => {
    expect(files.map((f) => [f.name, f.mime, f.width, f.height])).toEqual(
      golden.files.map((f) => [f.name, f.mime, f.width, f.height]),
    )
  })

  test('PNG rasters match the golden fingerprints, channels and alpha', async () => {
    for (const expected of golden.files.filter((f) => f.fingerprint)) {
      const actual = files.find((f) => f.name === expected.name)
      if (!actual) throw new Error(`missing ${expected.name}`)
      expectClose(expected.name, await fingerprint(actual.bytes), expected as Fingerprint)
    }
  })

  test('favicon.ico has the golden frames', async () => {
    const expected = golden.files.find((f) => f.name === 'favicon.ico')?.frames ?? []
    const frames = icoFrames(files.find((f) => f.name === 'favicon.ico')?.bytes ?? Buffer.alloc(0))
    expect(frames.map((f) => f.size)).toEqual(expected.map((f) => f.size))
    for (const [i, frame] of frames.entries()) {
      const want = expected[i]
      if (!want) throw new Error(`no golden frame ${i}`)
      expectClose(`favicon.ico ${frame.size}px`, await fingerprint(frame.png), want)
    }
  })

  test('AppIcon.icns has the golden chunks', async () => {
    const expected = golden.files.find((f) => f.name === 'AppIcon.icns')?.chunks ?? []
    const chunks = icnsChunks(files.find((f) => f.name === 'AppIcon.icns')?.bytes ?? Buffer.alloc(0))
    expect(chunks.map((c) => c.type)).toEqual(expected.map((c) => c.type))
    for (const [i, chunk] of chunks.entries()) {
      const want = expected[i]
      if (!want) throw new Error(`no golden chunk ${i}`)
      expectClose(`AppIcon.icns ${chunk.type}`, await fingerprint(chunk.png), want)
    }
  })

  test('head html and manifest are the gateway output byte for byte', () => {
    expect(`${iconsHtml(true)}\n`).toBe(golden.html)
    expect(`${JSON.stringify(ICONS_MANIFEST, null, 2)}\n`).toBe(golden.manifest)
  })

  test('cleanVectorized keeps the viewBox and stays under the size cap', () => {
    const svg = cleanVectorized(golden.svg)
    const root = svg.match(/<svg\b[^>]*>/)?.[0] ?? ''
    expect(root).toContain('viewBox="0 0 2048 2048"')
    expect(Buffer.byteLength(svg)).toBeLessThanOrEqual(SVG_MAX_BYTES)
  })
})

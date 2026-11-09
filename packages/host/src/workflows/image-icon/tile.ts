import sharp from 'sharp'
import type { Rgb } from './color.ts'

/** The maskable safe zone: a centered 409px box (80%) inside the 512px icon-mask canvas. */
export const MASKABLE_BOX = 409

/** Alpha from which a pixel belongs to the tile's opaque core. */
const CORE_ALPHA = 250
const MIN_TILE_SIDE = 16
const MAX_ASPECT_SKEW = 0.03
const MIN_FILL = 0.9
/** The crop around the core keeps the anti-aliased rim and a little transparent context. */
const CROP_MARGIN = 2
/** The edge colour is sampled this far inside the edge, as a fraction of the side. */
const EDGE_SAMPLE_INSET = 0.03

const ART_PROBE_SIZE = 256
const ART_RIM = 0.04
const ART_DISTANCE = 40

/** macOS app icons sit in an 824px square of the 1024 grid, with a soft shadow beneath. */
const MACOS_GRID = 824 / 1024
const SHADOW_ALPHA = 0.35
const SHADOW_SIGMA = 0.01
const SHADOW_OFFSET = 0.012

interface Region {
  left: number
  top: number
  width: number
  height: number
}

export interface TileInfo {
  /** The opaque core's bounding box in master coordinates (`side` is its long edge). */
  left: number
  top: number
  width: number
  height: number
  side: number
  /** Mean colour of the four edge midpoints, sampled just inside the edge. */
  edgeColor: Rgb
  /** The core expanded by a 2px margin, clipped to the master. */
  crop: Region
}

async function decodeRaw(bytes: Buffer): Promise<{ data: Buffer; width: number; height: number }> {
  const { data, info } = await sharp(bytes)
    .toColourspace('srgb')
    .ensureAlpha()
    .raw({ depth: 'uchar' })
    .toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height }
}

/**
 * A rounded tile: art on a rounded square with transparent corners. The opaque core (alpha >= 250) must be a near-square
 * of at least 16px that fills 90% of its bounding box, touches all four edges at their midpoints and misses the four
 * bbox corners. A disc (fill 0.785) and an already square, opaque image are no tile.
 */
export async function detectTile(master: Buffer): Promise<TileInfo | null> {
  const { data, width: masterWidth, height: masterHeight } = await decodeRaw(master)
  const core = (x: number, y: number) => (data[(y * masterWidth + x) * 4 + 3] ?? 0) >= CORE_ALPHA

  let minX = masterWidth
  let minY = masterHeight
  let maxX = -1
  let maxY = -1
  let count = 0
  for (let y = 0; y < masterHeight; y++) {
    for (let x = 0; x < masterWidth; x++) {
      if (!core(x, y)) continue
      count++
      minX = Math.min(minX, x)
      maxX = Math.max(maxX, x)
      minY = Math.min(minY, y)
      maxY = Math.max(maxY, y)
    }
  }
  if (count === 0) return null

  const width = maxX - minX + 1
  const height = maxY - minY + 1
  const side = Math.max(width, height)
  if (Math.min(width, height) < MIN_TILE_SIDE) return null
  if (Math.abs(width - height) > MAX_ASPECT_SKEW * side) return null
  if (count / (width * height) < MIN_FILL) return null

  const midX = minX + Math.floor(width / 2)
  const midY = minY + Math.floor(height / 2)
  const edgeMidpoints: [number, number][] = [
    [midX, minY],
    [midX, maxY],
    [minX, midY],
    [maxX, midY],
  ]
  if (!edgeMidpoints.every(([x, y]) => core(x, y))) return null
  const corners: [number, number][] = [
    [minX, minY],
    [maxX, minY],
    [minX, maxY],
    [maxX, maxY],
  ]
  if (corners.some(([x, y]) => core(x, y))) return null

  const inset = Math.round(side * EDGE_SAMPLE_INSET)
  const samples = [
    [midX, minY + inset],
    [midX, maxY - inset],
    [minX + inset, midY],
    [maxX - inset, midY],
  ] as const
  const edgeColor = [0, 1, 2].map((channel) => {
    const sum = samples.reduce((acc, [x, y]) => acc + (data[(y * masterWidth + x) * 4 + channel] ?? 0), 0)
    return Math.round(sum / samples.length)
  }) as Rgb

  const left = Math.max(0, minX - CROP_MARGIN)
  const top = Math.max(0, minY - CROP_MARGIN)
  const crop = {
    left,
    top,
    width: Math.min(masterWidth, maxX + 1 + CROP_MARGIN) - left,
    height: Math.min(masterHeight, maxY + 1 + CROP_MARGIN) - top,
  }
  return { left: minX, top: minY, width, height, side, edgeColor, crop }
}

/** The tile with its own alpha (rounded corners), as a square PNG of the crop's long side. */
export async function tileCrop(master: Buffer, tile: TileInfo): Promise<Buffer> {
  const { crop } = tile
  const side = Math.max(crop.width, crop.height)
  const cropped = sharp(master).extract(crop)
  return (crop.width === crop.height ? cropped : cropped.resize(side, side, { fit: 'fill' })).png().toBuffer()
}

/** The nearest solid pixel along one axis (`dx`/`dy` is the unit step), or -1. */
function nearestSolid(args: { solid: Uint8Array; size: number; x: number; y: number; dx: number; dy: number }): number {
  const { solid, size, x, y, dx, dy } = args
  const probe = (px: number, py: number) => (px >= 0 && py >= 0 && px < size && py < size ? py * size + px : -1)
  for (let d = 1; d < size; d++) {
    const before = probe(x - d * dx, y - d * dy)
    if (before >= 0 && solid[before]) return before
    const after = probe(x + d * dx, y + d * dy)
    if (after >= 0 && solid[after]) return after
  }
  return -1
}

/** Fill every non-solid pixel with the mean of the nearest solid pixel in its row and in its column; alpha becomes 255. */
function bleedTransparent(data: Buffer, size: number, fallback: Rgb): void {
  const solid = new Uint8Array(size * size)
  for (let i = 0; i < solid.length; i++) solid[i] = (data[i * 4 + 3] ?? 0) >= CORE_ALPHA ? 1 : 0

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const pixel = y * size + x
      if (solid[pixel]) continue
      const sources = [
        nearestSolid({ solid, size, x, y, dx: 1, dy: 0 }),
        nearestSolid({ solid, size, x, y, dx: 0, dy: 1 }),
      ].filter((index) => index >= 0)
      for (let channel = 0; channel < 3; channel++) {
        const value =
          sources.length === 0
            ? fallback[channel]
            : sources.reduce((sum, index) => sum + (data[index * 4 + channel] ?? 0), 0) / sources.length
        data[pixel * 4 + channel] = Math.round(value ?? 0)
      }
      data[pixel * 4 + 3] = 255
    }
  }
}

/**
 * The tile as an opaque square with no transparent corner and no inner edge. With a `background` the corners are that
 * flat colour (the caller chose it; a colour other than the tile's leaves visible corners); without one they bleed from
 * the tile itself.
 */
export async function tileSquare(master: Buffer, tile: TileInfo, background?: string): Promise<Buffer> {
  const crop = await tileCrop(master, tile)
  if (background) return sharp(crop).flatten({ background }).png().toBuffer()
  const { data, info } = await sharp(crop).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  bleedTransparent(data, info.width, tile.edgeColor)
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png()
    .toBuffer()
}

/** The tile square filling a whole `size` canvas. */
export const fullBleed = (square: Buffer, size: number): Promise<Buffer> =>
  sharp(square).resize(size, size).png({ compressionLevel: 9 }).toBuffer()

/** Half the art's extent from the centre as a fraction of the side: art is what differs from the tile's edge colour. */
async function artHalfExtent(square: Buffer, edgeColor: Rgb): Promise<number> {
  const probe = ART_PROBE_SIZE
  const data = await sharp(square).resize(probe, probe).removeAlpha().raw().toBuffer()
  const rim = Math.floor(probe * ART_RIM)
  const centre = probe / 2
  let extent = 0
  for (let y = rim; y < probe - rim; y++) {
    for (let x = rim; x < probe - rim; x++) {
      const i = (y * probe + x) * 3
      const distance = Math.hypot(
        (data[i] ?? 0) - edgeColor[0],
        (data[i + 1] ?? 0) - edgeColor[1],
        (data[i + 2] ?? 0) - edgeColor[2],
      )
      if (distance <= ART_DISTANCE) continue
      extent = Math.max(extent, Math.max(Math.abs(x + 0.5 - centre), Math.abs(y + 0.5 - centre)) + 0.5)
    }
  }
  return extent / probe
}

/**
 * The maskable icon: the tile square full bleed at `size`, scaled down with edge replication when its art would leave
 * the safe zone box.
 */
export async function maskable(square: Buffer, edgeColor: Rgb, size: number): Promise<Buffer> {
  const half = await artHalfExtent(square, edgeColor)
  const scale = half === 0 ? 1 : Math.min(1, MASKABLE_BOX / 2 / (half * size))
  if (scale === 1) return fullBleed(square, size)
  const inner = Math.round(size * scale)
  const before = Math.floor((size - inner) / 2)
  return sharp(square)
    .resize(inner, inner)
    .extend({
      top: before,
      bottom: size - inner - before,
      left: before,
      right: size - inner - before,
      extendWith: 'copy',
    })
    .png({ compressionLevel: 9 })
    .toBuffer()
}

/** One ICNS size on the macOS grid: the rounded tile at 824/1024 of the canvas, centred, over a soft shadow. */
export async function macosIcon(crop: Buffer, size: number): Promise<Buffer> {
  const box = Math.round(size * MACOS_GRID)
  const offset = Math.floor((size - box) / 2)
  const drop = Math.round(size * SHADOW_OFFSET)
  const { data, info } = await sharp(crop).resize(box, box).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const tile = await sharp(data, { raw: info }).png().toBuffer()

  for (let i = 0; i < data.length; i += 4) {
    data.fill(0, i, i + 3)
    data[i + 3] = Math.round((data[i + 3] ?? 0) * SHADOW_ALPHA)
  }
  const shadowTile = await sharp(data, { raw: info }).png().toBuffer()
  const shadow = await sharp({
    create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: shadowTile, left: offset, top: offset + drop }])
    .png()
    .toBuffer()
  return sharp(
    await sharp(shadow)
      .blur(Math.max(0.3, size * SHADOW_SIGMA))
      .toBuffer(),
  )
    .composite([{ input: tile, left: offset, top: offset }])
    .png({ compressionLevel: 9 })
    .toBuffer()
}

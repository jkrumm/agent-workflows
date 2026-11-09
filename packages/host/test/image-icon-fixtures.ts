import sharp from 'sharp'

export type Rgb = [number, number, number]

const clamp01 = (value: number) => Math.min(1, Math.max(0, value))

/** Anti-aliased coverage of a rounded square (`half` is its half side, `radius` its corner) at a pixel centre. */
function roundedCoverage(args: { x: number; y: number; centre: number; half: number; radius: number }): number {
  const { x, y, centre, half, radius } = args
  const qx = Math.abs(x + 0.5 - centre) - (half - radius)
  const qy = Math.abs(y + 0.5 - centre) - (half - radius)
  const distance = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius
  return clamp01(0.5 - distance)
}

/**
 * A `size` square master: a rounded tile of `side` px (centred, transparent outside) in a flat colour or a vertical
 * gradient, with a lighter disc glyph of `glyphRadius` in the middle.
 */
export function tileMaster(
  options: {
    size?: number
    side?: number
    radius?: number
    color?: Rgb
    gradient?: [Rgb, Rgb]
    glyphRadius?: number
    glyph?: Rgb
  } = {},
): Promise<Buffer> {
  const { size = 1024, side = size, radius = 225, color = [26, 43, 76], gradient, glyphRadius = 260 } = options
  const glyph = options.glyph ?? [232, 238, 252]
  const data = Buffer.alloc(size * size * 4)
  const centre = size / 2
  const top = centre - side / 2
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const coverage = roundedCoverage({ x, y, centre, half: side / 2, radius })
      if (coverage === 0) continue
      const along = clamp01((y - top) / side)
      const base = gradient ? gradient[0].map((v, i) => v + (gradient[1][i]! - v) * along) : color
      const glyphCoverage = clamp01(0.5 - (Math.hypot(x + 0.5 - centre, y + 0.5 - centre) - glyphRadius))
      const rgb = base.map((v, i) => v + (glyph[i]! - v) * glyphCoverage)
      data.set([...rgb.map(Math.round), Math.round(coverage * 255)], (y * size + x) * 4)
    }
  }
  return sharp(data, { raw: { width: size, height: size, channels: 4 } })
    .png()
    .toBuffer()
}

/** A disc of `radius` in a `size` square, transparent outside (anti-aliased). */
export function discMaster(options: { size?: number; radius?: number; color: Rgb }): Promise<Buffer> {
  const { size = 600, radius = 200, color } = options
  const data = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const coverage = clamp01(0.5 - (Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) - radius))
      data.set([...color, Math.round(coverage * 255)], (y * size + x) * 4)
    }
  }
  return sharp(data, { raw: { width: size, height: size, channels: 4 } })
    .png()
    .toBuffer()
}

export const solidMaster = (size: number, color: Rgb): Promise<Buffer> =>
  sharp({ create: { width: size, height: size, channels: 3, background: { r: color[0], g: color[1], b: color[2] } } })
    .png()
    .toBuffer()

/** Straight RGBA pixels of a PNG. */
export async function rawPixels(png: Uint8Array): Promise<{ data: Buffer; width: number; height: number }> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height }
}

export type Pixels = Awaited<ReturnType<typeof rawPixels>>

export const pixelAt = ({ data, width }: Pixels, x: number, y: number): [number, number, number, number] => {
  const i = (y * width + x) * 4
  return [data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0, data[i + 3] ?? 0]
}

/** The PNG bytes of one chunk of an ICNS container, by OSType. */
export function icnsChunk(icns: Uint8Array, type: string): Buffer {
  const bytes = Buffer.from(icns)
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset + 4)
    if (bytes.toString('ascii', offset, offset + 4) === type) return bytes.subarray(offset + 8, offset + length)
    offset += length
  }
  throw new Error(`no ${type} chunk`)
}

/** The PNG bytes of the ICO frame of `size` px. */
export function icoFrame(ico: Uint8Array, size: number): Buffer {
  const bytes = Buffer.from(ico)
  for (let i = 0; i < bytes.readUInt16LE(4); i++) {
    const entry = 6 + i * 16
    if ((bytes[entry] ?? 0) !== size) continue
    return bytes.subarray(
      bytes.readUInt32LE(entry + 12),
      bytes.readUInt32LE(entry + 12) + bytes.readUInt32LE(entry + 8),
    )
  }
  throw new Error(`no ${size}px ico frame`)
}

export const maxChannelDelta = (a: readonly number[], b: readonly number[]): number =>
  Math.max(...[0, 1, 2].map((i) => Math.abs((a[i] ?? 0) - (b[i] ?? 0))))

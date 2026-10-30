import { inflateSync } from 'node:zlib'

export type ImageFormat = 'png' | 'jpeg' | 'webp'

/** The first bytes of a file in `format`: image-gateway's `magicBytesValid`, the check that a generated body is the image it claims to be. */
export function magicBytesValid(bytes: Uint8Array, format: ImageFormat): boolean {
  switch (format) {
    case 'png':
      return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    case 'jpeg':
      return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    case 'webp':
      return (
        bytes[0] === 0x52 && // "RIFF"
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x46 &&
        bytes[8] === 0x57 && // "WEBP"
        bytes[9] === 0x45 &&
        bytes[10] === 0x42 &&
        bytes[11] === 0x50
      )
  }
}

export const MIME: Record<ImageFormat, string> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' }

/** The format of an input image by its magic bytes (never by its name), or null when it is none of the three the endpoints take. */
export function sniffFormat(bytes: Uint8Array): ImageFormat | null {
  for (const format of ['png', 'jpeg', 'webp'] as const) if (magicBytesValid(bytes, format)) return format
  return null
}

export interface PngInfo {
  width: number
  height: number
  /** Whether the file carries an alpha channel: colour type 4 or 6, or a palette with a `tRNS` chunk. Says nothing about a pixel being transparent. */
  hasAlpha: boolean
}

const be32 = (b: Uint8Array, at: number) =>
  (b[at] ?? 0) * 2 ** 24 + (((b[at + 1] ?? 0) << 16) | ((b[at + 2] ?? 0) << 8) | (b[at + 3] ?? 0))
const chunkType = (b: Uint8Array, at: number) =>
  String.fromCharCode(b[at] ?? 0, b[at + 1] ?? 0, b[at + 2] ?? 0, b[at + 3] ?? 0)

/** Width, height and alpha from the header chunks; null when the bytes are not a PNG with a valid `IHDR` first. */
export function readPng(bytes: Uint8Array): PngInfo | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (bytes.length < 33 || signature.some((v, i) => bytes[i] !== v)) return null
  if (be32(bytes, 8) !== 13 || chunkType(bytes, 12) !== 'IHDR') return null
  const width = be32(bytes, 16)
  const height = be32(bytes, 20)
  if (width === 0 || height === 0) return null
  const colorType = bytes[25]
  let hasAlpha = colorType === 4 || colorType === 6
  if (colorType === 3) {
    // Chunks follow IHDR (8 + 25 bytes in); `tRNS` precedes the first IDAT.
    for (let at = 33; at + 8 <= bytes.length;) {
      const type = chunkType(bytes, at + 4)
      if (type === 'tRNS') hasAlpha = true
      if (type === 'IDAT' || type === 'IEND') break
      at += 12 + be32(bytes, at)
    }
  }
  return { width, height, hasAlpha }
}

/** The bytes as a PNG: unchanged when they already are one, otherwise re-encoded (a recraft cutout arrives as WebP). EXIF orientation is applied. */
export async function toPng(bytes: Uint8Array): Promise<Uint8Array> {
  if (magicBytesValid(bytes, 'png')) return bytes
  return new Bun.Image(bytes, { maxPixels: 64_000_000 }).png({ compressionLevel: 9 }).bytes()
}

export interface AlphaStats {
  width: number
  height: number
  /** Pixels with alpha below full opacity. */
  translucent: number
  /** Pixels at full opacity. */
  opaque: number
  hasAlphaChannel: boolean
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

/** `null`: not decodable (corrupt). `'unsupported'`: valid but interlaced or below 8 bits per sample. */
function alphaStatsSync(bytes: Uint8Array): AlphaStats | null | 'unsupported' {
  const info = readPng(bytes)
  if (!info) return null
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const depth = bytes[24] ?? 0
  const colorType = bytes[25] ?? 0
  const channels = CHANNELS[colorType]
  if (!channels || bytes[28] === 1 || depth < 8 || depth > 16 || (colorType === 3 && depth !== 8)) return 'unsupported'
  const idat: Buffer[] = []
  let trns: Uint8Array = new Uint8Array()
  for (let at = 33; at + 8 <= view.length;) {
    const length = view.readUInt32BE(at)
    const type = view.toString('latin1', at + 4, at + 8)
    if (at + 12 + length > view.length) return null
    if (type === 'IDAT') idat.push(view.subarray(at + 8, at + 8 + length))
    else if (type === 'tRNS') trns = view.subarray(at + 8, at + 8 + length)
    else if (type === 'IEND') break
    at += 12 + length
  }
  let raw: Buffer
  try {
    raw = inflateSync(Buffer.concat(idat))
  } catch {
    return null
  }
  const bytesPerPixel = (channels * depth) / 8
  const stride = info.width * bytesPerPixel
  if (raw.length !== info.height * (stride + 1)) return null
  const pixels = Buffer.alloc(info.height * stride)
  const bpp = Math.max(1, bytesPerPixel)
  for (let y = 0; y < info.height; y++) {
    const filter = raw[y * (stride + 1)] ?? 0
    const src = y * (stride + 1) + 1
    const row = y * stride
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? (pixels[row + x - bpp] ?? 0) : 0
      const b = y > 0 ? (pixels[row - stride + x] ?? 0) : 0
      const c = y > 0 && x >= bpp ? (pixels[row - stride + x - bpp] ?? 0) : 0
      const v = raw[src + x] ?? 0
      let predictor: number
      if (filter === 0) predictor = 0
      else if (filter === 1) predictor = a
      else if (filter === 2) predictor = b
      else if (filter === 3) predictor = (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      } else return null
      pixels[row + x] = (v + predictor) & 255
    }
  }
  const hasAlphaChannel = colorType === 4 || colorType === 6 || (colorType === 3 && trns.length > 0)
  let translucent = 0
  const total = info.width * info.height
  if (hasAlphaChannel) {
    for (let i = 0; i < total; i++) {
      const at = i * bytesPerPixel
      let full: boolean
      if (colorType === 3) full = (trns[pixels[at] ?? 0] ?? 255) === 255
      else {
        const offset = at + (channels - 1) * (depth / 8)
        full = depth === 8 ? pixels[offset] === 255 : pixels[offset] === 255 && pixels[offset + 1] === 255
      }
      if (!full) translucent++
    }
  }
  return { width: info.width, height: info.height, translucent, opaque: total - translucent, hasAlphaChannel }
}

/**
 * How much of a PNG is transparent, from its decoded pixels (an alpha channel alone says nothing: recraft's "transparent"
 * background can come back at alpha 1, and a model can paint a fake checkerboard). Null when the PNG does not decode. An
 * interlaced or sub-byte-depth PNG is re-encoded once by `Bun.Image` (pixel-capped) and read from that.
 */
export async function decodeAlphaStats(bytes: Uint8Array): Promise<AlphaStats | null> {
  const direct = alphaStatsSync(bytes)
  if (direct !== 'unsupported') return direct
  try {
    const plain = await new Bun.Image(bytes, { maxPixels: 64_000_000 }).png().bytes()
    const again = alphaStatsSync(plain)
    return again === 'unsupported' ? null : again
  } catch {
    return null
  }
}

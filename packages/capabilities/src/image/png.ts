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
    for (let at = 33; at + 8 <= bytes.length; ) {
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
  return new Bun.Image(bytes).png({ compressionLevel: 9 }).bytes()
}

import { type ImageFormat, magicBytesValid, readPng } from './png.ts'

export interface ImageHeader {
  format: ImageFormat
  /** As stored, before any EXIF rotation. */
  width: number
  height: number
  /** EXIF orientation 1-8 (JPEG only; 1 when absent). 5-8 swap the displayed width and height. */
  orientation: number
}

const be16 = (b: Uint8Array, at: number) => ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0)
const le16 = (b: Uint8Array, at: number) => (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8)
const le24 = (b: Uint8Array, at: number) => (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8) | ((b[at + 2] ?? 0) << 16)
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])

/** Orientation from an APP1 `Exif` segment whose data starts at `at` (the TIFF header is 6 bytes in); null when the segment is not Exif (an XMP APP1, say). */
function exifOrientation(b: Uint8Array, at: number, end: number): number | null {
  const tiff = at + 6
  if (b[at] !== 0x45 || b[at + 1] !== 0x78 || b[at + 2] !== 0x69 || b[at + 3] !== 0x66) return null
  const little = b[tiff] === 0x49
  const u16 = (p: number) => (little ? le16(b, p) : be16(b, p))
  const u32 = (p: number) => (little ? le16(b, p) + le16(b, p + 2) * 65536 : be16(b, p) * 65536 + be16(b, p + 2))
  const ifd = tiff + u32(tiff + 4)
  if (ifd + 2 > end) return 1
  const count = u16(ifd)
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12
    if (entry + 12 > end) break
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 8)
      return value >= 1 && value <= 8 ? value : 1
    }
  }
  return 1
}

function jpegHeader(b: Uint8Array): ImageHeader | null {
  let orientation = 1
  let seenExif = false
  let pos = 2
  while (pos + 4 <= b.length) {
    if (b[pos] !== 0xff) return null
    const marker = b[pos + 1] ?? 0
    if (marker === 0xff) {
      pos++
      continue
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      pos += 2
      continue
    }
    const length = be16(b, pos + 2)
    if (length < 2) return null
    if (SOF.has(marker)) {
      const height = be16(b, pos + 5)
      const width = be16(b, pos + 7)
      return width > 0 && height > 0 ? { format: 'jpeg', width, height, orientation } : null
    }
    if (marker === 0xda) return null
    // Only an Exif APP1 sets the orientation, and the first one wins: a later XMP APP1 must not reset it.
    if (marker === 0xe1 && !seenExif) {
      const found = exifOrientation(b, pos + 4, pos + 2 + length)
      if (found !== null) {
        orientation = found
        seenExif = true
      }
    }
    pos += 2 + length
  }
  return null
}

function webpHeader(b: Uint8Array): ImageHeader | null {
  const kind = String.fromCharCode(b[12] ?? 0, b[13] ?? 0, b[14] ?? 0, b[15] ?? 0)
  let width = 0
  let height = 0
  if (kind === 'VP8 ') {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null
    width = le16(b, 26) & 0x3fff
    height = le16(b, 28) & 0x3fff
  } else if (kind === 'VP8L') {
    if (b[20] !== 0x2f) return null
    width = 1 + ((b[21] ?? 0) | (((b[22] ?? 0) & 0x3f) << 8))
    height = 1 + (((b[22] ?? 0) >> 6) | ((b[23] ?? 0) << 2) | (((b[24] ?? 0) & 0x0f) << 10))
  } else if (kind === 'VP8X') {
    width = 1 + le24(b, 24)
    height = 1 + le24(b, 27)
  } else return null
  return width > 0 && height > 0 ? { format: 'webp', width, height, orientation: 1 } : null
}

/**
 * Format, size and EXIF orientation from the file's header alone, without decoding a pixel: a crafted header that claims
 * 60000x60000 is refused on these numbers before anything allocates for it. Null when the header is not one of the
 * three formats' or does not parse.
 */
export function readHeader(bytes: Uint8Array): ImageHeader | null {
  if (magicBytesValid(bytes, 'png')) {
    const png = readPng(bytes)
    return png ? { format: 'png', width: png.width, height: png.height, orientation: 1 } : null
  }
  if (magicBytesValid(bytes, 'jpeg')) return jpegHeader(bytes)
  if (magicBytesValid(bytes, 'webp')) return webpHeader(bytes)
  return null
}

/** The displayed size: EXIF orientations 5-8 swap the stored width and height. */
export const displayedSize = (h: ImageHeader) =>
  h.orientation >= 5 ? { width: h.height, height: h.width } : { width: h.width, height: h.height }

/**
 * Hand-written icon containers. sharp encodes neither .ico nor .icns, and both formats are thin
 * wrappers around verbatim PNG bytes, so these are pure functions over already-encoded PNGs.
 */

export interface IcoFrame {
  /** Edge length in pixels (square frames only). */
  size: number
  png: Uint8Array
}

const ICO_HEADER_BYTES = 6
const ICO_ENTRY_BYTES = 16

/**
 * ICO with PNG frames. Layout, little-endian: ICONDIR (reserved u16=0, type u16=1, count u16),
 * N x 16-byte ICONDIRENTRY, then the PNG payloads verbatim. A width/height byte of 0 means 256.
 */
export function encodeIco(frames: IcoFrame[]): Buffer {
  if (frames.length === 0) throw new Error('ICO needs at least one frame')

  const total =
    ICO_HEADER_BYTES + ICO_ENTRY_BYTES * frames.length + frames.reduce((sum, frame) => sum + frame.png.byteLength, 0)
  const out = Buffer.alloc(total)
  out.writeUInt16LE(0, 0)
  out.writeUInt16LE(1, 2)
  out.writeUInt16LE(frames.length, 4)

  let offset = ICO_HEADER_BYTES + ICO_ENTRY_BYTES * frames.length
  frames.forEach((frame, i) => {
    if (frame.size < 1 || frame.size > 256) {
      throw new Error(`ICO frame size must be 1-256, got ${frame.size}`)
    }
    const entry = ICO_HEADER_BYTES + ICO_ENTRY_BYTES * i
    const dimension = frame.size === 256 ? 0 : frame.size
    out.writeUInt8(dimension, entry) // width
    out.writeUInt8(dimension, entry + 1) // height
    out.writeUInt8(0, entry + 2) // colorCount
    out.writeUInt8(0, entry + 3) // reserved
    out.writeUInt16LE(1, entry + 4) // planes
    out.writeUInt16LE(32, entry + 6) // bitCount
    out.writeUInt32LE(frame.png.byteLength, entry + 8) // bytesInRes
    out.writeUInt32LE(offset, entry + 12) // imageOffset
    out.set(frame.png, offset)
    offset += frame.png.byteLength
  })
  return out
}

export interface IcnsChunk {
  /** Four-character OSType, e.g. `ic07`. */
  type: string
  png: Uint8Array
}

/**
 * The PNG-bearing ICNS OSTypes and the pixel edge each carries. `ic11`-`ic14` are the @2x variants
 * (16@2x = 32px, ...); the pairs that share a pixel size (icp5/ic11, ic13/ic08, ic14/ic09) reuse
 * one PNG. The higher codes come from secondary sources and are proven by the darwin-only
 * `iconutil` round-trip in image-icon-containers.test.ts.
 */
export const ICNS_TYPES = [
  { type: 'icp4', size: 16 },
  { type: 'icp5', size: 32 },
  { type: 'ic11', size: 32 },
  { type: 'ic12', size: 64 },
  { type: 'ic07', size: 128 },
  { type: 'ic13', size: 256 },
  { type: 'ic08', size: 256 },
  { type: 'ic14', size: 512 },
  { type: 'ic09', size: 512 },
  { type: 'ic10', size: 1024 },
] as const

/** The distinct pixel edges ICNS_TYPES needs rendered. */
export const ICNS_SIZES: readonly number[] = [...new Set(ICNS_TYPES.map((entry) => entry.size))]

const ICNS_HEADER_BYTES = 8

/**
 * ICNS container: `icns` magic + big-endian u32 total length, then chunks of 4-byte OSType +
 * big-endian u32 chunk length (INCLUDING the 8-byte chunk header) + raw PNG bytes.
 */
export function encodeIcns(chunks: IcnsChunk[]): Buffer {
  const total = chunks.reduce((sum, chunk) => sum + ICNS_HEADER_BYTES + chunk.png.byteLength, 8)
  const out = Buffer.alloc(total)
  out.write('icns', 0, 'ascii')
  out.writeUInt32BE(total, 4)

  let offset = ICNS_HEADER_BYTES
  for (const chunk of chunks) {
    if (chunk.type.length !== 4) throw new Error(`ICNS type must be 4 chars, got "${chunk.type}"`)
    out.write(chunk.type, offset, 'ascii')
    out.writeUInt32BE(ICNS_HEADER_BYTES + chunk.png.byteLength, offset + 4)
    out.set(chunk.png, offset + ICNS_HEADER_BYTES)
    offset += ICNS_HEADER_BYTES + chunk.png.byteLength
  }
  return out
}

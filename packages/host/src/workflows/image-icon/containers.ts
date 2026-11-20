/**
 * Hand-written icon containers. sharp encodes neither .ico nor .icns, and both formats are thin
 * wrappers around verbatim PNG bytes (bar the ICNS 16 and 32 px ARGB entries), so these are pure functions.
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
  /** The chunk body: verbatim PNG bytes, or the output of `encodeIcnsArgb` for `ic04`/`ic05`. */
  data: Uint8Array
}

/**
 * The ICNS OSTypes and the pixel edge each carries, in the order `iconutil -c icns` writes them.
 * `ic07`-`ic14` hold PNG; `ic11`-`ic14` are the @2x variants (16@2x = 32px, ...) and the pairs that share a
 * pixel size (ic13/ic08, ic14/ic09) reuse one PNG. The 16 and 32 px (1x) entries are `ic04` and `ic05`
 * carrying run-length-encoded ARGB: macOS does not decode a PNG under `icp4`/`icp5` and draws noise.
 * The codes are proven by the darwin-only `iconutil` round-trip in image-icon-containers.test.ts, which
 * compares the extracted pixels.
 */
export const ICNS_TYPES = [
  { type: 'ic12', size: 64, format: 'png' },
  { type: 'ic07', size: 128, format: 'png' },
  { type: 'ic13', size: 256, format: 'png' },
  { type: 'ic08', size: 256, format: 'png' },
  { type: 'ic04', size: 16, format: 'argb' },
  { type: 'ic14', size: 512, format: 'png' },
  { type: 'ic09', size: 512, format: 'png' },
  { type: 'ic05', size: 32, format: 'argb' },
  { type: 'ic10', size: 1024, format: 'png' },
  { type: 'ic11', size: 32, format: 'png' },
] as const

/** The distinct pixel edges ICNS_TYPES needs rendered. */
export const ICNS_SIZES: readonly number[] = [...new Set(ICNS_TYPES.map((entry) => entry.size))]

const ICNS_HEADER_BYTES = 8
const ARGB_MAGIC = 'ARGB'
const RLE_MAX_LITERAL = 128
const RLE_MIN_RUN = 3
const RLE_MAX_RUN = 130

/**
 * PackBits-style run-length encoding of one channel: a byte below 0x80 is followed by that many + 1
 * literal bytes, a byte from 0x80 on is followed by one byte repeated (byte - 125) times (3 to 130).
 */
function rleChannel(channel: Uint8Array): number[] {
  const out: number[] = []
  let literalStart = 0
  const flushLiterals = (end: number) => {
    for (let from = literalStart; from < end; from += RLE_MAX_LITERAL) {
      const to = Math.min(from + RLE_MAX_LITERAL, end)
      out.push(to - from - 1)
      for (let i = from; i < to; i++) out.push(channel[i] as number)
    }
  }

  let i = 0
  while (i < channel.length) {
    let run = 1
    while (i + run < channel.length && run < RLE_MAX_RUN && channel[i + run] === channel[i]) run++
    if (run < RLE_MIN_RUN) {
      i += run
      continue
    }
    flushLiterals(i)
    out.push(run + 125, channel[i] as number)
    i += run
    literalStart = i
  }
  flushLiterals(channel.length)
  return out
}

/**
 * The body of an `ic04`/`ic05` chunk from straight-alpha RGBA: `ARGB`, then the alpha, red, green and blue
 * planes, each run-length encoded on its own, one after the other. The colour planes are premultiplied by
 * alpha, as `iconutil` writes them (macOS divides alpha out again on read). One zero byte follows the last
 * plane: macOS' reader never consumes the final byte of the chunk, so without it the last run or literal
 * byte of the blue plane decodes as 0.
 */
export function encodeIcnsArgb(rgba: Uint8Array, size: number): Buffer {
  const pixels = size * size
  if (rgba.byteLength !== pixels * 4) {
    throw new Error(`ARGB needs ${pixels * 4} RGBA bytes for ${size}px, got ${rgba.byteLength}`)
  }
  const parts: number[] = [...Buffer.from(ARGB_MAGIC, 'ascii')]
  for (const offset of [3, 0, 1, 2]) {
    const plane = new Uint8Array(pixels)
    for (let p = 0; p < pixels; p++) {
      const value = rgba[p * 4 + offset] as number
      plane[p] = offset === 3 ? value : Math.round((value * (rgba[p * 4 + 3] as number)) / 255)
    }
    for (const byte of rleChannel(plane)) parts.push(byte)
  }
  parts.push(0)
  return Buffer.from(parts)
}

/**
 * ICNS container: `icns` magic + big-endian u32 total length, then chunks of 4-byte OSType +
 * big-endian u32 chunk length (INCLUDING the 8-byte chunk header) + the chunk body.
 */
export function encodeIcns(chunks: IcnsChunk[]): Buffer {
  const total = chunks.reduce((sum, chunk) => sum + ICNS_HEADER_BYTES + chunk.data.byteLength, 8)
  const out = Buffer.alloc(total)
  out.write('icns', 0, 'ascii')
  out.writeUInt32BE(total, 4)

  let offset = ICNS_HEADER_BYTES
  for (const chunk of chunks) {
    if (chunk.type.length !== 4) throw new Error(`ICNS type must be 4 chars, got "${chunk.type}"`)
    out.write(chunk.type, offset, 'ascii')
    out.writeUInt32BE(ICNS_HEADER_BYTES + chunk.data.byteLength, offset + 4)
    out.set(chunk.data, offset + ICNS_HEADER_BYTES)
    offset += ICNS_HEADER_BYTES + chunk.data.byteLength
  }
  return out
}

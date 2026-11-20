import { stat } from 'node:fs/promises'
import { WorkflowError } from '@agent-workflows/runtime'
import sharp from 'sharp'

/** The largest source image accepted (image-gateway `ICONS_LIMITS.maxImageBytes`). */
export const MAX_SOURCE_BYTES = 20 * 1024 * 1024

/** An SVG is rasterised to this long edge before any pipeline sees it; a larger source pixel count is `invalid_input`. */
export const SVG_RASTER_EDGE = 1024

/** Caller bytes decode only up to this many pixels (sharp's own default is 268 MP). */
const SOURCE_MAX_PIXELS = 64_000_000

/** sharp renders an SVG at its own size at 72 dpi; the density that gets `SVG_RASTER_EDGE` is capped so a 1 px SVG cannot ask for a huge canvas. */
const SVG_MAX_DENSITY = 10_000

export type SourceKind = 'png' | 'jpeg' | 'webp' | 'svg'

export interface ImageSource {
  kind: SourceKind
  bytes: Uint8Array
}

const MAGIC: Record<Exclude<SourceKind, 'svg'>, (b: Uint8Array) => boolean> = {
  png: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  jpeg: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  webp: (b) =>
    Buffer.from(b.subarray(0, 4)).toString('latin1') === 'RIFF' &&
    Buffer.from(b.subarray(8, 12)).toString('latin1') === 'WEBP',
}

/** An XML prolog (declaration, comments, doctype, whitespace) and then an `<svg` root, within the first 4 KiB. */
const SVG_HEAD = /^\uFEFF?(?:\s|<\?xml[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>)*<svg[\s>]/i

export const isSvg = (bytes: Uint8Array): boolean =>
  SVG_HEAD.test(Buffer.from(bytes.subarray(0, 4096)).toString('utf8'))

/** The kind of an image by its first bytes, or null. */
export function sniffKind(bytes: Uint8Array): SourceKind | null {
  for (const [kind, matches] of Object.entries(MAGIC)) if (matches(bytes)) return kind as SourceKind
  return isSvg(bytes) ? 'svg' : null
}

/** A regular file within the size limit that is a PNG, JPEG, WebP or SVG by its first bytes. */
export async function readImageSource(path: string): Promise<ImageSource> {
  const info = await stat(path).catch(() => null)
  if (!info?.isFile()) throw new WorkflowError('invalid_input', `no such file: ${path}`)
  if (info.size > MAX_SOURCE_BYTES) {
    throw new WorkflowError('invalid_input', `image is ${info.size} bytes, over the ${MAX_SOURCE_BYTES} byte limit`)
  }
  const bytes = await Bun.file(path).bytes()
  const kind = sniffKind(bytes)
  if (!kind) throw new WorkflowError('invalid_input', `image must be png, jpeg, webp or svg: ${path}`)
  return { kind, bytes }
}

/** An SVG as a PNG with a transparent ground, its long edge `edge` px: rendered from the vectors at that size, not scaled after. */
export async function rasterizeSvg(svg: Uint8Array, edge = SVG_RASTER_EDGE): Promise<Buffer> {
  try {
    const { width, height } = await sharp(svg, { limitInputPixels: SOURCE_MAX_PIXELS }).metadata()
    if (!width || !height) throw new Error('the SVG has no size')
    const density = Math.min(SVG_MAX_DENSITY, (72 * edge) / Math.max(width, height))
    return await sharp(svg, { density, limitInputPixels: SOURCE_MAX_PIXELS })
      .resize(edge, edge, { fit: 'inside' })
      .png()
      .toBuffer()
  } catch (err) {
    throw new WorkflowError('invalid_input', `unreadable svg: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    })
  }
}

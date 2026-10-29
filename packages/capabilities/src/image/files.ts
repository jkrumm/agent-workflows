import { isAbsolute } from 'node:path'
import { fail } from '../errors.ts'
import { type ImageFormat, sniffFormat } from './png.ts'

export interface InputImage {
  path: string
  bytes: Uint8Array<ArrayBuffer>
  format: ImageFormat
}

/** Upstream limits for the edit path (image-gateway `EDIT_LIMITS`): 16 references, 50 MB each. */
export const MAX_EDIT_IMAGES = 16
export const MAX_EDIT_IMAGE_BYTES = 50 * 1024 * 1024

/**
 * An input image from a path on this host. The file must exist, be a regular file within `maxBytes`, and be a PNG, JPEG
 * or WebP by its first bytes; anything else is `INVALID_INPUT` before a request is made. Paths are absolute: a relative
 * one means nothing to a host process.
 */
export async function readInputImage(path: string, maxBytes: number): Promise<InputImage> {
  if (!isAbsolute(path)) throw fail('INVALID_INPUT', `image path must be absolute: ${path}`)
  const file = Bun.file(path)
  const stat = await file.stat().catch(() => null)
  if (!stat?.isFile()) throw fail('INVALID_INPUT', `no such file: ${path}`)
  const { size } = stat
  if (size > maxBytes) throw fail('INVALID_INPUT', `image is ${size} bytes, over the ${maxBytes} byte limit: ${path}`)
  const bytes = new Uint8Array(await file.arrayBuffer())
  const format = sniffFormat(bytes)
  if (!format) throw fail('INVALID_INPUT', `image must be png, jpeg or webp: ${path}`)
  return { path, bytes, format }
}

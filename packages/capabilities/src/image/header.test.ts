import { describe, expect, test } from 'bun:test'
import { displayedSize, readHeader } from './header.ts'
import { decodeAlphaStats } from './png.ts'
import { type PngFilter, pngFixture, webpFixture } from './testing.ts'

const u16 = (n: number) => [(n >> 8) & 255, n & 255]

/** A JPEG that is only headers: SOI, optional EXIF orientation, SOF0 claiming `width` x `height`. No pixel data. */
function jpegHeaderOnly(width: number, height: number, orientation?: number) {
  const exif =
    orientation === undefined
      ? []
      : [
          0xff,
          0xe1,
          ...u16(2 + 6 + 8 + 2 + 12 + 4),
          0x45,
          0x78,
          0x69,
          0x66,
          0,
          0,
          0x4d,
          0x4d,
          0,
          0x2a,
          0,
          0,
          0,
          8,
          0,
          1,
          0x01,
          0x12,
          0,
          3,
          0,
          0,
          0,
          1,
          ...u16(orientation),
          0,
          0,
          0,
          0,
          0,
          0,
        ]
  return new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0,
    4,
    0,
    0,
    ...exif,
    0xff,
    0xc0,
    0,
    17,
    8,
    ...u16(height),
    ...u16(width),
    3,
    1,
    0x22,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1,
    0xff,
    0xd9,
  ])
}

/** An XMP APP1 segment: an APP1 that is not Exif. */
const xmp = () => {
  const body = [...new TextEncoder().encode('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>')]
  return [0xff, 0xe1, ...u16(2 + body.length), ...body]
}
const withSegments = (jpeg: Uint8Array, ...segments: number[][]) =>
  new Uint8Array([0xff, 0xd8, ...segments.flat(), ...jpeg.slice(2)])
const exifOf = (orientation: number) => [
  0xff,
  0xe1,
  ...u16(2 + 6 + 8 + 2 + 12 + 4),
  0x45,
  0x78,
  0x69,
  0x66,
  0,
  0,
  0x4d,
  0x4d,
  0,
  0x2a,
  0,
  0,
  0,
  8,
  0,
  1,
  0x01,
  0x12,
  0,
  3,
  0,
  0,
  0,
  1,
  ...u16(orientation),
  0,
  0,
  0,
  0,
  0,
  0,
]

describe('image headers', () => {
  test('only an Exif APP1 sets the orientation, and the first one wins: a following XMP APP1 does not reset it', () => {
    const base = jpegHeaderOnly(300, 200)
    expect(readHeader(withSegments(base, exifOf(6), xmp()))?.orientation).toBe(6)
    expect(readHeader(withSegments(base, xmp(), exifOf(8)))?.orientation).toBe(8)
    expect(readHeader(withSegments(base, exifOf(3), exifOf(6)))?.orientation).toBe(3)
    expect(readHeader(withSegments(base, xmp()))?.orientation).toBe(1)
  })

  test('a JPEG that claims a huge canvas is read from its header alone', () => {
    expect(readHeader(jpegHeaderOnly(60_000, 50_000))).toEqual({
      format: 'jpeg',
      width: 60_000,
      height: 50_000,
      orientation: 1,
    })
  })

  test('EXIF orientation 5-8 swaps the displayed size', () => {
    const header = readHeader(jpegHeaderOnly(300, 200, 6))
    expect(header).toMatchObject({ width: 300, height: 200, orientation: 6 })
    expect(displayedSize(header as NonNullable<typeof header>)).toEqual({ width: 200, height: 300 })
    expect(readHeader(jpegHeaderOnly(300, 200, 3))?.orientation).toBe(3)
  })

  test('a real JPEG from the encoder reads back', async () => {
    const jpeg = await new Bun.Image(pngFixture(120, 80, { kind: 'rgb' })).jpeg({ quality: 80 }).bytes()
    expect(readHeader(jpeg)).toEqual({ format: 'jpeg', width: 120, height: 80, orientation: 1 })
  })

  test('PNG and WebP', async () => {
    expect(readHeader(pngFixture(33, 17))).toEqual({ format: 'png', width: 33, height: 17, orientation: 1 })
    expect(readHeader(await webpFixture(64, 48))).toEqual({ format: 'webp', width: 64, height: 48, orientation: 1 })
    const lossy = await new Bun.Image(pngFixture(64, 48, { kind: 'rgb' })).webp({ quality: 70 }).bytes()
    expect(readHeader(lossy)).toMatchObject({ format: 'webp', width: 64, height: 48 })
  })

  test('truncated or foreign bytes have no header', () => {
    expect(readHeader(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4]))).toBeNull()
    expect(readHeader(pngFixture(8, 8).slice(0, 20))).toBeNull()
    expect(readHeader(new TextEncoder().encode('GIF89a not an image'))).toBeNull()
  })
})

describe('alpha statistics from decoded pixels', () => {
  const half = (x: number) => (x < 20 ? 0 : 255)

  test('every PNG row filter decodes, and the counts are exact', async () => {
    for (const filter of [0, 1, 2, 3, 4] as PngFilter[]) {
      const stats = await decodeAlphaStats(pngFixture(40, 10, { alphaAt: half, filter }))
      expect(stats, `filter ${filter}`).toEqual({
        width: 40,
        height: 10,
        translucent: 200,
        opaque: 200,
        hasAlphaChannel: true,
      })
    }
  })

  test('an RGB PNG has no alpha channel and is all opaque', async () => {
    expect(await decodeAlphaStats(pngFixture(16, 16, { kind: 'rgb', filter: 4 }))).toEqual({
      width: 16,
      height: 16,
      translucent: 0,
      opaque: 256,
      hasAlphaChannel: false,
    })
  })

  test('a palette with tRNS reads its table', async () => {
    expect(await decodeAlphaStats(pngFixture(8, 8, { kind: 'palette', alpha: 128 }))).toMatchObject({
      translucent: 64,
      opaque: 0,
      hasAlphaChannel: true,
    })
    expect(await decodeAlphaStats(pngFixture(8, 8, { kind: 'palette', alpha: 255 }))).toMatchObject({
      translucent: 0,
      opaque: 64,
    })
  })

  test('alpha 254 counts as below full opacity, 255 does not', async () => {
    expect(await decodeAlphaStats(pngFixture(10, 10, { alpha: 254 }))).toMatchObject({ translucent: 100, opaque: 0 })
  })

  test('a corrupt PNG does not decode', async () => {
    const png = pngFixture(16, 16)
    const cut = png.slice(0, png.length - 40)
    expect(await decodeAlphaStats(cut)).toBeNull()
    expect(await decodeAlphaStats(new TextEncoder().encode('not a png at all, not at all, not at all'))).toBeNull()
  })
})

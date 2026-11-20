import { describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { decodeArgb, premultiply } from './support/icns.ts'
import {
  encodeIco,
  encodeIcns,
  encodeIcnsArgb,
  ICNS_SIZES,
  ICNS_TYPES,
} from '../src/workflows/image-icon/containers.ts'

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47]
const MAX_MEAN_DIFF = 2

function solidPng(size: number): Promise<Buffer> {
  return sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: { r: 200, g: 30, b: 30, alpha: 1 },
    },
  })
    .png()
    .toBuffer()
}

/** A non-uniform image with transparent, translucent and opaque bands and a gradient: noise or a swapped channel cannot pass for it. */
function patternPng(size: number): Promise<Buffer> {
  const rgba = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      rgba[i] = Math.round((x / size) * 255)
      rgba[i + 1] = Math.round((y / size) * 255)
      rgba[i + 2] = x < size / 2 ? 40 : 220
      rgba[i + 3] = y < size / 4 ? 0 : y < size / 2 ? 128 : 255
    }
  }
  return sharp(rgba, { raw: { width: size, height: size, channels: 4 } })
    .png()
    .toBuffer()
}

async function rawRgba(image: string | Buffer): Promise<Buffer> {
  return sharp(image).ensureAlpha().raw({ depth: 'uchar' }).toBuffer()
}

function meanAbsDiff(a: Buffer, b: Buffer): number {
  if (a.length !== b.length) return Number.POSITIVE_INFINITY
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += Math.abs((a[i] as number) - (b[i] as number))
  return sum / a.length
}

describe('encodeIco', () => {
  test('writes ICONDIR, entries and verbatim PNG frames', async () => {
    const sizes = [16, 32, 48]
    const frames = await Promise.all(sizes.map(async (size) => ({ size, png: await solidPng(size) })))
    const ico = encodeIco(frames)

    expect(ico.readUInt16LE(0)).toBe(0)
    expect(ico.readUInt16LE(2)).toBe(1)
    expect(ico.readUInt16LE(4)).toBe(3)

    let expectedOffset = 6 + 16 * 3
    frames.forEach((frame, i) => {
      const entry = 6 + 16 * i
      expect(ico.readUInt8(entry)).toBe(frame.size)
      expect(ico.readUInt8(entry + 1)).toBe(frame.size)
      expect(ico.readUInt8(entry + 2)).toBe(0)
      expect(ico.readUInt8(entry + 3)).toBe(0)
      expect(ico.readUInt16LE(entry + 4)).toBe(1)
      expect(ico.readUInt16LE(entry + 6)).toBe(32)
      expect(ico.readUInt32LE(entry + 8)).toBe(frame.png.byteLength)
      const offset = ico.readUInt32LE(entry + 12)
      expect(offset).toBe(expectedOffset)
      expect([...ico.subarray(offset, offset + 4)]).toEqual(PNG_MAGIC)
      expect(ico.subarray(offset, offset + frame.png.byteLength).equals(frame.png)).toBe(true)
      expectedOffset += frame.png.byteLength
    })
    expect(ico.byteLength).toBe(expectedOffset)
  })

  test('encodes a 256px frame as dimension byte 0', async () => {
    const ico = encodeIco([{ size: 256, png: await solidPng(256) }])
    expect(ico.readUInt8(6)).toBe(0)
    expect(ico.readUInt8(7)).toBe(0)
  })

  test('rejects an empty frame list and oversized frames', async () => {
    expect(() => encodeIco([])).toThrow()
    expect(() => encodeIco([{ size: 512, png: new Uint8Array(8) }])).toThrow()
  })
})

describe('encodeIcns', () => {
  test('writes magic, total length and walkable chunks', async () => {
    const chunks = [
      { type: 'ic12', data: await solidPng(64) },
      { type: 'ic07', data: await solidPng(128) },
    ]
    const icns = encodeIcns(chunks)

    expect(icns.subarray(0, 4).toString('ascii')).toBe('icns')
    expect(icns.readUInt32BE(4)).toBe(icns.byteLength)

    let offset = 8
    for (const chunk of chunks) {
      expect(icns.subarray(offset, offset + 4).toString('ascii')).toBe(chunk.type)
      const length = icns.readUInt32BE(offset + 4)
      expect(length).toBe(8 + chunk.data.byteLength)
      expect(icns.subarray(offset + 8, offset + length).equals(chunk.data)).toBe(true)
      offset += length
    }
    expect(offset).toBe(icns.byteLength)
  })

  test('rejects a type that is not four characters', () => {
    expect(() => encodeIcns([{ type: 'abc', data: new Uint8Array(1) }])).toThrow()
  })

  // macOS' own iconutil is the ground truth for the OSTypes and the ARGB body: it must hand back the pixels.
  test.skipIf(process.platform !== 'darwin')(
    'round-trips through iconutil into the 10 iconset files with the rendered pixels',
    async () => {
      const bySize = new Map(await Promise.all(ICNS_SIZES.map(async (size) => [size, await patternPng(size)] as const)))
      const icns = encodeIcns(
        await Promise.all(
          ICNS_TYPES.map(async ({ type, size, format }) => {
            const png = bySize.get(size) as Buffer
            return { type, data: format === 'argb' ? encodeIcnsArgb(await rawRgba(png), size) : png }
          }),
        ),
      )

      const dir = await mkdtemp(join(tmpdir(), 'icns-'))
      try {
        const icnsPath = join(dir, 'AppIcon.icns')
        const iconsetPath = join(dir, 'out.iconset')
        await writeFile(icnsPath, icns)
        const proc = Bun.spawn(['iconutil', '-c', 'iconset', icnsPath, '-o', iconsetPath], {
          stderr: 'pipe',
        })
        const stderr = await new Response(proc.stderr).text()
        expect(await proc.exited, stderr).toBe(0)

        const expected: Record<string, number> = {
          'icon_16x16.png': 16,
          'icon_16x16@2x.png': 32,
          'icon_32x32.png': 32,
          'icon_32x32@2x.png': 64,
          'icon_128x128.png': 128,
          'icon_128x128@2x.png': 256,
          'icon_256x256.png': 256,
          'icon_256x256@2x.png': 512,
          'icon_512x512.png': 512,
          'icon_512x512@2x.png': 1024,
        }
        expect((await readdir(iconsetPath)).toSorted()).toEqual(Object.keys(expected).toSorted())
        for (const [name, size] of Object.entries(expected)) {
          const meta = await sharp(join(iconsetPath, name)).metadata()
          expect([name, meta.width, meta.height]).toEqual([name, size, size])
          // Noise (a PNG under an OSType macOS reads as pixels) differs by ~85 on average.
          const diff = meanAbsDiff(
            premultiply(await rawRgba(join(iconsetPath, name))),
            premultiply(await rawRgba(bySize.get(size) as Buffer)),
          )
          expect([name, diff <= MAX_MEAN_DIFF]).toEqual([name, true])
        }
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
  )
})

describe('encodeIcnsArgb', () => {
  test('writes the ARGB magic and decodes back to the same RGBA, runs and literals alike', async () => {
    const size = 32
    const rgba = await rawRgba(await patternPng(size))
    const body = encodeIcnsArgb(rgba, size)
    expect(body.subarray(0, 4).toString('ascii')).toBe('ARGB')
    expect(decodeArgb(body, size).equals(premultiply(rgba))).toBe(true)
  })

  test('splits runs past 130 and literals past 128 bytes', () => {
    const size = 32
    const flat = Buffer.alloc(size * size * 4, 7)
    expect(decodeArgb(encodeIcnsArgb(flat, size), size).equals(premultiply(flat))).toBe(true)
    const noisy = Buffer.from(Array.from({ length: size * size * 4 }, (_, i) => (i * 37 + (i >> 3)) % 251))
    expect(decodeArgb(encodeIcnsArgb(noisy, size), size).equals(premultiply(noisy))).toBe(true)
  })

  test('rejects a buffer that is not size x size RGBA', () => {
    expect(() => encodeIcnsArgb(new Uint8Array(10), 16)).toThrow()
  })
})

import { describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { encodeIco, encodeIcns, ICNS_SIZES, ICNS_TYPES } from '../src/workflows/image-icon/containers.ts'

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47]

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
      { type: 'icp4', png: await solidPng(16) },
      { type: 'ic07', png: await solidPng(128) },
    ]
    const icns = encodeIcns(chunks)

    expect(icns.subarray(0, 4).toString('ascii')).toBe('icns')
    expect(icns.readUInt32BE(4)).toBe(icns.byteLength)

    let offset = 8
    for (const chunk of chunks) {
      expect(icns.subarray(offset, offset + 4).toString('ascii')).toBe(chunk.type)
      const length = icns.readUInt32BE(offset + 4)
      expect(length).toBe(8 + chunk.png.byteLength)
      expect(icns.subarray(offset + 8, offset + length).equals(chunk.png)).toBe(true)
      offset += length
    }
    expect(offset).toBe(icns.byteLength)
  })

  test('rejects a type that is not four characters', () => {
    expect(() => encodeIcns([{ type: 'abc', png: new Uint8Array(1) }])).toThrow()
  })

  // The ic09-ic14 OSTypes come from secondary sources; macOS' own iconutil is the ground truth.
  test.skipIf(process.platform !== 'darwin')(
    'round-trips through iconutil into the 10 iconset files at the right pixel sizes',
    async () => {
      const bySize = new Map(await Promise.all(ICNS_SIZES.map(async (size) => [size, await solidPng(size)] as const)))
      const icns = encodeIcns(ICNS_TYPES.map(({ type, size }) => ({ type, png: bySize.get(size) as Buffer })))

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
        }
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
  )
})

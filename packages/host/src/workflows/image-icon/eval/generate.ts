// fallow-ignore-file unused-file -- run by hand (`bun packages/host/src/workflows/image-icon/eval/generate.ts`) and by the fixture test.
import { join } from 'node:path'
import sharp from 'sharp'

/**
 * The synthetic master images of the `image-icon` eval set: a yellow disc, on an opaque navy ground or on a transparent
 * one. Drawn from arithmetic alone, so the committed PNGs are reproducible and carry nothing but geometry.
 */
export interface Fixture {
  name: string
  size: number
  ground: 'opaque' | 'transparent'
}

export const FIXTURES: readonly Fixture[] = [
  { name: 'disc-opaque-64.png', size: 64, ground: 'opaque' },
  { name: 'disc-opaque-256.png', size: 256, ground: 'opaque' },
  { name: 'disc-opaque-512.png', size: 512, ground: 'opaque' },
  { name: 'disc-transparent-128.png', size: 128, ground: 'transparent' },
  { name: 'disc-transparent-512.png', size: 512, ground: 'transparent' },
]

const DISC = [250, 204, 21, 255] as const
const NAVY = [15, 23, 42, 255] as const
const CLEAR = [0, 0, 0, 0] as const

/** The fixture's pixels, straight RGBA: a disc of 0.35 of the side, centred. */
export function pixels({ size, ground }: Fixture): Buffer {
  const data = Buffer.alloc(size * size * 4)
  const centre = (size - 1) / 2
  const radius = size * 0.35
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const inside = (x - centre) ** 2 + (y - centre) ** 2 <= radius ** 2
      data.set(inside ? DISC : ground === 'opaque' ? NAVY : CLEAR, (y * size + x) * 4)
    }
  }
  return data
}

export const encode = (fixture: Fixture): Promise<Buffer> =>
  sharp(pixels(fixture), { raw: { width: fixture.size, height: fixture.size, channels: 4 } })
    .png({ compressionLevel: 9 })
    .toBuffer()

if (import.meta.main) {
  for (const fixture of FIXTURES) await Bun.write(join(import.meta.dir, fixture.name), await encode(fixture))
}

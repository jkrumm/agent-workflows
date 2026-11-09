import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import sharp from 'sharp'
import { renderCard, wrapText } from '../src/workflows/image-icon/card.ts'
import { iconsHtml, MASKABLE_BOX, renderRasters, smallTargetMaster } from '../src/workflows/image-icon/pipeline.ts'
import { detectTile } from '../src/workflows/image-icon/tile.ts'
import {
  discMaster,
  icnsChunk,
  icoFrame,
  maxChannelDelta,
  type Pixels,
  pixelAt,
  rawPixels,
  solidMaster,
  tileMaster,
} from './image-icon-fixtures.ts'

const TILE: [number, number, number] = [26, 43, 76]
const TILE_HEX = '#1a2b4c'
const GOLDEN_SOURCE = join(import.meta.dir, 'fixtures', 'image-icon', 'source.png')

const asset = (assets: Awaited<ReturnType<typeof renderRasters>>, name: string) => {
  const found = assets.find((a) => a.name === name)
  if (!found) throw new Error(name)
  return found
}

const corners = (pixels: Pixels, block: number): [number, number][] => {
  const far = pixels.width - block
  return [
    [0, 0],
    [far, 0],
    [0, pixels.height - block],
    [far, pixels.height - block],
  ]
}

function expectCornerBlocks(pixels: Pixels, color: readonly number[], tolerance: number) {
  for (const [left, top] of corners(pixels, 12)) {
    for (let y = top; y < top + 12; y++) {
      for (let x = left; x < left + 12; x++) {
        const px = pixelAt(pixels, x, y)
        expect(px[3]).toBe(255)
        expect(maxChannelDelta(px, color)).toBeLessThanOrEqual(tolerance)
      }
    }
  }
}

describe('detectTile', () => {
  test('a rounded tile is detected with its bbox and the colour at its edges', async () => {
    const tile = await detectTile(await tileMaster({ size: 1024, side: 896 }))
    expect(tile).not.toBeNull()
    expect([tile?.left, tile?.top, tile?.width, tile?.height, tile?.side]).toEqual([64, 64, 896, 896, 896])
    expect(maxChannelDelta(tile?.edgeColor ?? [0, 0, 0], TILE)).toBeLessThanOrEqual(1)
    expect(tile?.crop).toEqual({ left: 62, top: 62, width: 900, height: 900 })
  })

  test('a disc, an opaque square, the golden glyph and a light glyph are no tile', async () => {
    expect(await detectTile(await discMaster({ color: [200, 30, 30] }))).toBeNull()
    expect(await detectTile(await solidMaster(512, TILE))).toBeNull()
    expect(await detectTile(Buffer.from(await Bun.file(GOLDEN_SOURCE).bytes()))).toBeNull()
    expect(await detectTile(await discMaster({ color: [255, 255, 255] }))).toBeNull()
  })
})

describe('full-bleed targets of a tile master', () => {
  for (const background of [TILE_HEX, undefined]) {
    test(`corners are the tile colour and no tile edge remains (${background ?? 'no background'})`, async () => {
      const assets = await renderRasters(await tileMaster(), background)
      for (const name of ['apple-touch-icon.png', 'icon-1024.png', 'icon-mask.png']) {
        const pixels = await rawPixels(asset(assets, name).bytes)
        expectCornerBlocks(pixels, TILE, 3)
        if (name === 'icon-mask.png') continue
        const ring = Math.round(pixels.width * 0.06)
        for (let y = 0; y < pixels.height; y++) {
          for (let x = 0; x < pixels.width; x++) {
            if (x >= ring && x < pixels.width - ring && y >= ring && y < pixels.height - ring) continue
            expect(maxChannelDelta(pixelAt(pixels, x, y), TILE)).toBeLessThanOrEqual(3)
          }
        }
      }
    })
  }

  test('a gradient tile bleeds along its gradient: corners stay near the colour of their row', async () => {
    const gradient: [[number, number, number], [number, number, number]] = [
      [16, 32, 63],
      [42, 74, 140],
    ]
    const assets = await renderRasters(await tileMaster({ gradient }))
    for (const name of ['apple-touch-icon.png', 'icon-1024.png']) {
      const pixels = await rawPixels(asset(assets, name).bytes)
      const mid = Math.floor(pixels.width / 2)
      for (const y of [0, pixels.height - 1]) {
        for (const x of [0, pixels.width - 1]) {
          expect(maxChannelDelta(pixelAt(pixels, x, y), pixelAt(pixels, mid, y))).toBeLessThanOrEqual(12)
        }
      }
    }
  })

  test('an explicit background other than the tile colour fills the corners with it', async () => {
    const assets = await renderRasters(await tileMaster(), '#ff0000')
    const pixels = await rawPixels(asset(assets, 'apple-touch-icon.png').bytes)
    expect(maxChannelDelta(pixelAt(pixels, 0, 0), [255, 0, 0])).toBeLessThanOrEqual(3)
  })

  test('the maskable keeps big art inside the 409 px safe zone', async () => {
    const assets = await renderRasters(await tileMaster({ glyphRadius: 440 }), TILE_HEX)
    const pixels = await rawPixels(asset(assets, 'icon-mask.png').bytes)
    const low = (512 - MASKABLE_BOX) / 2 - 2
    const high = 512 - low
    let art = 0
    for (let y = 0; y < 512; y++) {
      for (let x = 0; x < 512; x++) {
        const px = pixelAt(pixels, x, y)
        if (Math.hypot(px[0] - TILE[0], px[1] - TILE[1], px[2] - TILE[2]) <= 40) continue
        art++
        expect(x).toBeGreaterThanOrEqual(low)
        expect(x).toBeLessThanOrEqual(high)
        expect(y).toBeGreaterThanOrEqual(low)
        expect(y).toBeLessThanOrEqual(high)
      }
    }
    expect(art).toBeGreaterThan(10_000)
  })

  test('icon-192 and icon-512 keep the tile with its own transparent corners', async () => {
    const assets = await renderRasters(await tileMaster(), TILE_HEX)
    const pixels = await rawPixels(asset(assets, 'icon-512.png').bytes)
    expect(pixelAt(pixels, 0, 0)[3]).toBe(0)
    expect(pixelAt(pixels, 256, 40)[3]).toBe(255)
  })
})

describe('AppIcon.icns', () => {
  test('a tile master sits on the macOS grid with a soft shadow', async () => {
    const assets = await renderRasters(await tileMaster({ side: 896 }))
    const pixels = await rawPixels(icnsChunk(asset(assets, 'AppIcon.icns').bytes, 'ic10'))
    expect([pixels.width, pixels.height]).toEqual([1024, 1024])
    const row = 512
    for (let x = 0; x < 40; x++) expect(pixelAt(pixels, x, row)[3]).toBe(0)
    const opaque = Array.from({ length: 1024 }, (_, x) => x).filter((x) => pixelAt(pixels, x, row)[3] >= 250)
    expect(Math.abs((opaque[0] ?? -99) - 100)).toBeLessThanOrEqual(3)
    expect(Math.abs((opaque.at(-1) ?? -99) - 923)).toBeLessThanOrEqual(3)
    const below = Array.from({ length: 36 }, (_, i) => pixelAt(pixels, 512, 925 + i)[3])
    expect(below.some((alpha) => alpha >= 1 && alpha <= 120)).toBe(true)
    for (const [x, y] of [
      [0, 0],
      [1023, 0],
      [0, 1023],
      [1023, 1023],
    ] as const) {
      expect(pixelAt(pixels, x, y)[3]).toBe(0)
    }
  })

  test('a master without a tile keeps the 0.1 margin and gets no shadow', async () => {
    const assets = await renderRasters(await discMaster({ size: 400, radius: 200, color: [200, 30, 30] }))
    const pixels = await rawPixels(icnsChunk(asset(assets, 'AppIcon.icns').bytes, 'ic10'))
    const opaque = Array.from({ length: 1024 }, (_, x) => x).filter((x) => pixelAt(pixels, x, 512)[3] >= 250)
    expect(Math.abs((opaque[0] ?? -99) - 103)).toBeLessThanOrEqual(3)
    expect(pixelAt(pixels, 512, 940)[3]).toBe(0)
  })
})

describe('the small targets', () => {
  test('a flat source drives the ico frames instead of the master', async () => {
    const master = await discMaster({ color: [200, 30, 30] })
    const small = await discMaster({ color: [20, 160, 60] })
    const assets = await renderRasters(master, '#ffffff', { small })
    const frame = await rawPixels(icoFrame(asset(assets, 'favicon.ico').bytes, 48))
    expect(maxChannelDelta(pixelAt(frame, 24, 24), [20, 160, 60])).toBeLessThanOrEqual(2)
    const own = await rawPixels(icoFrame((await renderRasters(master, '#ffffff')).at(0)?.bytes ?? Buffer.alloc(0), 48))
    expect(maxChannelDelta(pixelAt(own, 24, 24), [200, 30, 30])).toBeLessThanOrEqual(2)
  })

  test('a white glyph on transparency gets a dark rounded backing; the glyph stays', async () => {
    const backed = await rawPixels(
      await smallTargetMaster(await discMaster({ size: 400, radius: 150, color: [255, 255, 255] })),
    )
    expect(pixelAt(backed, 0, 0)[3]).toBe(0)
    expect(pixelAt(backed, 200, 20)).toEqual([17, 24, 39, 255])
    expect(maxChannelDelta(pixelAt(backed, 200, 200), [255, 255, 255])).toBeLessThanOrEqual(1)
    expect(pixelAt(backed, 200, 200)[3]).toBe(255)
  })

  test('an explicit dark background becomes the backing colour, a light one does not', async () => {
    const glyph = await discMaster({ size: 400, radius: 150, color: [255, 255, 255] })
    const dark = await rawPixels(await smallTargetMaster(glyph, '#0b1020'))
    expect(pixelAt(dark, 200, 20)).toEqual([11, 16, 32, 255])
    const light = await rawPixels(await smallTargetMaster(glyph, '#f0f0f0'))
    expect(pixelAt(light, 200, 20)).toEqual([17, 24, 39, 255])
  })

  test('a dark glyph, a tile and the golden light-blue glyph pass through unchanged', async () => {
    const dark = await discMaster({ color: [20, 20, 20] })
    expect(await smallTargetMaster(dark)).toBe(dark)
    const tile = await tileMaster({ glyph: [255, 255, 255], color: [250, 250, 250] })
    expect(await smallTargetMaster(tile)).toBe(tile)
    const golden = Buffer.from(await Bun.file(GOLDEN_SOURCE).bytes())
    expect(await smallTargetMaster(golden)).toBe(golden)
  })
})

describe('the social card', () => {
  const countDiffering = (pixels: Pixels, from: [number, number], to: [number, number], bg: readonly number[]) => {
    let count = 0
    for (let y = from[1]; y < to[1]; y++) {
      for (let x = from[0]; x < to[0]; x++) if (maxChannelDelta(pixelAt(pixels, x, y), bg) > 20) count++
    }
    return count
  }

  test('renders 1200x630 on the background with the icon left and the text right', async () => {
    const master = await tileMaster()
    const tile = await detectTile(master)
    const bytes = await renderCard({
      master,
      tile,
      background: '#336699',
      title: 'Hello world',
      line: 'A line of text',
    })
    const meta = await sharp(bytes).metadata()
    expect([meta.format, meta.width, meta.height]).toEqual(['png', 1200, 630])
    const pixels = await rawPixels(bytes)
    expect(maxChannelDelta(pixelAt(pixels, 2, 2), [51, 102, 153])).toBeLessThanOrEqual(1)
    expect(countDiffering(pixels, [96, 135], [456, 495], [51, 102, 153])).toBeGreaterThan(1000)
    expect(countDiffering(pixels, [520, 100], [1104, 530], [51, 102, 153])).toBeGreaterThanOrEqual(200)
  })

  test('the background defaults to the tile colour, else white, with text coloured for contrast', async () => {
    const master = await tileMaster()
    const onTile = await rawPixels(await renderCard({ master, tile: await detectTile(master), title: 'T' }))
    expect(maxChannelDelta(pixelAt(onTile, 2, 2), TILE)).toBeLessThanOrEqual(2)
    const glyph = await discMaster({ color: [200, 30, 30] })
    const onWhite = await rawPixels(await renderCard({ master: glyph, tile: null, title: 'Title' }))
    expect(pixelAt(onWhite, 2, 2)).toEqual([255, 255, 255, 255])
    expect(countDiffering(onWhite, [520, 100], [1104, 530], [255, 255, 255])).toBeGreaterThanOrEqual(200)
  })

  test('long text wraps within the line limits and ends in an ellipsis', () => {
    expect(wrapText('one two three four', 8, 5)).toEqual(['one two', 'three', 'four'])
    expect(wrapText('aaa bbb ccc ddd eee', 7, 2)).toEqual(['aaa bbb', 'ccc dd…'])
    expect(wrapText('abcdefghij', 4, 5)).toEqual(['abcd', 'efgh', 'ij'])
  })

  test('head tags exist only with a card and escape their values', () => {
    expect(iconsHtml(true, undefined)).toBe(iconsHtml(true))
    expect(iconsHtml(false)).not.toContain('og:')
    const html = iconsHtml(true, { title: 'A & B <c> "d"', line: 'x < y' })
    expect(html).toContain('<meta property="og:title" content="A &amp; B &lt;c&gt; &quot;d&quot;">')
    expect(html).toContain('<meta property="og:description" content="x &lt; y">')
    for (const tag of [
      '<meta property="og:image" content="/og-image.png">',
      '<meta property="og:image:width" content="1200">',
      '<meta property="og:image:height" content="630">',
      '<meta name="twitter:card" content="summary_large_image">',
      '<meta name="twitter:image" content="/og-image.png">',
    ]) {
      expect(html).toContain(tag)
    }
    expect(html.startsWith(iconsHtml(true))).toBe(true)
    expect(iconsHtml(true, { title: 'T' })).not.toContain('og:description')
  })
})

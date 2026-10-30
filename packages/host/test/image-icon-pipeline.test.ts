import { describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { WorkflowError } from '@agent-workflows/runtime'
import sharp from 'sharp'
import {
  assertCutoutReachable,
  buildMaster,
  CUTOUT_INPUT_MAX_EDGE,
  cleanVectorized,
  decodeRgba,
  encodePng,
  ICONS_MANIFEST,
  iconsHtml,
  lacksTransparency,
  MASKABLE_BOX,
  prepareCutoutInput,
  type Rgba,
  renderRasters,
  SVG_MAX_BYTES,
  UPSCALE_MAX_INPUT_EDGE,
  upscaleScale,
  vectorizeInput,
} from '../src/workflows/image-icon/pipeline.ts'

const SIZE = 600

const blank = (width: number, height: number): Rgba => ({
  data: Buffer.alloc(width * height * 4),
  width,
  height,
})

/** A red disc (radius 200) centred in a SIZE square on the given background pixel. */
function disc(background: [number, number, number, number]): Rgba {
  const data = Buffer.alloc(SIZE * SIZE * 4)
  const c = SIZE / 2
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const inside = (x - c) ** 2 + (y - c) ** 2 <= 200 ** 2
      data.set(inside ? [220, 30, 30, 255] : background, (y * SIZE + x) * 4)
    }
  }
  return { data, width: SIZE, height: SIZE }
}

const solid = (width: number, height: number, format: 'png' | 'jpeg' | 'webp'): Promise<Buffer> =>
  sharp({ create: { width, height, channels: 3, background: { r: 10, g: 120, b: 200 } } })
    .toFormat(format)
    .toBuffer()

/** A valid, flat 1-bit PNG of `width` x `height`: a few KB on disk, a decompression bomb for the decoder. */
function bombPng(width: number, height: number): Buffer {
  const u32 = (n: number) => Buffer.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255])
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    return Buffer.concat([u32(data.length), body, u32(Bun.hash.crc32(body))])
  }
  const rows = Buffer.alloc(height * (Math.ceil(width / 8) + 1))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', Buffer.concat([u32(width), u32(height), Buffer.from([1, 0, 0, 0, 0])])),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const rejectsInvalidInput = async (promise: Promise<unknown>, message?: RegExp): Promise<void> => {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(WorkflowError)
  expect((err as WorkflowError).kind).toBe('invalid_input')
  if (message) expect((err as WorkflowError).message).toMatch(message)
}

async function rgba(png: Buffer): Promise<Rgba> {
  return decodeRgba(png)
}

describe('decodeRgba', () => {
  test('decodes to 4 channels, including a grayscale image', async () => {
    const gray = await sharp(Buffer.alloc(SIZE * SIZE, 128), { raw: { width: SIZE, height: SIZE, channels: 1 } })
      .png()
      .toBuffer()
    const decoded = await decodeRgba(gray)
    expect([decoded.width, decoded.height, decoded.data.length]).toEqual([SIZE, SIZE, SIZE * SIZE * 4])
    expect(decoded.data[3]).toBe(255)
  })

  test('garbage bytes are invalid_input', async () => {
    await rejectsInvalidInput(decodeRgba(new Uint8Array([1, 2, 3])), /^unreadable image/)
  })

  test('an image declaring more than 64 MP is refused as invalid_input, quickly, before any pixel is read', async () => {
    const started = performance.now()
    await rejectsInvalidInput(decodeRgba(bombPng(12_000, 12_000)), /^unreadable image: .*exceeds pixel limit/i)
    expect(performance.now() - started).toBeLessThan(2000)
  })
})

describe('lacksTransparency', () => {
  test('is true only when every pixel alpha is >= 250', () => {
    expect(lacksTransparency(Buffer.from([1, 2, 3, 255, 4, 5, 6, 250]))).toBe(true)
    expect(lacksTransparency(Buffer.from([1, 2, 3, 255, 4, 5, 6, 249]))).toBe(false)
  })
})

describe('assertCutoutReachable', () => {
  const opaque = (width: number, height: number): Rgba => ({
    data: Buffer.alloc(width * height * 4, 255),
    width,
    height,
  })

  test('an opaque 16 px image whose 8x upscale (128 px) is under the 256 px cutout minimum is refused, naming both', () => {
    const run = () => assertCutoutReachable({ rgba: opaque(16, 16), scale: 8, cutout: 'auto' })
    expect(run).toThrow(WorkflowError)
    expect(run).toThrow(/at least 256px .* 128px after the upscale; use --cutout never or a larger source/)
  })

  test('the short edge counts, with no upscale it is the source edge, and always applies to a transparent image too', () => {
    expect(() => assertCutoutReachable({ rgba: opaque(2000, 100), scale: null, cutout: 'always' })).toThrow(/100px/)
    expect(() => assertCutoutReachable({ rgba: blank(100, 100), scale: null, cutout: 'always' })).toThrow(/100px/)
  })

  test('passes when no cutout is needed or the edge reaches 256 px', () => {
    assertCutoutReachable({ rgba: opaque(16, 16), scale: 8, cutout: 'never' })
    assertCutoutReachable({ rgba: blank(16, 16), scale: 8, cutout: 'auto' })
    assertCutoutReachable({ rgba: opaque(64, 64), scale: 4, cutout: 'auto' })
    assertCutoutReachable({ rgba: opaque(300, 300), scale: null, cutout: 'always' })
  })
})

describe('upscaleScale', () => {
  const edge = (long: number): Rgba => ({ data: Buffer.alloc(0), width: long, height: 10 })

  test('auto: 8x under 128, 4x from 128 up to 511, skipped from 512', () => {
    expect(upscaleScale('auto', edge(127))).toBe(8)
    expect(upscaleScale('auto', edge(128))).toBe(4)
    expect(upscaleScale('auto', edge(511))).toBe(4)
    expect(upscaleScale('auto', edge(512))).toBeNull()
  })

  test('uses the long edge, whichever side it is', () => {
    expect(upscaleScale('auto', { data: Buffer.alloc(0), width: 10, height: 127 })).toBe(8)
  })

  test('never always skips', () => {
    expect(upscaleScale('never', edge(10))).toBeNull()
    expect(upscaleScale('never', edge(5000))).toBeNull()
  })

  test('always upscales even a large-enough input, up to 1440 px', () => {
    expect(upscaleScale('always', edge(512))).toBe(4)
    expect(upscaleScale('always', edge(UPSCALE_MAX_INPUT_EDGE))).toBe(4)
    expect(upscaleScale('always', edge(100))).toBe(8)
  })

  test('always refuses beyond 1440 px with invalid_input', () => {
    expect(UPSCALE_MAX_INPUT_EDGE).toBe(1440)
    let err: unknown
    try {
      upscaleScale('always', edge(1441))
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(WorkflowError)
    expect((err as WorkflowError).kind).toBe('invalid_input')
    expect((err as WorkflowError).message).toContain('1441px')
  })

  test('auto never reaches the limit check for a large image', () => {
    expect(upscaleScale('auto', edge(2000))).toBeNull()
  })
})

describe('encodePng', () => {
  test('round-trips the raw pixels', async () => {
    const source = disc([0, 0, 0, 0])
    const back = await decodeRgba(await encodePng(source))
    expect([back.width, back.height]).toEqual([SIZE, SIZE])
    expect(back.data.equals(source.data)).toBe(true)
  })
})

describe('prepareCutoutInput', () => {
  test('passes a conforming PNG through byte-for-byte', async () => {
    const png = await solid(300, 300, 'png')
    expect((await prepareCutoutInput(png)).equals(png)).toBe(true)
  })

  test('converts jpeg and webp to PNG', async () => {
    for (const format of ['jpeg', 'webp'] as const) {
      const out = await prepareCutoutInput(await solid(300, 300, format))
      expect([format, (await sharp(out).metadata()).format]).toEqual([format, 'png'])
    }
  })

  test('downscales to maxEdge, keeping the aspect ratio', async () => {
    const out = await prepareCutoutInput(await solid(2000, 1000, 'png'), { maxEdge: 1000 })
    const meta = await sharp(out).metadata()
    expect([meta.width, meta.height]).toEqual([1000, 500])
    expect(CUTOUT_INPUT_MAX_EDGE).toBe(1536)
  })

  test('rejects sides under 256, over 4096, and unreadable bytes with invalid_input', async () => {
    await rejectsInvalidInput(prepareCutoutInput(await solid(255, 400, 'png')), /at least 256px/)
    await rejectsInvalidInput(prepareCutoutInput(await solid(4097, 300, 'png')), /at most 4096px/)
    await rejectsInvalidInput(prepareCutoutInput(new Uint8Array([1, 2, 3])), /^unreadable image/)
  })

  test('an image declaring more than 64 MP is refused as invalid_input by the metadata read', async () => {
    await rejectsInvalidInput(prepareCutoutInput(bombPng(12_000, 12_000)), /^unreadable image: .*pixel limit/i)
  })

  test('rejects images above 16 megapixels', async () => {
    await rejectsInvalidInput(prepareCutoutInput(await solid(4096, 4000, 'png')), /16000000 pixels/)
  })

  test('rejects an output above 5 MB', async () => {
    // Incompressible noise, 1800x1800: ~9.7 MB as RGB PNG, within every other limit.
    const side = 1800
    const noise = randomBytes(side * side * 3)
    const png = await sharp(noise, { raw: { width: side, height: side, channels: 3 } })
      .png({ compressionLevel: 1 })
      .toBuffer()
    await rejectsInvalidInput(prepareCutoutInput(png), /at most 5242880 bytes/)
  })
})

describe('buildMaster', () => {
  test('an all-transparent image fails with invalid_input', async () => {
    await rejectsInvalidInput(buildMaster(blank(SIZE, SIZE)), /no visible content/)
  })

  test('near-transparent pixels (recraft alpha=1) count as empty', async () => {
    const faint = blank(8, 8)
    for (let i = 3; i < faint.data.length; i += 4) faint.data[i] = 7
    await rejectsInvalidInput(buildMaster(faint), /no visible content/)
    const quirky = disc([255, 255, 255, 1])
    const master = await rgba(await buildMaster(quirky))
    // The disc is trimmed to its bounds, so the quirky margin is gone and the corner is transparent.
    expect(master.width).toBe(master.height)
    expect(master.data[3]).toBe(0)
    expect(master.width).toBeLessThan(SIZE)
  })

  test('the master is square: a non-square subject is centred on a transparent square', async () => {
    // 600x200 red bar on transparent: trimmed to 600x200, padded to a 600 square.
    const bar = blank(SIZE, SIZE)
    for (let y = 200; y < 400; y++) for (let x = 0; x < SIZE; x++) bar.data.set([220, 30, 30, 255], (y * SIZE + x) * 4)
    const master = await rgba(await buildMaster(bar))
    expect([master.width, master.height]).toEqual([SIZE, SIZE])
    const alphaAt = (y: number): number => master.data[(y * master.width + master.width / 2) * 4 + 3] ?? -1
    expect(alphaAt(300)).toBe(255)
    expect(alphaAt(50)).toBe(0)
    expect(alphaAt(550)).toBe(0)
  })

  test('a subject with a side over 8192 px is refused before any canvas is built', async () => {
    // 20000x1000 with two opaque pixels at the far ends: the trimmed subject is 20000 px wide.
    const wide = blank(20_000, 1000)
    wide.data.set([220, 30, 30, 255], 0)
    wide.data.set([220, 30, 30, 255], 19_999 * 4)
    await rejectsInvalidInput(buildMaster(wide), /20000x1\s?px; the square master is at most 8192px a side/)
  })

  test('a subject of exactly 8192 px on its long side is still built', async () => {
    const edge = blank(8192, 4)
    edge.data.set([220, 30, 30, 255], 0)
    edge.data.set([220, 30, 30, 255], 8191 * 4)
    const meta = await sharp(await buildMaster(edge)).metadata()
    expect([meta.width, meta.height]).toEqual([8192, 8192])
  })

  test('an odd-sized subject still yields an exactly square master', async () => {
    const odd = blank(31, 20)
    for (let y = 3; y < 10; y++) for (let x = 4; x < 25; x++) odd.data.set([1, 2, 3, 255], (y * 31 + x) * 4)
    const master = await rgba(await buildMaster(odd))
    expect([master.width, master.height]).toEqual([21, 21])
  })
})

describe('renderRasters', () => {
  const EXPECTED: Record<string, [string, number, number]> = {
    'favicon.ico': ['image/x-icon', 48, 48],
    'icon-192.png': ['image/png', 192, 192],
    'icon-512.png': ['image/png', 512, 512],
    'icon-mask.png': ['image/png', 512, 512],
    'apple-touch-icon.png': ['image/png', 180, 180],
    'icon-1024.png': ['image/png', 1024, 1024],
    'AppIcon.icns': ['image/icns', 1024, 1024],
  }

  const render = async (background: string) => renderRasters(await buildMaster(disc([0, 0, 0, 0])), background)

  test('emits every file in order with its name, mime and size', async () => {
    const files = await render('#ffffff')
    expect(files.map((f) => f.name)).toEqual(Object.keys(EXPECTED))
    for (const file of files) {
      expect([file.name, file.mime, file.width, file.height]).toEqual([file.name, ...(EXPECTED[file.name] ?? [])])
      if (file.name.endsWith('.png')) {
        const meta = await sharp(file.bytes).metadata()
        expect([file.name, meta.width, meta.height]).toEqual([file.name, file.width, file.height])
      }
    }
    expect(files[0]?.bytes.readUInt16LE(4)).toBe(3)
    expect(files[6]?.bytes.subarray(0, 4).toString()).toBe('icns')
  })

  test('transparent targets keep alpha: corners transparent, centre opaque', async () => {
    const files = await render('#ffffff')
    for (const name of ['icon-192.png', 'icon-512.png']) {
      const { data, width } = await rgba(files.find((f) => f.name === name)?.bytes ?? Buffer.alloc(0))
      expect([name, data[3]]).toEqual([name, 0])
      expect([name, data[(width * (width / 2) + width / 2) * 4 + 3]]).toEqual([name, 255])
    }
  })

  test('opaque targets have no transparent pixels', async () => {
    const files = await render('#ffffff')
    for (const name of ['icon-mask.png', 'apple-touch-icon.png', 'icon-1024.png']) {
      const { data } = await rgba(files.find((f) => f.name === name)?.bytes ?? Buffer.alloc(0))
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] !== 255) throw new Error(`${name}: pixel ${(i - 3) / 4} has alpha ${data[i]}`)
      }
    }
  })

  test('the maskable subject stays inside the centered 409px box and fills it', async () => {
    const files = await render('#0000ff')
    const { data, width, height } = await rgba(files.find((f) => f.name === 'icon-mask.png')?.bytes ?? Buffer.alloc(0))
    let minX = width
    let maxX = -1
    let minY = height
    let maxY = -1
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4
        if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 255) continue
        minX = Math.min(minX, x)
        maxX = Math.max(maxX, x)
        minY = Math.min(minY, y)
        maxY = Math.max(maxY, y)
      }
    }
    const margin = Math.floor((512 - MASKABLE_BOX) / 2)
    expect(minX).toBeGreaterThanOrEqual(margin)
    expect(minY).toBeGreaterThanOrEqual(margin)
    expect(maxX).toBeLessThan(margin + MASKABLE_BOX)
    expect(maxY).toBeLessThan(margin + MASKABLE_BOX)
    expect(maxX - minX + 1).toBeGreaterThan(MASKABLE_BOX - 8)
  })
})

describe('vectorizeInput', () => {
  test('is the master on a 1024 canvas with transparent favicon padding', async () => {
    const { data, width, height } = await rgba(await vectorizeInput(await buildMaster(disc([0, 0, 0, 0]))))
    expect([width, height]).toEqual([1024, 1024])
    expect(data[3]).toBe(0)
  })
})

describe('cleanVectorized', () => {
  const ROOT =
    '<svg version="1.1" xmlns="http://www.w3.org/2000/svg" style="display: block;" viewBox="0 0 2048 2048" width="1254" height="1254" preserveAspectRatio="none">'

  test('strips the fixed root size/style and the no-op translate, keeps the viewBox', () => {
    const svg = cleanVectorized(
      `${ROOT}<path transform="translate(0,0)" fill="rgb(220,30,30)" d="M 100 100 L 1900 100 L 1900 1900 Z"/></svg>`,
    )
    const root = svg.match(/<svg\b[^>]*>/)?.[0] ?? ''
    expect(root).toContain('viewBox="0 0 2048 2048"')
    for (const attr of ['width=', 'height=', 'style=', 'preserveAspectRatio=']) {
      expect([attr, root.includes(attr)]).toEqual([attr, false])
    }
    expect(svg).not.toContain('translate(0')
    expect(svg).toContain('<path')
  })

  test('an SVG without a viewBox throws', () => {
    expect(() => cleanVectorized('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>')).toThrow(
      'vectorized SVG has no viewBox',
    )
  })

  const SVG = (inner: string, attrs = '') =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"${attrs}>${inner}<path d="M0 0h8v8z"/></svg>`

  test('scripts, event handlers and javascript: links are removed from the result', () => {
    const dirty = [
      SVG('<script>alert(1)</script>'),
      SVG('', ' onload="alert(1)"'),
      SVG('<path onclick="alert(1)" d="M0 0h1v1z"/>'),
      SVG('<a href="javascript:alert(1)"><path d="M0 0h1v1z"/></a>'),
    ]
    for (const svg of dirty) {
      expect(cleanVectorized(svg)).not.toMatch(/<script|<foreignObject|\son[a-z]+\s*=|javascript:/i)
    }
  })

  test('a foreignObject cannot be cleaned and fails the call', () => {
    const svg = SVG(
      '<foreignObject width="8" height="8"><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>',
    )
    expect(() => cleanVectorized(svg)).toThrow('vectorized SVG contains active content')
  })

  test('the size cap is 64 KB', () => {
    expect(SVG_MAX_BYTES).toBe(64 * 1024)
  })
})

describe('web snippets', () => {
  test('html links the SVG only when it exists; the manifest lists all three icons', () => {
    const without = iconsHtml(false)
    expect(without).toContain('href="/favicon.ico"')
    expect(without).toContain('href="/apple-touch-icon.png"')
    expect(without).toContain('href="/manifest.webmanifest"')
    expect(without).not.toContain('favicon.svg')

    const lines = iconsHtml(true).split('\n')
    expect(lines[0]).toBe('<link rel="icon" href="/favicon.ico" sizes="32x32">')
    expect(lines[1]).toBe('<link rel="icon" href="/favicon.svg" type="image/svg+xml">')

    expect(ICONS_MANIFEST.icons.map((i) => i.src)).toEqual(['/icon-192.png', '/icon-512.png', '/icon-mask.png'])
    expect(ICONS_MANIFEST.icons[2]?.purpose).toBe('maskable')
  })
})

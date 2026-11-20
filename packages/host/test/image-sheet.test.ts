import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { parseLabels, createImageSheetWorkflows } from '../src/workflows/image-sheet/index.ts'
import { CELL_HEIGHT, CELL_WIDTH } from '../src/workflows/image-sheet/render.ts'
import { startTestHost, type TestHost } from './support.ts'

const root = mkdtempSync(join(tmpdir(), 'agw-image-sheet-'))
const artifacts = join(root, 'artifacts')

const GUTTER = 16
const LABEL_BOX = { left: 16, top: 16, width: 320, height: 40 }
/** The ground and the label ink of each ground (render.ts), as RGB. */
const GROUND = { dark: [0x14, 0x16, 0x1a], light: [0xf4, 0xf4, 0xf1] } as const
const INK = { dark: [0xf2, 0xf3, 0xf5], light: [0x16, 0x18, 0x1d] } as const

const text = (value: string) => new Uint8Array(Buffer.from(value))
const solidPng = (size: number, color: string) =>
  sharp({ create: { width: size, height: size, channels: 3, background: color } })
    .png()
    .toBuffer()

const TILE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#1a2b4c"/><circle cx="32" cy="32" r="16" fill="#e8eefc"/></svg>'

const COLORS = ['#c83c28', '#2864c8', '#28c850', '#c8b428']
let files: string[] = []

const write = (name: string, bytes: Uint8Array) => {
  const path = join(root, name)
  writeFileSync(path, bytes)
  return path
}

let t: TestHost
beforeAll(async () => {
  for (const [i, color] of COLORS.entries()) files.push(write(`solid-${i}.png`, await solidPng(300, color)))
  files.push(
    write(
      'wide.jpg',
      await sharp({ create: { width: 400, height: 200, channels: 3, background: '#808080' } })
        .jpeg()
        .toBuffer(),
    ),
  )
  files.push(write('tile-a.svg', text(TILE_SVG)))
  files.push(write('tile-b.svg', text(TILE_SVG.replace('#1a2b4c', '#7a1f3c'))))
  files.push(
    write(
      'small.webp',
      await sharp({ create: { width: 40, height: 40, channels: 4, background: '#00000000' } })
        .webp()
        .toBuffer(),
    ),
  )
  t = await startTestHost({
    prefix: 'imagesheet',
    platform: true,
    extra: createImageSheetWorkflows({ artifacts: { root: artifacts } }),
  })
})
afterAll(async () => {
  await t.close()
  rmSync(root, { recursive: true, force: true })
})

const run = async (body: Record<string, unknown>) =>
  t.json(await t.call('/workflows/image-sheet', { method: 'POST', body, headers: { prefer: 'wait=60' } }))

const rgba = async (path: string | Buffer) => sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true })

const pixel = ({ data, info }: Awaited<ReturnType<typeof rgba>>, x: number, y: number) => [
  ...data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 3),
]

/** Pixels of the label box within a small distance of the ink colour: the glyphs, however the font anti-aliases them. */
async function inkPixels(path: string, ground: 'dark' | 'light', origin = { left: 0, top: 0 }): Promise<number> {
  const { data } = await sharp(path)
    .extract({
      left: origin.left + LABEL_BOX.left,
      top: origin.top + LABEL_BOX.top,
      width: LABEL_BOX.width,
      height: LABEL_BOX.height,
    })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const [r, g, b] = INK[ground]
  let count = 0
  for (let i = 0; i < data.length; i += 3) {
    if (Math.abs((data[i] ?? 0) - r) + Math.abs((data[i + 1] ?? 0) - g) + Math.abs((data[i + 2] ?? 0) - b) < 40) count++
  }
  return count
}

const luminance = ([r, g, b]: readonly number[]) => {
  const channel = (v: number) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r ?? 0) + 0.7152 * channel(g ?? 0) + 0.0722 * channel(b ?? 0)
}
const contrast = (a: readonly number[], b: readonly number[]) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05)
}

describe('image-sheet', () => {
  test('8 mixed png, jpeg, webp and svg inputs give one dark sheet of 4 columns and no cells', async () => {
    expect(files).toHaveLength(8)
    const { status, body } = await run({ files })

    expect(status).toBe(200)
    expect(body).toMatchObject({ workflowId: 'image-sheet', status: 'done' })
    const out = body.output
    expect(out.dir).toBe(join(artifacts, 'image-sheet', body.runId))
    expect(out.cells).toEqual([])
    expect(out.sheets).toHaveLength(1)
    const [sheet] = out.sheets
    expect(sheet).toMatchObject({
      name: 'sheet-dark.png',
      path: join(out.dir, 'sheet-dark.png'),
      mime: 'image/png',
      ground: 'dark',
      width: 4 * CELL_WIDTH + 5 * GUTTER,
      height: 2 * CELL_HEIGHT + 3 * GUTTER,
    })
    const meta = await sharp(sheet.path).metadata()
    expect([meta.width, meta.height, meta.format]).toEqual([sheet.width, sheet.height, 'png'])
    expect(readFileSync(sheet.path).byteLength).toBe(sheet.bytes)
    expect(out.images.map((i: { number: number; kind: string }) => [i.number, i.kind])).toEqual([
      [1, 'png'],
      [2, 'png'],
      [3, 'png'],
      [4, 'png'],
      [5, 'jpeg'],
      [6, 'svg'],
      [7, 'svg'],
      [8, 'webp'],
    ])
    expect(out.images.map((i: { file: string }) => i.file)).toEqual(files)
    // the ground fills the gutters
    expect(pixel(await rgba(sheet.path), 2, 2)).toEqual([...GROUND.dark])
  })

  test('--cells writes one png per image, 8 for 8 inputs, each with a number label that has the contrast to read on the ground', async () => {
    const { body } = await run({ files, cells: true })
    expect(body.status).toBe('done')
    const out = body.output
    expect(out.cells).toHaveLength(8)
    expect(out.cells.map((c: { name: string }) => c.name)).toEqual(
      Array.from({ length: 8 }, (_, i) => `cell-0${i + 1}-dark.png`),
    )
    expect(contrast(INK.dark, GROUND.dark)).toBeGreaterThan(7)
    expect(contrast(INK.light, GROUND.light)).toBeGreaterThan(7)

    const labelled: Buffer[] = []
    for (const [i, cell] of out.cells.entries()) {
      expect(cell).toMatchObject({
        number: i + 1,
        ground: 'dark',
        width: CELL_WIDTH,
        height: CELL_HEIGHT,
        mime: 'image/png',
      })
      expect(existsSync(cell.path)).toBe(true)
      expect((await sharp(cell.path).metadata()).width).toBe(CELL_WIDTH)
      // a glyph is at least a few dozen ink-coloured pixels; the unlabelled ground has none
      expect(await inkPixels(cell.path, 'dark')).toBeGreaterThan(40)
      labelled.push(await sharp(cell.path).extract(LABEL_BOX).png().toBuffer())
    }
    // each number draws its own glyphs
    expect(new Set(labelled.map((b) => b.toString('base64'))).size).toBe(8)
  })

  test('each image sits in its cell at 320, 64, 32 and 16 px, transparency shows the plate', async () => {
    const { body } = await run({
      files: [files[0] as string, files[5] as string, files[7] as string],
      cells: true,
      cols: 3,
    })
    const [red, svg, clear] = await Promise.all(body.output.cells.map((c: { path: string }) => rgba(c.path)))
    if (!red || !svg || !clear) throw new Error('cells missing')
    const top = 16 + 40
    const smallTop = top + 320 + 16
    // the 300 px solid fills the large box and each small copy, centre pixels, bottom-aligned small row
    expect(pixel(red, 16 + 160, top + 160)).toEqual([0xc8, 0x3c, 0x28])
    expect(pixel(red, 16 + 32, smallTop + 32)).toEqual([0xc8, 0x3c, 0x28])
    expect(pixel(red, 96 + 16, smallTop + 32 + 16)).toEqual([0xc8, 0x3c, 0x28])
    expect(pixel(red, 144 + 8, smallTop + 48 + 8)).toEqual([0xc8, 0x3c, 0x28])
    // between the copies is the ground
    expect(pixel(red, 16 + 64 + 8, smallTop + 32)).toEqual([...GROUND.dark])
    // the tile's rounded corner is clear: the plate shows through at the box corner
    expect(pixel(svg, 16 + 2, top + 2)).toEqual([0x1d, 0x20, 0x26])
    expect(pixel(svg, 16 + 160, top + 160)).toEqual([0xe8, 0xee, 0xfc])
    // a fully transparent image is all plate
    expect(pixel(clear, 16 + 160, top + 160)).toEqual([0x1d, 0x20, 0x26])
  })

  test('ground both: a dark and a light sheet, the light one dark ink on light ground; cells for both', async () => {
    const { body } = await run({ files: files.slice(0, 2), ground: 'both', cells: true, cols: 2 })
    const out = body.output
    expect(out.sheets.map((s: { name: string }) => s.name)).toEqual(['sheet-dark.png', 'sheet-light.png'])
    expect(out.cells.map((c: { name: string }) => c.name)).toEqual([
      'cell-01-dark.png',
      'cell-02-dark.png',
      'cell-01-light.png',
      'cell-02-light.png',
    ])
    expect(pixel(await rgba(out.sheets[1].path), 2, 2)).toEqual([...GROUND.light])
    expect(await inkPixels(out.cells[2].path, 'light')).toBeGreaterThan(40)
    // inside the sheet the first cell's label is where the cell file's is
    expect(await inkPixels(out.sheets[1].path, 'light', { left: GUTTER, top: GUTTER })).toBeGreaterThan(40)
  })

  test('--labels adds text after the number; fewer labels than files is fine, more is invalid_input', async () => {
    const plain = await run({ files: files.slice(0, 2), cells: true })
    const named = await run({ files: files.slice(0, 2), cells: true, labels: 'Ember,' })
    expect(named.body.status).toBe('done')
    expect(named.body.output.images.map((i: { label?: string }) => i.label)).toEqual(['Ember', undefined])
    expect(named.body.output.cells.map((c: { label?: string }) => c.label)).toEqual(['Ember', undefined])
    const labelBox = (out: { cells: { path: string }[] }, i: number) =>
      sharp(out.cells[i]?.path).extract(LABEL_BOX).png().toBuffer()
    expect((await labelBox(named.body.output, 0)).equals(await labelBox(plain.body.output, 0))).toBe(false)
    expect((await labelBox(named.body.output, 1)).equals(await labelBox(plain.body.output, 1))).toBe(true)

    const tooMany = await run({ files: files.slice(0, 1), labels: 'a,b' })
    expect(tooMany.body.status).toBe('failed')
    expect(tooMany.body.error.message).toContain('failed (invalid_input)')
    expect(tooMany.body.error.message).toContain('2 labels for 1 files')
  })

  test('the same inputs give the same bytes', async () => {
    const [a, b] = [
      await run({ files, ground: 'both', cells: true }),
      await run({ files, ground: 'both', cells: true }),
    ]
    expect(a.body.runId).not.toBe(b.body.runId)
    const bytes = (out: { sheets: { path: string }[]; cells: { path: string }[] }) =>
      [...out.sheets, ...out.cells].map((f) => readFileSync(f.path).toString('base64'))
    expect(bytes(a.body.output)).toEqual(bytes(b.body.output))
    expect(a.body.output.cells).toHaveLength(16)
  })

  test('invalid input: no file, 25 files, a relative path, a missing file, a non-image', async () => {
    const notImage = write('notes.txt', text('hello'))
    expect((await run({ files: [] })).status).toBe(400)
    expect((await run({ files: Array.from({ length: 25 }, () => files[0]) })).status).toBe(400)
    expect((await run({ files: ['relative/a.png'] })).status).toBe(400)
    expect((await run({ files: files.slice(0, 1), cols: 0 })).status).toBe(400)
    for (const [file, message] of [
      [join(root, 'missing.png'), 'no such file'],
      [notImage, 'image must be png, jpeg, webp or svg'],
    ] as const) {
      const { body } = await run({ files: [files[0], file] })
      expect(body.status).toBe('failed')
      expect(body.error.message).toContain('failed (invalid_input)')
      expect(body.error.message).toContain(message)
    }
  })

  test('parseLabels pads to the file count and trims', () => {
    expect(parseLabels(undefined, 2)).toEqual([undefined, undefined])
    expect(parseLabels(' a , ,c', 4)).toEqual(['a', undefined, 'c', undefined])
  })
})

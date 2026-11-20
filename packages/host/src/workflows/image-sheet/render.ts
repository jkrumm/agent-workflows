import { dirname, join } from 'node:path'
import { createCanvas, GlobalFonts } from '@napi-rs/canvas'
import { WorkflowError } from '@agent-workflows/runtime'
import sharp, { type OverlayOptions } from 'sharp'
import { rasterizeSvg, SOURCE_MAX_PIXELS, type SourceKind } from '../image-source.ts'

/** The sizes every image is shown at: one large, then the three a favicon, a tab and a dock are seen at. */
export const LARGE = 320
export const SMALL_SIZES = [64, 32, 16] as const

const PAD = 16
const LABEL_HEIGHT = 40
const GAP = 16
const GUTTER = 16
export const CELL_WIDTH = LARGE + 2 * PAD
export const CELL_HEIGHT = PAD + LABEL_HEIGHT + LARGE + GAP + SMALL_SIZES[0] + PAD

const LABEL_SIZE = 26
const LABEL_BASELINE = 28
const FONT_ALIAS = 'AgwSheetLabel'

export type Ground = 'light' | 'dark'

/** Dark and light ground, the plate under the large image (so a transparent edge shows), the label ink and the cell outline. */
const GROUNDS: Record<Ground, { fill: string; plate: string; ink: string; edge: string }> = {
  dark: { fill: '#14161a', plate: '#1d2026', ink: '#f2f3f5', edge: '#2c3038' },
  light: { fill: '#f4f4f1', plate: '#e6e6e1', ink: '#16181d', edge: '#cfcfc8' },
}

const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 }

/** A bold face with digits and Latin letters that ships with a host dependency, so a label never depends on the machine's fonts. */
const LABEL_FONT = ['fonts', 'Assistant', 'Assistant-Bold.woff2']

let fontReady = false

function ensureLabelFont(): void {
  if (fontReady) return
  const path = join(dirname(Bun.resolveSync('@excalidraw/excalidraw', import.meta.dir)), ...LABEL_FONT)
  if (!GlobalFonts.registerFromPath(path, FONT_ALIAS)) {
    throw new WorkflowError('error', `the label font could not be registered from ${path}`)
  }
  fontReady = true
}

/** The text that is drawn for cell `number`: the number, then the label when there is one. */
export const cellText = (number: number, label?: string): string => (label ? `${number}  ${label}` : String(number))

/** The label as a transparent PNG the width of a cell's content: the text in the ground's ink, cut with an ellipsis when it is too wide. */
export function labelPng(text: string, ground: Ground): Buffer {
  ensureLabelFont()
  const width = LARGE
  const canvas = createCanvas(width, LABEL_HEIGHT)
  const context = canvas.getContext('2d')
  context.font = `${LABEL_SIZE}px ${FONT_ALIAS}`
  context.fillStyle = GROUNDS[ground].ink
  context.textBaseline = 'alphabetic'
  let drawn = text
  while (drawn.length > 1 && context.measureText(drawn).width > width) drawn = `${drawn.slice(0, -2).trimEnd()}…`
  context.fillText(drawn, 0, LABEL_BASELINE)
  return canvas.toBuffer('image/png')
}

/** One image decoded to a PNG that every size is cut from: an SVG rendered at 1024 px, a raster as it is, EXIF applied. */
export async function decodeForSheet(source: { kind: SourceKind; bytes: Uint8Array }): Promise<Buffer> {
  try {
    if (source.kind === 'svg') return await rasterizeSvg(source.bytes)
    return await sharp(source.bytes, { limitInputPixels: SOURCE_MAX_PIXELS }).rotate().png().toBuffer()
  } catch (err) {
    if (err instanceof WorkflowError) throw err
    throw new WorkflowError('invalid_input', `unreadable image: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    })
  }
}

/** The image fitted into a `size` square, its transparency kept. */
const fitted = (png: Buffer, size: number): Promise<Buffer> =>
  sharp(png).resize(size, size, { fit: 'contain', background: TRANSPARENT, kernel: 'lanczos3' }).png().toBuffer()

const outline = (ground: Ground): Buffer =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CELL_WIDTH}" height="${CELL_HEIGHT}"><rect x="0.5" y="0.5" width="${CELL_WIDTH - 1}" height="${CELL_HEIGHT - 1}" rx="8" fill="none" stroke="${GROUNDS[ground].edge}"/></svg>`,
  )

const solid = (width: number, height: number, color: string) =>
  sharp({ create: { width, height, channels: 3, background: color } })

/** One cell: the number (and label), the image at 320 px on a plate, then the same image at 64, 32 and 16 px. */
export async function renderCell(args: {
  png: Buffer
  number: number
  label?: string
  ground: Ground
}): Promise<Buffer> {
  const { png, number, label, ground } = args
  const colors = GROUNDS[ground]
  const top = PAD + LABEL_HEIGHT
  const smallTop = top + LARGE + GAP
  const plate = await solid(LARGE, LARGE, colors.plate).png().toBuffer()
  const layers: OverlayOptions[] = [
    { input: labelPng(cellText(number, label), ground), left: PAD, top: PAD },
    { input: plate, left: PAD, top },
    { input: await fitted(png, LARGE), left: PAD, top },
  ]
  let left = PAD
  for (const size of SMALL_SIZES) {
    layers.push({ input: await fitted(png, size), left, top: smallTop + SMALL_SIZES[0] - size })
    left += size + GAP
  }
  layers.push({ input: outline(ground), left: 0, top: 0 })
  return solid(CELL_WIDTH, CELL_HEIGHT, colors.fill).composite(layers).png({ compressionLevel: 9 }).toBuffer()
}

/** The sheet: the cells in rows of `cols` on the ground, a gutter all around. */
export async function renderSheet(args: {
  cells: Buffer[]
  cols: number
  ground: Ground
}): Promise<{ bytes: Buffer; width: number; height: number }> {
  const { cells, ground } = args
  const cols = Math.min(args.cols, cells.length)
  const rows = Math.ceil(cells.length / cols)
  const width = cols * CELL_WIDTH + (cols + 1) * GUTTER
  const height = rows * CELL_HEIGHT + (rows + 1) * GUTTER
  const bytes = await solid(width, height, GROUNDS[ground].fill)
    .composite(
      cells.map((input, i) => ({
        input,
        left: GUTTER + (i % cols) * (CELL_WIDTH + GUTTER),
        top: GUTTER + Math.floor(i / cols) * (CELL_HEIGHT + GUTTER),
      })),
    )
    .png({ compressionLevel: 9 })
    .toBuffer()
  return { bytes, width, height }
}

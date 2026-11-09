import sharp from 'sharp'
import { hexRgb, luminance, type Rgb } from './color.ts'
import { faviconIcon } from './pipeline.ts'
import { type TileInfo, tileCrop } from './tile.ts'

export const CARD_WIDTH = 1200
export const CARD_HEIGHT = 630

const ICON_SIZE = 360
const MARGIN = 96
const GAP = 64
const TEXT_X = MARGIN + ICON_SIZE + GAP
const TEXT_WIDTH = CARD_WIDTH - MARGIN - TEXT_X

const TITLE = { size: 64, charWidth: 0.55, maxLines: 2, lineHeight: 74 }
const LINE = { size: 32, charWidth: 0.5, maxLines: 3, lineHeight: 42 }
const BLOCK_GAP = 20
/** Baseline below the line box top, as a fraction of the font size. */
const ASCENT = 0.8

const FONT_FAMILY = 'Helvetica, Arial, sans-serif'
const LIGHT_TEXT = '#ffffff'
const DARK_TEXT = '#111827'
const LIGHT_BACKGROUND_LUMINANCE = 0.5
const LINE_OPACITY = 0.75
const DEFAULT_BACKGROUND: Rgb = [255, 255, 255]

const escapeXml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')

/** Greedy word wrap by a character budget; a word over the budget is split; the last allowed line ends in an ellipsis. */
export function wrapText(text: string, maxChars: number, maxLines: number): string[] {
  const lines: string[] = []
  let current = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    for (let rest = word; rest.length > 0; rest = rest.slice(maxChars)) {
      const piece = rest.slice(0, maxChars)
      if (current === '') current = piece
      else if (current.length + 1 + piece.length <= maxChars) current = `${current} ${piece}`
      else {
        lines.push(current)
        current = piece
      }
    }
  }
  if (current !== '') lines.push(current)
  if (lines.length <= maxLines) return lines
  const kept = lines.slice(0, maxLines)
  const last = kept[maxLines - 1] ?? ''
  kept[maxLines - 1] = `${last.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`
  return kept
}

const wrapBlock = (text: string, block: typeof TITLE) =>
  wrapText(text, Math.max(1, Math.floor(TEXT_WIDTH / (block.size * block.charWidth))), block.maxLines)

/** The text block as an SVG over the whole card, vertically centred. */
function textSvg(args: { title: string; line?: string; color: string }): Buffer {
  const { color } = args
  const titleLines = wrapBlock(args.title, TITLE)
  const lineLines = args.line ? wrapBlock(args.line, LINE) : []
  const height =
    titleLines.length * TITLE.lineHeight + (lineLines.length > 0 ? BLOCK_GAP + lineLines.length * LINE.lineHeight : 0)
  const top = (CARD_HEIGHT - height) / 2
  const lineTop = top + titleLines.length * TITLE.lineHeight + BLOCK_GAP

  const titleTexts = titleLines.map(
    (text, i) =>
      `<text x="${TEXT_X}" y="${top + i * TITLE.lineHeight + TITLE.size * ASCENT}" font-family="${FONT_FAMILY}" font-size="${TITLE.size}" font-weight="bold" fill="${color}">${escapeXml(text)}</text>`,
  )
  const lineTexts = lineLines.map(
    (text, i) =>
      `<text x="${TEXT_X}" y="${lineTop + i * LINE.lineHeight + LINE.size * ASCENT}" font-family="${FONT_FAMILY}" font-size="${LINE.size}" fill="${color}" fill-opacity="${LINE_OPACITY}">${escapeXml(text)}</text>`,
  )
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}">${[...titleTexts, ...lineTexts].join('')}</svg>`,
  )
}

/**
 * The social card (`og-image.png`, 1200x630): a solid background, the icon on the left and the title and line on the
 * right. The background is the explicit `background`, else a tile master's edge colour, else white; text is white on a
 * dark background and near-black on a light one. Text is SVG with system fonts: pure and free.
 */
export async function renderCard(args: {
  master: Buffer
  tile: TileInfo | null
  background?: string
  title: string
  line?: string
}): Promise<Buffer> {
  const { master, tile, background, title, line } = args
  const fill = background ? hexRgb(background) : (tile?.edgeColor ?? DEFAULT_BACKGROUND)
  const icon = tile
    ? await sharp(await tileCrop(master, tile))
        .resize(ICON_SIZE, ICON_SIZE)
        .png()
        .toBuffer()
    : await faviconIcon(master, ICON_SIZE)
  const color = luminance(fill) < LIGHT_BACKGROUND_LUMINANCE ? LIGHT_TEXT : DARK_TEXT
  return sharp({
    create: { width: CARD_WIDTH, height: CARD_HEIGHT, channels: 3, background: { r: fill[0], g: fill[1], b: fill[2] } },
  })
    .composite([
      { input: icon, left: MARGIN, top: Math.round((CARD_HEIGHT - ICON_SIZE) / 2) },
      { input: textSvg({ title, line, color }), left: 0, top: 0 },
    ])
    .png({ compressionLevel: 9 })
    .toBuffer()
}

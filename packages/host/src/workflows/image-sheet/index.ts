import { mkdirSync } from 'node:fs'
import { rename } from 'node:fs/promises'
import { join } from 'node:path'
import { defineWorkflow, WorkflowError } from '@agent-workflows/runtime'
import { type ArtifactOptions, artifactDir } from '../../artifacts.ts'
import type { HostWorkflow } from '../../operations.ts'
import { readImageSource } from '../image-source.ts'
import { decodeForSheet, type Ground, renderCell, renderSheet } from './render.ts'
import { ImageSheetInput, type ImageSheetInputValue, ImageSheetOutput, type ImageSheetOutputValue } from './schema.ts'

const IMAGE_SHEET_VERSION = '2026-11-20.1'

type Listed = ImageSheetOutputValue['sheets'][number]

/** One file through a temp file and a rename, so it is whole or absent. */
async function writeFile(path: string, bytes: Uint8Array): Promise<void> {
  const temp = `${path}.tmp`
  await Bun.write(temp, bytes)
  await rename(temp, path)
}

const grounds = (ground: ImageSheetInputValue['ground']): Ground[] => (ground === 'both' ? ['dark', 'light'] : [ground])

/** `--labels a,b,c`: one per file from the first, blank entries leave a cell with its number only; more labels than files is an error. */
export function parseLabels(labels: string | undefined, count: number): (string | undefined)[] {
  const parts = (labels ?? '').split(',').map((part) => part.trim() || undefined)
  if (labels !== undefined && parts.length > count) {
    throw new WorkflowError('invalid_input', `${parts.length} labels for ${count} files`)
  }
  return Array.from({ length: count }, (_, i) => parts[i])
}

const padded = (number: number): string => String(number).padStart(2, '0')

type Rendered = { sheets: Listed[]; cells: ImageSheetOutputValue['cells']; images: ImageSheetOutputValue['images'] }

/** Reads and decodes every image, renders each cell once per ground, writes the sheets (and the cells on request). */
async function renderAll(input: ImageSheetInputValue, dir: string): Promise<Rendered> {
  const labels = parseLabels(input.labels, input.files.length)
  const sources = await Promise.all(input.files.map((path) => readImageSource(path)))
  const decoded = await Promise.all(sources.map((source) => decodeForSheet(source)))
  const images = sources.map(({ kind }, i) => ({
    number: i + 1,
    file: input.files[i] ?? '',
    kind,
    ...(labels[i] ? { label: labels[i] } : {}),
  }))

  const sheets: Listed[] = []
  const cells: ImageSheetOutputValue['cells'] = []
  for (const ground of grounds(input.ground)) {
    const tiles = await Promise.all(
      decoded.map((png, i) => renderCell({ png, number: i + 1, label: labels[i], ground })),
    )
    const sheet = await renderSheet({ cells: tiles, cols: input.cols, ground })
    const name = `sheet-${ground}.png`
    await writeFile(join(dir, name), sheet.bytes)
    sheets.push({
      name,
      path: join(dir, name),
      mime: 'image/png',
      width: sheet.width,
      height: sheet.height,
      bytes: sheet.bytes.byteLength,
      ground,
    })
    if (!input.cells) continue
    for (const [i, tile] of tiles.entries()) {
      const cellName = `cell-${padded(i + 1)}-${ground}.png`
      await writeFile(join(dir, cellName), tile)
      cells.push({
        name: cellName,
        path: join(dir, cellName),
        mime: 'image/png',
        ...pngSize(tile),
        bytes: tile.byteLength,
        ground,
        number: i + 1,
        ...(labels[i] ? { label: labels[i] } : {}),
      })
    }
  }
  return { sheets, cells, images }
}

/** The pixel size a PNG states in its IHDR. */
const pngSize = (png: Buffer): { width: number; height: number } => ({
  width: png.readUInt32BE(16),
  height: png.readUInt32BE(20),
})

/**
 * `image-sheet`: a numbered contact sheet of up to 24 images, each cell the image at 320 px and again at 64, 32 and 16,
 * for choosing between logo candidates; `--cells` also writes each cell as its own picture. sharp and one bundled font
 * only: no model, no cost, and the same inputs give the same bytes. The command is `image-sheet`, a word of its own, so
 * it prefixes nothing and nothing prefixes it (see `image-icon`).
 */
export function createImageSheetWorkflows(options: { artifacts?: ArtifactOptions } = {}): HostWorkflow[] {
  const imageSheet = defineWorkflow({
    id: 'image-sheet',
    version: IMAGE_SHEET_VERSION,
    input: ImageSheetInput,
    output: ImageSheetOutput,
    async run(ctx, input: ImageSheetInputValue): Promise<ImageSheetOutputValue> {
      const started = Date.now()
      const dir = artifactDir('image-sheet', ctx.runId, options.artifacts)
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      const rendered = await ctx.step('render', () => renderAll(input, dir))
      return ImageSheetOutput.parse({ dir, ...rendered, latencyMs: Date.now() - started })
    },
  })

  return [
    {
      workflow: imageSheet,
      summary:
        'Make a numbered contact sheet png of 1 to 24 images (png, jpeg, webp, svg): each cell shows the image at 320 px and at 64, 32 and 16 px under a readable number (and --labels a,b,c), on a dark ground by default (--ground light|dark|both, --cols N); --cells also writes one png per cell. No model, no cost; the files are in the artifact store',
      cli: { positional: ['files'], defaultFormat: 'json' },
    },
  ]
}

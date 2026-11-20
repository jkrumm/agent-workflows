import { isAbsolute } from 'node:path'
import { z } from 'zod'

/** One sheet holds at most this many images: 24 cells at 320 px are already six rows of four. */
const MAX_IMAGES = 24

const absolute = z.string().min(1).refine(isAbsolute, 'every file must be an absolute path')

export const ImageSheetInput = z
  .object({
    files: z
      .array(absolute)
      .min(1)
      .max(MAX_IMAGES)
      .describe(
        'Absolute paths of the images on this host (png, jpeg, webp or svg; 1 to 24; at most 20 MiB each), numbered in this order from 1',
      ),
    labels: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Comma-separated labels printed after the numbers, in the order of the files: a,b,c; fewer than files is fine',
      ),
    ground: z
      .enum(['light', 'dark', 'both'])
      .default('dark')
      .describe('The ground the images sit on: dark (default), light, or both (one sheet each)'),
    cols: z.int().min(1).max(MAX_IMAGES).default(4).describe('Cells per row (default 4)'),
    cells: z
      .boolean()
      .default(false)
      .describe(
        'Also write one png per cell (number, large image and the three small sizes included), to show each option as its own picture',
      ),
  })
  .strict()
export type ImageSheetInputValue = z.output<typeof ImageSheetInput>

const SheetFile = z.object({
  name: z.string(),
  path: z.string().describe('Absolute path in the artifact store'),
  mime: z.literal('image/png'),
  width: z.int().positive(),
  height: z.int().positive(),
  bytes: z.int().positive(),
  ground: z.enum(['light', 'dark']),
})

export const ImageSheetOutput = z.object({
  dir: z.string().describe('The run directory in the artifact store; swept 30 days after its last change'),
  sheets: z.array(SheetFile).min(1).describe('One contact sheet per ground: dark, then light'),
  cells: z
    .array(SheetFile.extend({ number: z.int().positive(), label: z.string().optional() }))
    .describe('With --cells: one png per image and ground, in number order; otherwise empty'),
  images: z
    .array(
      z.object({
        number: z.int().positive().describe('The number printed on the cell'),
        file: z.string(),
        kind: z.enum(['png', 'jpeg', 'webp', 'svg']),
        label: z.string().optional(),
      }),
    )
    .describe('Which file each number is'),
  latencyMs: z.int().nonnegative(),
})
export type ImageSheetOutputValue = z.output<typeof ImageSheetOutput>

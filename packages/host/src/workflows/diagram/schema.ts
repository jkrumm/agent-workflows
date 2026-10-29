import { z } from 'zod'

export const MODES = ['create', 'extend'] as const

/** The largest `existing` accepted, in UTF-8 bytes: a hydrated element is about 1 KB, so room for some 400 elements. */
export const MAX_EXISTING_BYTES = 512 * 1024

export const DiagramInput = z
  .object({
    brief: z
      .string()
      .min(10)
      .describe(
        'The design brief: the subject, its depth (conceptual or technical), the visual pattern for each major concept ' +
          '(fan-out, convergence, timeline, ...), zone groupings and any evidence to include. Describe roles, not hex colours',
      ),
    mode: z
      .enum(MODES)
      .default('create')
      .describe('create: a fresh diagram. extend: change the diagram given as --existing'),
    existing: z
      .string()
      .min(2)
      .optional()
      .describe(
        'The current .excalidraw document as a string, for extend (`--existing "$(cat diagram.excalidraw)"`), at most 512 KB. ' +
          'The result is a new document; the caller writes the file. A larger file (embedded images) goes in without its ' +
          "`files` (`jq '.files={}'`), and the caller puts them back into the result",
      ),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.mode === 'extend' && input.existing === undefined)
      ctx.addIssue({ code: 'custom', path: ['existing'], message: 'extend needs --existing, the document to extend' })
    if (input.existing !== undefined && Buffer.byteLength(input.existing) > MAX_EXISTING_BYTES)
      ctx.addIssue({
        code: 'custom',
        path: ['existing'],
        message: `existing is over ${MAX_EXISTING_BYTES / 1024} KB; pass the document without its embedded images (\`files\`)`,
      })
    if (input.mode === 'create' && input.existing !== undefined)
      ctx.addIssue({ code: 'custom', path: ['existing'], message: 'create takes no --existing; use --mode extend' })
  })
export type DiagramInputValue = z.output<typeof DiagramInput>

export const Viewport = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
export type Viewport = z.output<typeof Viewport>

export const DiagramOutput = z.object({
  document: z
    .string()
    .describe(
      'The .excalidraw v2 document as JSON text: `agw diagram ... --format plain > diagram.excalidraw` writes it',
    ),
  elementCount: z.number().int().nonnegative(),
  viewport: Viewport.nullable().describe("The agent's camera hint (scene coordinates, 4:3), null when it gave none"),
  rationale: z.string().describe('One or two sentences on the design choices'),
})
export type DiagramOutputValue = z.output<typeof DiagramOutput>

/** What the agent answers: a rationale and the skeleton (`elements`), pseudo-elements included. */
export const Envelope = z.object({
  rationale: z.string().default(''),
  elements: z.array(z.record(z.string(), z.unknown())).min(1, 'elements is empty'),
})
export type Envelope = z.output<typeof Envelope>

/** One element of a hydrated document, as far as this workflow reads it. */
export type DocElement = {
  id: string
  type: string
  x: number
  y: number
  width: number
  height: number
  isDeleted?: boolean
  containerId?: string | null
  text?: string
  startBinding?: { elementId: string } | null
  endBinding?: { elementId: string } | null
  [key: string]: unknown
}

/** A hydrated document: the v2 `.excalidraw` envelope. */
export type ExcalidrawFile = {
  type: 'excalidraw'
  version: 2
  source: string
  elements: DocElement[]
  appState: Record<string, unknown>
  files: Record<string, unknown>
}

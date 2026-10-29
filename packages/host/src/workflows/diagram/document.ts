import { z } from 'zod'
import type { DocElement, ExcalidrawFile } from './schema.ts'

const Existing = z.object({
  type: z.literal('excalidraw'),
  version: z.literal(2),
  elements: z.array(z.looseObject({ id: z.string(), type: z.string() })),
  appState: z.record(z.string(), z.unknown()).default({}),
  files: z.record(z.string(), z.unknown()).default({}),
})

/** The caller's current document, or why it is not a v2 `.excalidraw` file. */
export function parseExisting(text: string): { ok: true; file: ExcalidrawFile } | { ok: false; error: string } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, error: '--existing is not JSON' }
  }
  const parsed = Existing.safeParse(raw)
  if (!parsed.success)
    return { ok: false, error: '--existing is not a v2 .excalidraw document (type, version, elements)' }
  const live = parsed.data.elements.filter((element) => element.isDeleted !== true)
  return {
    ok: true,
    file: {
      type: 'excalidraw',
      version: 2,
      source:
        typeof (raw as { source?: unknown }).source === 'string' ? String((raw as { source: string }).source) : '',
      elements: live as DocElement[],
      appState: parsed.data.appState,
      files: parsed.data.files,
    },
  }
}

/** Fields the agent needs to redraw or bind to an element; the rest of a hydrated element is noise to it. */
const VIEW_FIELDS = [
  'id',
  'type',
  'x',
  'y',
  'width',
  'height',
  'text',
  'fontSize',
  'strokeColor',
  'backgroundColor',
  'strokeStyle',
  'opacity',
  'points',
] as const

/**
 * The existing document as the agent reads it: one JSON line per drawn element, a bound label folded into its
 * container as `label` and an arrow's bindings as `start` / `end`. Far shorter than the hydrated file, and in the
 * skeleton's own vocabulary, so the agent re-emits what it keeps without the fields that corrupt a file.
 */
export function compactView(file: ExcalidrawFile): string {
  const labels = new Map<string, string>()
  for (const element of file.elements)
    if (element.type === 'text' && element.containerId && typeof element.text === 'string')
      labels.set(element.containerId, element.text)
  const lines: string[] = []
  for (const element of file.elements) {
    if (element.type === 'text' && element.containerId) continue
    const line: Record<string, unknown> = {}
    for (const field of VIEW_FIELDS) if (element[field] !== undefined) line[field] = element[field]
    const label = labels.get(element.id)
    if (label !== undefined) line.label = { text: label }
    if (element.startBinding) line.start = { id: element.startBinding.elementId }
    if (element.endBinding) line.end = { id: element.endBinding.elementId }
    lines.push(JSON.stringify(line))
  }
  return lines.join('\n')
}

/** The ids of the existing document's elements: what an extend skeleton may bind to or delete. */
export const existingIds = (file: ExcalidrawFile): Set<string> => new Set(file.elements.map((element) => element.id))

/**
 * The existing elements an extend keeps (`restoreCheckpoint`): all but the deleted ones and whatever hangs off them,
 * transitively: the text bound to a deleted container, an arrow attached to a deleted element, and then the label bound
 * to that arrow. They are converted together with the new skeleton so a new arrow can bind to them.
 */
export function keptElements(file: ExcalidrawFile, deletedIds: readonly string[]): DocElement[] {
  const gone = new Set(deletedIds)
  const hangsOff = (element: DocElement) =>
    (element.containerId && gone.has(element.containerId)) ||
    (element.startBinding && gone.has(element.startBinding.elementId)) ||
    (element.endBinding && gone.has(element.endBinding.elementId))
  let grew = true
  while (grew) {
    grew = false
    for (const element of file.elements)
      if (!gone.has(element.id) && hangsOff(element)) {
        gone.add(element.id)
        grew = true
      }
  }
  return file.elements.filter((element) => !gone.has(element.id))
}

const BINDABLE = new Set(['rectangle', 'ellipse', 'diamond'])

/**
 * The elements of `kept` that a new arrow binds to, as bare shapes (id and box only). The library binds an arrow only to
 * an element in the skeleton it converts, and converting a complete element again drops the bindings it already
 * had; so the new skeleton is converted with these stand-ins and {@link mergeExtension} swaps the real elements back in.
 */
export function bindingStubs(
  kept: readonly DocElement[],
  drawn: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  const wanted = new Set<string>()
  for (const item of drawn)
    for (const end of ['start', 'end'])
      if (item.type === 'arrow' && typeof (item[end] as { id?: unknown } | undefined)?.id === 'string')
        wanted.add((item[end] as { id: string }).id)
  const fresh = new Set(drawn.map((item) => item.id))
  return kept
    .filter((element) => wanted.has(element.id) && !fresh.has(element.id))
    .map((element) => ({
      type: BINDABLE.has(element.type) ? element.type : 'rectangle',
      id: element.id,
      x: element.x,
      y: element.y,
      width: element.width,
      height: element.height,
    }))
}

/**
 * The extended document's elements: the kept existing ones first (back), then the newly hydrated ones, with the stand-ins
 * removed. A kept element a new arrow bound to takes over the stand-in's `boundElements` (the new arrows), so old and new
 * arrows are all listed on it; entries whose element is gone (a deleted label or arrow) are pruned from every survivor.
 */
export function mergeExtension(
  kept: readonly DocElement[],
  hydrated: readonly DocElement[],
  stubIds: ReadonlySet<string>,
): DocElement[] {
  const stubs = new Map(hydrated.filter((element) => stubIds.has(element.id)).map((element) => [element.id, element]))
  const fresh = hydrated.filter((element) => !stubIds.has(element.id))
  const alive = new Set([...kept, ...fresh].map((element) => element.id))
  const merged = kept.map((element) => {
    const added = (stubs.get(element.id)?.boundElements as BoundRef[] | null | undefined) ?? []
    const current = (element.boundElements as BoundRef[] | null | undefined) ?? []
    // A deleted label or arrow leaves a dead entry on the survivor it was bound to: prune those.
    const bound = [...current, ...added].filter((ref) => alive.has(ref.id))
    return bound.length === current.length && added.length === 0 ? element : { ...element, boundElements: bound }
  })
  return [...merged, ...fresh]
}

type BoundRef = { id: string; type: string }

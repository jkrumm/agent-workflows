import type { DocElement, ExcalidrawFile } from './schema.ts'

/**
 * What the eval scores about a finished document, counted in code (`docs/research/2026-10-29-wave7-ports.md`
 * §diagram). An invalid document has no other metric: a failure counts in the valid rate and nowhere else, so it never
 * pulls a mean down. `boundArrowShare` is null for a diagram without arrows.
 */
export type DocumentMetrics =
  | { valid: false }
  | { valid: true; elementCount: number; boundArrowShare: number | null; overlaps: number; textOverflow: number }

const SHAPES = new Set(['rectangle', 'ellipse', 'diamond'])
/** Two boxes sharing less than this many pixels along an axis only touch. */
const EPSILON = 0.5

/** The document as the v2 envelope, or null: type, version 2, a non-empty elements array and an appState object. */
export function parseDocument(text: unknown): ExcalidrawFile | null {
  let raw: unknown
  try {
    raw = typeof text === 'string' ? JSON.parse(text) : text
  } catch {
    return null
  }
  const file = raw as Partial<ExcalidrawFile> | null
  if (!file || typeof file !== 'object') return null
  if (file.type !== 'excalidraw' || file.version !== 2) return null
  if (!Array.isArray(file.elements) || file.elements.length === 0) return null
  if (!file.appState || typeof file.appState !== 'object') return null
  const sound = file.elements.every(
    (e) =>
      e && typeof e.id === 'string' && ['x', 'y', 'width', 'height'].every((k) => Number.isFinite((e as never)[k])),
  )
  return sound ? (file as ExcalidrawFile) : null
}

type Box = { x1: number; y1: number; x2: number; y2: number }
const box = (e: DocElement): Box => ({ x1: e.x, y1: e.y, x2: e.x + e.width, y2: e.y + e.height })
const contains = (outer: Box, inner: Box) =>
  outer.x1 <= inner.x1 + EPSILON &&
  outer.y1 <= inner.y1 + EPSILON &&
  outer.x2 >= inner.x2 - EPSILON &&
  outer.y2 >= inner.y2 - EPSILON
const intersects = (a: Box, b: Box) =>
  Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1) > EPSILON && Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1) > EPSILON

/**
 * Shapes (rectangle, ellipse, diamond) whose boxes cross. A box that holds the other entirely is a container (a zone,
 * a frame around its nodes) and does not count. Text, arrows and lines are not shapes. Counted per pair.
 */
export function countOverlaps(elements: readonly DocElement[]): number {
  const items = elements.filter((e) => e.isDeleted !== true && SHAPES.has(e.type))
  let overlaps = 0
  for (let i = 0; i < items.length; i++)
    for (let j = i + 1; j < items.length; j++) {
      const a = box(items[i] as DocElement)
      const b = box(items[j] as DocElement)
      if (intersects(a, b) && !contains(a, b) && !contains(b, a)) overlaps++
    }
  return overlaps
}

/** Labels (text bound to a container) wider than the container they sit in, by the hydrated widths. */
export function countTextOverflow(elements: readonly DocElement[]): number {
  const live = elements.filter((e) => e.isDeleted !== true)
  const byId = new Map(live.map((e) => [e.id, e]))
  return live.filter((e) => {
    const container = e.type === 'text' && e.containerId ? byId.get(e.containerId) : undefined
    return container !== undefined && container.type !== 'arrow' && e.width > container.width + EPSILON
  }).length
}

/** Arrows whose two ends are both bound to an element that exists, over all arrows; null when there is no arrow. */
export function boundArrowShare(elements: readonly DocElement[]): number | null {
  const live = elements.filter((e) => e.isDeleted !== true)
  const ids = new Set(live.map((e) => e.id))
  const arrows = live.filter((e) => e.type === 'arrow')
  if (arrows.length === 0) return null
  const bound = arrows.filter(
    (a) => a.startBinding && a.endBinding && ids.has(a.startBinding.elementId) && ids.has(a.endBinding.elementId),
  )
  return bound.length / arrows.length
}

export function measureDocument(text: unknown): DocumentMetrics {
  const file = parseDocument(text)
  if (!file) return { valid: false }
  return {
    valid: true,
    elementCount: file.elements.filter((e) => e.isDeleted !== true).length,
    boundArrowShare: boundArrowShare(file.elements),
    overlaps: countOverlaps(file.elements),
    textOverflow: countTextOverflow(file.elements),
  }
}

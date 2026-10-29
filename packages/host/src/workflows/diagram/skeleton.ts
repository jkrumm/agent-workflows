import { parseJsonLoose } from '@agent-workflows/capabilities'
import { Envelope, type Viewport } from './schema.ts'

/** What the agent may draw; the pseudo-elements steer the host and are never drawn. */
const DRAWN = new Set(['rectangle', 'ellipse', 'diamond', 'text', 'arrow', 'line'])
const SHAPES = new Set(['rectangle', 'ellipse', 'diamond'])
const PSEUDO = new Set(['cameraUpdate', 'delete', 'restoreCheckpoint'])
/** Computed by hydration; an agent that writes them corrupts the file, so they are dropped from its elements. */
const COMPUTED = [
  'version',
  'versionNonce',
  'seed',
  'updated',
  'index',
  'isDeleted',
  'boundElements',
  'groupIds',
  'startBinding',
  'endBinding',
]
const MAX_ERRORS = 12

type Item = Record<string, unknown>

/** The skeleton once checked and split: what to draw, and what the pseudo-elements asked for. */
export type Prepared = {
  drawn: Item[]
  viewport: Viewport | null
  deletedIds: string[]
  restore: boolean
}

const isRecord = (value: unknown): value is Item => typeof value === 'object' && value !== null && !Array.isArray(value)
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const isText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''

/** The text as JSON of any shape (an object or the old bare array), unwrapped from one code fence; null when it is not. */
function parseWhole(text: string): unknown {
  const fence = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/)
  try {
    return JSON.parse((fence?.[1] ?? text).trim())
  } catch {
    return null
  }
}

/**
 * The envelope from the agent's text, or why it is not one. A bare array of elements (the old contract) is accepted as
 * an envelope without a rationale: the content is unambiguous.
 */
export function parseEnvelope(text: string): { ok: true; envelope: Envelope } | { ok: false; errors: string[] } {
  const raw = parseWhole(text) ?? parseJsonLoose(text)
  if (raw === null || raw === undefined) return { ok: false, errors: ['the answer is not JSON'] }
  const parsed = Envelope.safeParse(Array.isArray(raw) ? { elements: raw } : raw)
  if (parsed.success) return { ok: true, envelope: parsed.data }
  return {
    ok: false,
    errors: parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'answer'}: ${issue.message}`)
      .slice(0, MAX_ERRORS),
  }
}

function checkPseudo(item: Item, at: string, errors: string[]) {
  if (item.type === 'cameraUpdate') {
    for (const key of ['x', 'y', 'width', 'height'])
      if (!isNumber(item[key])) errors.push(`${at}: cameraUpdate needs a numeric ${key}`)
  }
  if (item.type === 'delete') {
    const ids = item.ids
    if (!(typeof ids === 'string' || (Array.isArray(ids) && ids.every((id) => typeof id === 'string'))))
      errors.push(`${at}: delete needs ids, a comma-separated string`)
  }
}

function checkDrawn(item: Item, at: string, ids: Set<string>, known: Set<string>, errors: string[]) {
  const type = String(item.type)
  if (!isNumber(item.x) || !isNumber(item.y)) errors.push(`${at}: ${type} needs numeric x and y`)
  if (SHAPES.has(type) && (!isNumber(item.width) || !isNumber(item.height)))
    errors.push(`${at}: ${type} needs numeric width and height`)
  if (type === 'text' && !isText(item.text)) errors.push(`${at}: text needs a non-empty text`)
  if (item.label !== undefined && !(isRecord(item.label) && isText(item.label.text)))
    errors.push(`${at}: label must be { "text": "..." }`)
  if (item.points !== undefined) {
    const points = item.points
    const valid =
      Array.isArray(points) &&
      points.length >= 2 &&
      points.every((p) => Array.isArray(p) && p.length === 2 && p.every(isNumber))
    if (!valid) errors.push(`${at}: points must be at least two [dx, dy] pairs`)
  }
  for (const end of ['start', 'end'] as const) {
    const bound = item[end]
    if (bound === undefined) continue
    const target = isRecord(bound) ? bound.id : undefined
    if (type !== 'arrow') errors.push(`${at}: only an arrow takes ${end}`)
    else if (typeof target !== 'string') errors.push(`${at}: ${end} must be { "id": "<element id>" }`)
    else if (!ids.has(target) && !known.has(target)) errors.push(`${at}: ${end}.id "${target}" matches no element`)
  }
}

/**
 * Checks the skeleton (a message per problem, for the re-ask) and splits it. `known` are the ids of the existing
 * document in extend mode, undefined in create mode. Only a skeleton that starts with `restoreCheckpoint` keeps the
 * existing elements: it alone may `delete` existing ids (which must exist) and bind new arrows to existing ids, and its
 * new elements must not reuse a kept id (rejected, the agent picks a new one); a deleted id may be drawn again. `restoreCheckpoint` in create mode
 * is an error.
 */
export function prepareSkeleton(
  elements: Item[],
  known?: ReadonlySet<string>,
): { ok: true; prepared: Prepared } | { ok: false; errors: string[] } {
  const errors: string[] = []
  const drawn: Item[] = []
  const ids = new Set<string>()
  let viewport: Viewport | null = null
  let restore = false
  const deleted = new Set<string>()
  for (const [index, item] of elements.entries()) {
    const at = `elements[${index}]`
    if (typeof item.type !== 'string') {
      errors.push(`${at}: missing type`)
      continue
    }
    if (PSEUDO.has(item.type)) {
      checkPseudo(item, at, errors)
      if (item.type === 'cameraUpdate' && isNumber(item.x) && isNumber(item.y))
        viewport = {
          x: item.x,
          y: item.y,
          width: isNumber(item.width) ? item.width : 0,
          height: isNumber(item.height) ? item.height : 0,
        }
      if (item.type === 'restoreCheckpoint') restore = true
      if (item.type === 'delete') {
        const list = Array.isArray(item.ids) ? item.ids : String(item.ids ?? '').split(',')
        for (const id of list) if (typeof id === 'string' && id.trim()) deleted.add(id.trim())
      }
      continue
    }
    if (!DRAWN.has(item.type)) {
      errors.push(`${at}: unknown type "${item.type}"`)
      continue
    }
    if (!isText(item.id)) {
      errors.push(`${at}: ${item.type} needs a string id`)
      continue
    }
    if (ids.has(item.id)) errors.push(`${at}: duplicate id "${item.id}"`)
    ids.add(item.id)
    drawn.push(Object.fromEntries(Object.entries(item).filter(([key]) => !COMPUTED.includes(key))))
  }
  if (drawn.length === 0 && errors.length === 0) errors.push('elements holds nothing to draw')
  // Only a restored checkpoint keeps the existing elements, so only then may a new arrow bind to one of them.
  if (restore && !known) errors.push('restoreCheckpoint needs extend mode: there is no existing diagram to keep')
  if (deleted.size > 0 && !restore) errors.push('delete acts on the existing diagram: begin with restoreCheckpoint')
  if (restore && known) {
    for (const id of deleted) if (!known.has(id)) errors.push(`delete: "${id}" is not an id of the existing diagram`)
    // A deleted id may be drawn again: delete and redraw under the same id is a plain edit.
    for (const item of drawn)
      if (known.has(String(item.id)) && !deleted.has(String(item.id)))
        errors.push(`${String(item.type)} "${String(item.id)}": the id exists in the existing diagram, use a new id`)
  }
  const bindable = restore && known ? new Set([...known].filter((id) => !deleted.has(id))) : new Set<string>()
  for (const item of drawn) checkDrawn(item, `${String(item.type)} "${String(item.id)}"`, ids, bindable, errors)
  if (errors.length > 0) return { ok: false, errors: errors.slice(0, MAX_ERRORS) }
  return { ok: true, prepared: { drawn, viewport, deletedIds: [...deleted], restore } }
}

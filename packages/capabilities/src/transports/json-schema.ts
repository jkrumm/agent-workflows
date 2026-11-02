import { z } from 'zod'

/** A JSON Schema document, as sent in a provider's structured-output parameter. */
export type JsonSchema = Record<string, unknown>

// Keywords that survive the conversion (Anthropic's documented subset, which the OpenAI strict subset contains).
const KEPT = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'anyOf',
  'description',
  'format',
  'minItems',
])
// Informational keywords nobody needs on the wire.
const IGNORED = new Set(['$schema', 'title', 'default', 'examples', 'id', '$id', 'readOnly', 'writeOnly', 'deprecated'])
// Constraints both providers reject (or only partly accept); the zod parse still enforces them, and the model is told in prose.
const NOTED = [
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'maxItems',
  'uniqueItems',
] as const
const STRING_FORMATS = new Set([
  'date-time',
  'time',
  'date',
  'duration',
  'email',
  'hostname',
  'uri',
  'ipv4',
  'ipv6',
  'uuid',
])

class Unsupported extends Error {}

// zod throws a plain `Error` for a type JSON Schema cannot hold (a transform, a Date, a custom type: "<x> cannot be
// represented in JSON Schema") and for a recursive one ("Cycle detected"); it has no error class to test for.
const ZOD_CANNOT_CONVERT = /cannot be represented in JSON Schema|^Cycle detected/

/**
 * The schema as structured-output parameters take it, or `null` when it cannot be expressed (a record, a
 * tuple, a recursive type, a transform, a root that is not an object; an intersection of objects is merged by zod and converts). A `null` means "ask for JSON
 * syntax only": the zod parse is the last check either way. The output shape is converted (`io: 'output'`), so a field
 * with a default is required.
 *
 * Dropped keywords (numeric and string bounds, `maxItems`, `pattern`, a `minItems` over 1, an unsupported `format`) are
 * folded into the property's `description`, because Anthropic answers 400 to some of them (`minimum`/`maximum` on an
 * integer, measured 2026-11-02) and the rest are outside its documented subset. Every object gets
 * `additionalProperties: false`, as both providers require.
 */
export function toJsonSchema(schema: z.ZodType): JsonSchema | null {
  try {
    const raw = z.toJSONSchema(schema, { io: 'output', unrepresentable: 'throw', cycles: 'throw', reused: 'inline' })
    const converted = convert(raw)
    return converted.type === 'object' ? converted : null
  } catch (error) {
    if (error instanceof Unsupported || (error instanceof Error && ZOD_CANNOT_CONVERT.test(error.message))) return null
    throw error
  }
}

function convert(node: unknown): JsonSchema {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) throw new Unsupported('not a schema object')
  const input = node as JsonSchema
  const out: JsonSchema = {}
  const notes: string[] = []
  for (const [key, value] of Object.entries(input)) {
    if (IGNORED.has(key) || (NOTED as readonly string[]).includes(key)) continue
    if (key === 'oneOf') continue // handled below
    if (!KEPT.has(key)) throw new Unsupported(`keyword ${key}`)
    out[key] = value
  }
  if (Array.isArray(input.oneOf)) {
    if (out.anyOf) throw new Unsupported('anyOf with oneOf')
    out.anyOf = input.oneOf
  }

  for (const key of NOTED) {
    const value = input[key]
    if (value === undefined || isSafeIntegerBound(input, key, value)) continue
    notes.push(`${key}: ${String(value)}`)
  }
  if (typeof out.format === 'string' && !STRING_FORMATS.has(out.format)) {
    notes.push(`format: ${out.format}`)
    delete out.format
  }
  if (typeof out.minItems === 'number' && out.minItems > 1) {
    notes.push(`minItems: ${out.minItems}`)
    delete out.minItems
  }

  if (out.type === 'object' || out.properties !== undefined) {
    // A record (`additionalProperties` is a schema) cannot be written in the subset.
    if (out.additionalProperties !== undefined && out.additionalProperties !== false) {
      throw new Unsupported('open object')
    }
    out.type = 'object'
    out.additionalProperties = false
    const properties = (out.properties ?? {}) as Record<string, unknown>
    out.properties = Object.fromEntries(Object.entries(properties).map(([name, child]) => [name, convert(child)]))
    out.required ??= []
  }
  if (out.items !== undefined) {
    if (Array.isArray(out.items)) throw new Unsupported('tuple')
    out.items = convert(out.items)
  }
  if (Array.isArray(out.anyOf)) out.anyOf = out.anyOf.map(convert)

  if (notes.length > 0) {
    const text = typeof out.description === 'string' ? out.description : ''
    out.description = `${text}${text ? ' ' : ''}(${notes.join(', ')})`
  }
  return out
}

/** zod's `z.int()` writes the safe-integer range as bounds; they say nothing the model needs. */
function isSafeIntegerBound(node: JsonSchema, key: string, value: unknown): boolean {
  return (
    (key === 'minimum' || key === 'maximum') &&
    (node.type === 'integer' || node.type === 'number') &&
    typeof value === 'number' &&
    Math.abs(value) >= Number.MAX_SAFE_INTEGER
  )
}

/**
 * True when OpenAI's strict mode accepts the schema as is: every object lists all of its properties as required (an
 * optional property is a 400 there, measured 2026-11-02). Anthropic has no such rule.
 */
export function isStrictCompatible(schema: JsonSchema): boolean {
  if (schema.type === 'object') {
    const properties = Object.keys(schema.properties ?? {})
    const required = new Set((schema.required ?? []) as string[])
    if (!properties.every((name) => required.has(name))) return false
    if (!Object.values((schema.properties ?? {}) as Record<string, JsonSchema>).every(isStrictCompatible)) return false
  }
  if (schema.items && !isStrictCompatible(schema.items as JsonSchema)) return false
  if (Array.isArray(schema.anyOf) && !(schema.anyOf as JsonSchema[]).every(isStrictCompatible)) return false
  return true
}

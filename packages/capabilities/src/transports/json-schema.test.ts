import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { isStrictCompatible, type JsonSchema, toJsonSchema } from './json-schema.ts'

// The converted schema's `properties`, for assertions (a `null` schema is a failed test, not a crash).
const props = (schema: JsonSchema | null) => (schema?.properties ?? {}) as Record<string, Record<string, unknown>>

describe('toJsonSchema', () => {
  test('an object becomes a closed object with every key required', () => {
    expect(toJsonSchema(z.object({ label: z.enum(['bug', 'feature']), reason: z.string() }))).toEqual({
      type: 'object',
      properties: { label: { type: 'string', enum: ['bug', 'feature'] }, reason: { type: 'string' } },
      required: ['label', 'reason'],
      additionalProperties: false,
    })
  })

  test('bounds are dropped (Anthropic answers 400 to minimum/maximum) and said in the description instead', () => {
    const schema = toJsonSchema(
      z.object({
        score: z.number().int().min(1).max(5).describe('How bad'),
        note: z.string().min(1).max(40),
        tags: z.array(z.string()).max(3),
      }),
    )
    const properties = props(schema)
    expect(properties.score).toEqual({ type: 'integer', description: 'How bad (minimum: 1, maximum: 5)' })
    expect(properties.note).toEqual({ type: 'string', description: '(minLength: 1, maxLength: 40)' })
    expect(properties.tags).toEqual({ type: 'array', items: { type: 'string' }, description: '(maxItems: 3)' })
    expect(JSON.stringify(schema)).not.toMatch(/"(minimum|maximum|minLength|maxLength|maxItems)":/)
  })

  test('z.int() safe-integer bounds are not worth a description', () => {
    const schema = toJsonSchema(z.object({ n: z.int() }))
    expect(props(schema).n).toEqual({ type: 'integer' })
  })

  test('pattern is folded into the description; minItems 0 and 1 stay, larger is noted', () => {
    const schema = toJsonSchema(
      z.object({
        id: z.string().regex(/^[a-z]+$/),
        one: z.array(z.string()).min(1),
        three: z.array(z.string()).min(3),
      }),
    )
    const properties = props(schema)
    expect(properties.id).toEqual({ type: 'string', description: '(pattern: ^[a-z]+$)' })
    expect(properties.one?.minItems).toBe(1)
    expect(properties.three?.minItems).toBeUndefined()
    expect(properties.three?.description).toBe('(minItems: 3)')
  })

  test('nested objects, arrays and unions are converted all the way down', () => {
    const schema = toJsonSchema(
      z.object({
        items: z.array(z.object({ when: z.string().nullable(), kind: z.union([z.literal('a'), z.literal('b')]) })),
      }),
    )
    const item = (props(schema).items?.items ?? {}) as JsonSchema
    expect(item.additionalProperties).toBe(false)
    expect(item.required).toEqual(['when', 'kind'])
    expect((item.properties as Record<string, unknown>).when).toEqual({ type: ['string', 'null'] })
  })

  test('an intersection of objects is merged by zod, and a union keeps its anyOf', () => {
    const merged = toJsonSchema(z.object({ a: z.string() }).and(z.object({ b: z.string() })))
    expect(merged?.required).toEqual(['a', 'b'])
    const union = toJsonSchema(z.object({ v: z.union([z.object({ a: z.string() }), z.object({ b: z.string() })]) }))
    const variants = props(union).v?.anyOf as Record<string, unknown>[] | undefined
    expect(variants?.map((variant) => variant.additionalProperties)).toEqual([false, false])
  })

  test('a field with a default is required in the output shape; defaults are not sent', () => {
    const schema = toJsonSchema(z.object({ flag: z.boolean().default(true) }))
    expect(schema?.required).toEqual(['flag'])
    expect(JSON.stringify(schema)).not.toContain('"default"')
  })

  test('an unsupported format is dropped, a supported one kept', () => {
    const schema = toJsonSchema(z.object({ at: z.iso.datetime(), cuid: z.string().cuid() }))
    const properties = props(schema)
    expect(properties.at?.format).toBe('date-time')
    expect(properties.cuid?.format).toBeUndefined()
  })

  test('a schema with no wire form is null: a record, a tuple, a transform, a recursive type, a non-object root', () => {
    expect(toJsonSchema(z.object({ m: z.record(z.string(), z.string()) }))).toBeNull()
    expect(toJsonSchema(z.object({ t: z.tuple([z.string(), z.number()]) }))).toBeNull()
    expect(toJsonSchema(z.object({ s: z.string().transform((s) => s.length) }))).toBeNull()
    type Tree = { children: Tree[] }
    const tree: z.ZodType<Tree> = z.object({ children: z.lazy(() => z.array(tree)) })
    expect(toJsonSchema(tree)).toBeNull()
    expect(toJsonSchema(z.array(z.string()))).toBeNull()
  })
})

describe('isStrictCompatible', () => {
  test('true when every object lists all its properties as required', () => {
    expect(isStrictCompatible(toJsonSchema(z.object({ a: z.string(), b: z.string().nullable() })) ?? {})).toBe(true)
  })

  test('false for an optional property, at any depth', () => {
    expect(isStrictCompatible(toJsonSchema(z.object({ a: z.string(), b: z.string().optional() })) ?? {})).toBe(false)
    const deep = z.object({ list: z.array(z.object({ x: z.string().optional() })) })
    expect(isStrictCompatible(toJsonSchema(deep) ?? {})).toBe(false)
    const nested = z.object({ inner: z.object({ x: z.string().optional() }) })
    expect(isStrictCompatible(toJsonSchema(nested) ?? {})).toBe(false)
  })
})

/**
 * A value that survives `JSON.stringify` → jsonb → `JSON.parse`, so a replayed step deep-equals the original.
 * jsonb does not keep object key order: never depend on the iteration order of a step output.
 */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

/**
 * Returns a description of the first value that would not replay equal (undefined, Date, bigint, NaN, a class
 * instance, a string jsonb rejects), or null.
 */
export function jsonViolation(value: unknown, path = '$'): string | null {
  if (value === null) return null
  switch (typeof value) {
    case 'string':
      return stringViolation(value, path)
    case 'boolean':
      return null
    case 'number':
      return Number.isFinite(value) ? null : `${path} is a non-finite number`
    case 'object':
      return Array.isArray(value) ? arrayViolation(value, path) : objectViolation(value, path)
    default:
      return `${path} is ${typeof value}`
  }
}

/** jsonb rejects NUL and lone UTF-16 surrogates; catch them here instead of as a journal (infra) error. */
function stringViolation(value: string, path: string): string | null {
  if (value.includes('\u0000')) return `${path} contains a NUL character (jsonb rejects it)`
  if (!value.isWellFormed()) return `${path} contains a lone UTF-16 surrogate (jsonb rejects it)`
  return null
}

function arrayViolation(value: unknown[], path: string): string | null {
  for (let i = 0; i < value.length; i++) {
    const found = jsonViolation(value[i], `${path}[${i}]`)
    if (found) return found
  }
  return null
}

function objectViolation(value: object, path: string): string | null {
  const proto: unknown = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) {
    const name = (value as { constructor?: { name?: string } }).constructor?.name ?? 'non-plain object'
    return `${path} is a ${name}`
  }
  for (const [key, entry] of Object.entries(value)) {
    const badKey = stringViolation(key, `${path} key`)
    if (badKey) return badKey
    const found = jsonViolation(entry, `${path}.${key}`)
    if (found) return found
  }
  return null
}

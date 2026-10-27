/** A value that survives `JSON.stringify` → jsonb → `JSON.parse` unchanged, so a replayed step equals the original. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

/** Returns a description of the first non-JSON value (undefined, Date, bigint, NaN, class instance), or null. */
export function jsonViolation(value: unknown, path = '$'): string | null {
  if (value === null) return null
  switch (typeof value) {
    case 'string':
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
    const found = jsonViolation(entry, `${path}.${key}`)
    if (found) return found
  }
  return null
}

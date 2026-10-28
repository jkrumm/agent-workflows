import { createHash } from 'node:crypto'

/** JSON with object keys sorted recursively and no whitespace; the same value always gives the same string. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v ?? null)).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export const CONTRACT_FIELD = 'x-contract-sha'

/** sha256 hex of the canonical JSON of the document with `info['x-contract-sha']` removed. */
export function contractSha(document: Record<string, unknown>): string {
  const { [CONTRACT_FIELD]: _removed, ...info } = (document.info ?? {}) as Record<string, unknown>
  return createHash('sha256')
    .update(canonicalJson({ ...document, info }))
    .digest('hex')
}

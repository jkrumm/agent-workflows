import { resolveModelAlias } from './pricing.ts'
import { DEFAULT_ROUTES } from './registry.ts'
import { CLAUDE_RATES, CLAUDE_SNAPSHOT_ID } from './table/claude.ts'

/**
 * `<provider>/<model>` or `<provider>.<model>`, the provider one segment; group 1 is the model. The one prefix regex of
 * this package: `callerRecords` and `canonicalModel` both read an echo with it, and the gateway's own `rowModel` reads
 * the same shape. It matches inside ids too (`<name>-3.8` splits at the dot), so a remainder counts only when it is a
 * table model.
 */
export const PROVIDER_ECHO = /^[A-Za-z0-9_-]+[/.](.+)$/

/** A snapshot date a provider appends to any family's id (`<id>-2026-09-22`); the Claude form (`-20261001`) is `CLAUDE_SNAPSHOT_ID`. */
const DATE_SNAPSHOT = /-[0-9]{4}-[0-9]{2}-[0-9]{2}$/

/** Every model id the table names: each route's model, each fallback's, and the Claude models. */
export const TABLE_MODELS: ReadonlySet<string> = new Set([
  ...Object.values(DEFAULT_ROUTES).flatMap((route) => [route.model, ...(route.fallback ? [route.fallback.model] : [])]),
  ...Object.keys(CLAUDE_RATES),
])

/**
 * The one id a model is recorded under, whatever a provider echoed back. An echo collapses only onto a model the table
 * names: the candidates are tried in order and the first table model wins, else the raw id comes back untouched.
 * Candidates: the raw id (so a table id is never cut, `<owner>/<name>` ones included); the provider prefix stripped
 * (`openai.<id>`, `vertex_ai_eu/<id>`); the trailing `-YYYY-MM-DD` snapshot date stripped (any family); both; each of
 * those with a Claude snapshot date and `[1m]` removed; then a Claude alias (`sonnet`) resolved. An unknown id, with or
 * without an owner prefix or a date, is never rewritten, so `alice/<id>` and `bob/<id>` stay apart.
 */
export function canonicalModel(raw: string): string {
  const unprefixed = PROVIDER_ECHO.exec(raw)?.[1]
  const bases = unprefixed === undefined ? [raw] : [raw, unprefixed]
  const candidates = bases.flatMap((base) => {
    const dated = base.replace(DATE_SNAPSHOT, '')
    return [base, dated, base.replace(CLAUDE_SNAPSHOT_ID, '$1'), dated.replace(CLAUDE_SNAPSHOT_ID, '$1')]
  })
  const found = [...candidates, ...candidates.map(resolveModelAlias)].find((candidate) => TABLE_MODELS.has(candidate))
  return found ?? raw
}

import { resolveModelAlias } from './pricing.ts'
import { DEFAULT_ROUTES } from './registry.ts'
import { CLAUDE_RATES, CLAUDE_SNAPSHOT_ID } from './table/claude.ts'

/** `<provider>/<model>` or `<provider>.<model>`, the provider one segment; the gateway's `rowModel` reads it the same way. */
export const PROVIDER_ECHO = /^[A-Za-z0-9_-]+[/.](.+)$/

/**
 * The provider prefix of an echo that is not a model by itself. After `/` the segment is any one-segment token; after
 * `.` it is letters and underscores only (`openai.`, `vertex_ai_eu/`), because a dot also sits inside ids (`<name>-3.8`)
 * and `<name>-3` is not a provider.
 */
const PROVIDER_SEGMENT = /^(?:[A-Za-z0-9_-]+\/|[A-Za-z_]+\.)(.+)$/

/** A snapshot date a provider appends to any family's id (`<id>-2026-09-22`); the Claude form (`-20261001`) is `CLAUDE_SNAPSHOT_ID`. */
const DATE_SNAPSHOT = /-[0-9]{4}-[0-9]{2}-[0-9]{2}$/

let tableModels: ReadonlySet<string> | undefined

/** Every model id the table names, a route's fallback and the Claude models included. */
function isTableModel(model: string): boolean {
  tableModels ??= new Set([
    ...Object.values(DEFAULT_ROUTES).flatMap((route) => [
      route.model,
      ...(route.fallback ? [route.fallback.model] : []),
    ]),
    ...Object.keys(CLAUDE_RATES),
  ])
  return tableModels.has(model)
}

/**
 * The one id a model is recorded under, whatever a provider echoed back. A model the table names comes back as is
 * (`<owner>/<name>` ids are table models, not an echo). Otherwise: a one-segment provider prefix goes (`openai.<id>`,
 * `vertex_ai_eu/<id>`), then a trailing `-YYYY-MM-DD` snapshot date of any family, a Claude snapshot date and the `[1m]` flag, then a Claude alias
 * (`sonnet`) resolves to its id. Anything else, case included, comes back untouched.
 */
export function canonicalModel(raw: string): string {
  if (isTableModel(raw)) return raw
  const stripped = PROVIDER_SEGMENT.exec(raw)?.[1] ?? raw
  return resolveModelAlias(stripped.replace(DATE_SNAPSHOT, '').replace(CLAUDE_SNAPSHOT_ID, '$1'))
}

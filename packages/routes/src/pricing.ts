// The leaf of this package for a process that bundles to one file (`@agent-workflows/routes/pricing`): what prices and
// classifies a call, with no route table. The package's index runs `discoverRoutes()` at import, a glob and dynamic
// import of `src/table/` next to the source file, so nothing here may import `index.ts` or `registry.ts`.
import { CLAUDE_ALIASES, CLAUDE_RATES, CLAUDE_SNAPSHOT_ID, type ClaudeRate } from './table/claude.ts'

export { BALANCE_MARKER, isBalanceFailure } from './balance.ts'
export { costFromUsage, type ProviderUsage } from './cost.ts'
export type { ClaudeRate }

/** Every Claude model id the table prices (read-only). */
export const CLAUDE_MODELS: readonly string[] = Object.freeze(Object.keys(CLAUDE_RATES))

/**
 * An alias (`haiku`, `sonnet`, `opus`: exact, case-sensitive) to the id of the current model of that tier; anything
 * else, including a concrete id, comes back untouched.
 */
export function resolveModelAlias(model: string): string {
  return (Object.hasOwn(CLAUDE_ALIASES, model) ? CLAUDE_ALIASES[model] : undefined) ?? model
}

/**
 * The rate of a Claude model by alias, concrete id, or dated snapshot / `[1m]` form of one (`CLAUDE_SNAPSHOT_ID`);
 * `undefined` for any other model. The shared, deeply frozen object: do not mutate it. The gateway prices an
 * Anthropic response with `costFromUsage('anthropic', usage, claudeRate(model))`.
 */
export function claudeRate(model: string): ClaudeRate | undefined {
  const id = resolveModelAlias(model).replace(CLAUDE_SNAPSHOT_ID, '$1')
  return Object.hasOwn(CLAUDE_RATES, id) ? CLAUDE_RATES[id] : undefined
}

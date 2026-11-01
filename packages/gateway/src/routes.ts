// The slice of `@agent-workflows/routes` the gateway uses, by relative path to its leaf modules. The package's index
// runs `discoverRoutes()` at import, a glob and dynamic import of `src/table/` next to the source file, which cannot
// work in the single-file bundle production runs. `resolveModelAlias` and `claudeRate` are the two wrappers of
// packages/routes/src/index.ts, kept equal by test/routes.test.ts. A leaf `./claude` export on that package replaces this.
import { BALANCE_MARKER, isBalanceFailure } from '../../routes/src/balance.ts'
import { costFromUsage, type ProviderUsage } from '../../routes/src/cost.ts'
import { CLAUDE_ALIASES, CLAUDE_RATES, CLAUDE_SNAPSHOT_ID, type ClaudeRate } from '../../routes/src/table/claude.ts'

export { BALANCE_MARKER, costFromUsage, isBalanceFailure, type ProviderUsage }

export function resolveModelAlias(model: string): string {
  return (Object.hasOwn(CLAUDE_ALIASES, model) ? CLAUDE_ALIASES[model] : undefined) ?? model
}

export function claudeRate(model: string): ClaudeRate | undefined {
  const id = resolveModelAlias(model).replace(CLAUDE_SNAPSHOT_ID, '$1')
  return Object.hasOwn(CLAUDE_RATES, id) ? CLAUDE_RATES[id] : undefined
}

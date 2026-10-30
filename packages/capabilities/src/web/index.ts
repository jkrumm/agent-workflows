import { createDocs } from './docs.ts'
import { createFetch } from './fetch.ts'
import { createPackage } from './package.ts'
import { createSearch } from './search.ts'
import { createYoutube } from './youtube.ts'
import { resolveWebDeps, type WebDeps } from './deps.ts'

export type { WebDeps } from './deps.ts'
export { BLOCK_REASONS, type BlockReason, blockedReason } from './fetch.ts'
export { TAVILY_USD_PER_CREDIT } from './search.ts'

/** The research tools as capabilities: `web.search`, `web.fetch`, `web.docs`, `web.package`, `web.youtube`. */
export function createWebCapabilities(deps: WebDeps = {}) {
  const resolved = resolveWebDeps(deps)
  return [
    createSearch(resolved),
    createFetch(resolved),
    createDocs(resolved),
    createPackage(resolved),
    createYoutube(resolved),
  ] as const
}

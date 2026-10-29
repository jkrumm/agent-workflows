import { type BrainDeps } from './vault.ts'
import { createRead } from './read.ts'
import { createSearch } from './search.ts'

export type { BrainDeps } from './vault.ts'

/** The vault tools as capabilities: `brain.search` and `brain.read`, read-only over `AGW_BRAIN_DIR`. */
export function createBrainCapabilities(deps: BrainDeps = {}) {
  return [createSearch(deps), createRead(deps)] as const
}

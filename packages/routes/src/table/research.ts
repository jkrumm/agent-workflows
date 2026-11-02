import type { RouteEntry } from '../schema.ts'
import { EASY } from './_shared.ts'

const routes = {
  // Research agent (concept P3): a long-read session. DeepSeek flash until Wave 6, then the HARD tier (Sonnet); owner
  // decision 2026-11-03: the EASY tier (Haiku high), for cost while the credit runs dry, accepting the measured
  // `supported` gap (docs/evals/2026-11-02-claude-seats.md).
  'research.agent': { wire: 'opencode', ...EASY.agent },
} satisfies Record<string, RouteEntry>

export default routes

declare module '../schema.ts' {
  interface RouteTable extends Record<keyof typeof routes, true> {}
}

import type { RouteEntry } from '../schema.ts'
import { EASY } from './_shared.ts'

const routes = {
  // Otel agent (concept N7): one session querying HyperDX through the tool gate. DeepSeek flash until Wave 6, then the
  // HARD tier (Sonnet); owner decision 2026-11-02 18:10: the EASY tier (Haiku high), which tied Sonnet on every score, at
  // a sixth of the cost, while production is over the credit pace (docs/evals/2026-11-02-claude-seats.md).
  'otel.agent': { wire: 'opencode', ...EASY.agent },
} satisfies Record<string, RouteEntry>

export default routes

declare module '../schema.ts' {
  interface RouteTable extends Record<keyof typeof routes, true> {}
}
